// One remote owner keeps the SDK and its input stream alive across turns.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { ChatService } = require('./chat-service.cjs');
const { Transcript } = require('./transcript.cjs');
const { catalogue, preferencePatch } = require('./capabilities.cjs');
const { SessionInput } = require('./session-input.cjs');
const folder = process.argv[2];
const request = JSON.parse(fs.readFileSync(path.join(folder, 'request.json'), 'utf8'));
const session = request.session;
session.permissions = [];
let version = 0, ended = false;
function atomic(filename, value) {
  fs.writeFileSync(filename + '.tmp', JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(filename + '.tmp', filename);
}
function snapshot() {
  atomic(path.join(folder, 'state.json'), { version: ++version, done: ended, resident: true,
    status: session.status, permissions: session.permissions, message: session.messages.at(-1),
    remoteSessionId: session.remoteSessionId, model: session.model, preferences: session.preferences,
    capabilities: session.capabilities, tools: session.tools, plugins: session.plugins,
    terminalCommands: session.terminalCommands, usage: session.usage, tasks: session.tasks, forkPending: session.forkPending });
}
const service = new ChatService({ load: () => [session], save: snapshot });
service.closing = true;
service.spawn = (_session, options, onError) => {
  const child = spawn('claude', options.args, { cwd: session.directory, stdio: ['pipe', 'pipe', 'pipe'], signal: options.signal });
  child.stderr.setEncoding('utf8'); child.stderr.on('data', onError); return child;
};
const input = new SessionInput();
const run = { stopped: false, stderr: '', message: session.messages.at(-1) };
run.transcript = new Transcript(run.message);
service.runs.set(session.id, run);
let query, handling = false;
async function control(command) {
  if (command.kind === 'send') {
    if (run.message.id === command.message.id) return {}; // Replay after an uncertain transport ACK.
    if (service.runs.has(session.id)) throw new Error('远端会话正在回复');
    session.messages = [command.message];
    Object.assign(run, { message: command.message, stopped: false, stderr: '', transcript: new Transcript(command.message) });
    service.runs.set(session.id, run); session.status = 'working'; snapshot();
    input.push(command.prompt, command.message.id, session.remoteSessionId);
    return {};
  }
  if (command.kind === 'stop') {
    if (service.runs.has(session.id)) {
      run.stopped = true; session.status = 'stopping'; snapshot();
      for (const permission of [...session.permissions]) service.respond(session.id, permission.id, { allow: false });
      await query.interrupt();
    }
    return {};
  }
  if (command.kind === 'respond') {
    if (service.approvals.has(command.permissionId)) service.respond(session.id, command.permissionId, command.answer);
    return {};
  }
  if (command.kind === 'control') {
    const methods = {
      model: async () => { await query.setModel(command.value || undefined); session.preferences.selectedModel = command.value; },
      effort: async () => { await query.applyFlagSettings({ effortLevel: command.value || null }); session.preferences.effort = command.value; },
      permission: async () => { await query.setPermissionMode(command.value); session.preferences.permissionMode = command.value; },
      configure: async () => {
        const patch = preferencePatch(command.value);
        for (const [key, value] of Object.entries(patch)) {
          if (key === 'selectedModel') await query.setModel(value || undefined);
          else if (key === 'permissionMode') await query.setPermissionMode(value);
          else if (['effort', 'fastMode', 'outputStyle'].includes(key)) await query.applyFlagSettings({ [key === 'effort' ? 'effortLevel' : key]: value === '' ? null : value });
          else throw new Error('此设置需要重新打开会话');
          session.preferences[key] = value; snapshot();
        }
        return session.preferences;
      },
      catalogue: async () => { session.capabilities = await catalogue(query); return session.capabilities; },
      context: () => query.getContextUsage({ detail: 'summary' }),
      mcp: () => query.mcpServerStatus(),
      plugins: () => query.reloadPlugins({ holdOnCacheImpact: true }),
    };
    if (!methods[command.action]) throw new Error('未知会话控制操作');
    const result = await methods[command.action]();
    snapshot(); return result || {};
  }
  if (command.kind === 'close') { input.close(); query.close(); return {}; }
  throw new Error('未知会话请求');
}
let rerun = false;
async function commands() {
  if (!query) return;
  if (handling) { rerun = true; return; }
  handling = true;
  try {
    for (const name of fs.readdirSync(path.join(folder, 'commands')).sort()) {
      if (!name.endsWith('.json')) continue;
      const filename = path.join(folder, 'commands', name);
      // A bad command must never block later answers or stop requests.
      if (!fs.existsSync(filename + '.result')) {
        let result;
        try { result = { ok: true, value: await control(JSON.parse(fs.readFileSync(filename, 'utf8'))) }; }
        catch (error) { result = { ok: false, error: error.message }; }
        atomic(filename + '.result', result);
      }
      fs.renameSync(filename, filename + '.done');
    }
  } finally { handling = false; }
  if (rerun) { rerun = false; return commands(); }
}
session.preferences ||= {};
snapshot();
const runCommands = () => commands().catch(error => console.error(error.message));
// fs.watch makes stop and approvals immediate; the interval covers filesystems without inotify.
const timer = setInterval(runCommands, 1000);
let commandWatcher;
try { commandWatcher = fs.watch(path.join(folder, 'commands'), runCommands); commandWatcher.on('error', () => {}); } catch { /* Interval only. */ }
(async () => {
  const { query: createQuery } = await import(pathToFileURL(path.join(__dirname, 'sdk.mjs')).href);
  query = createQuery({ prompt: input, options: service.options(session, run) }); run.query = query;
  input.push(request.prompt, run.message.id, session.remoteSessionId);
  session.capabilities = await catalogue(query); snapshot();
  for await (const event of query) {
    if (service.runs.has(session.id)) {
      service.consumeEvent(session, event, run);
      if (event.type === 'result') service.finish(session, run, true);
    } else if (event.type === 'system' && event.subtype === 'commands_changed') {
      session.capabilities.commands = event.commands; snapshot();
    }
  }
})().catch(error => {
  run.message.error = [error.message, run.stderr].filter(Boolean).join('\n');
  session.status = 'error';
}).finally(() => {
  ended = true; clearInterval(timer); commandWatcher?.close(); input.close(); query?.close();
  if (service.runs.has(session.id)) service.finish(session, run, true);
  for (const pending of service.timers.values()) clearTimeout(pending);
  snapshot();
});
