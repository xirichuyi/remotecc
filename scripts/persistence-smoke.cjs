const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { SSHConnections } = require('../src/ssh.cjs');
const { RemoteFiles } = require('../src/files.cjs');
const { PersistentTasks } = require('../src/persistent-tasks.cjs');
const { ChatService } = require('../src/chat-service.cjs');
const { ChatStore } = require('../src/store.cjs');
const { shellQuote } = require('../src/remote.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 120000) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) throw new Error('Timed out'); await pause(200); }
}
(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'remotecc-persist-'));
  const config = { host: 'axi', directory: '/tmp' };
  let ssh, service, id, taskId;
  const store = new ChatStore(path.join(profile, 'chats.json'));
  async function client() {
    ssh = new SSHConnections(); await ssh.connect(config);
    service = new ChatService(store); service.persistent = new PersistentTasks(ssh, service);
    ssh.on('recovered', async config => {
      try { await service.persistent.detach(config); await service.persistent.restore(config); }
      catch (error) { console.error(error); }
    });
  }
  try {
    await client();
    const session = service.create(config); id = session.id;
    service.configure(id, { selectedModel: 'sonnet', effort: 'low' });
    const token = 'PERSIST-' + randomUUID();
    service.send(id, `First use AskUserQuestion to ask whether to continue, with options Continue and Cancel. Wait for the answer. Then use Bash to run exactly: sleep 18; printf '${token}'. After it finishes reply with the token.`);
    taskId = session.remoteTask.id;
    await until(() => session.permissions.length || session.status === 'error' || session.status === 'detached' || session.status === 'idle');
    assert.equal(session.status, 'permission', JSON.stringify(session));
    const permission = session.permissions[0]; taskId = session.remoteTask.id;
    assert.equal(permission.name, 'AskUserQuestion');
    const entry = [...ssh.connections.values()][0];
    execFileSync('/usr/bin/ssh', ['-S', entry.socket, '-O', 'exit', config.host], {stdio:'pipe'});
    await ssh.checkMaster(entry);
    await until(() => session.status === 'detached');
    await until(() => ssh.state(config).status === 'connected' && session.status === 'permission');
    assert.equal(session.remoteTask.id, taskId);
    assert.equal(session.permissions[0].id, permission.id);
    await service.close(); await ssh.close();
    await pause(1500);
    await client(); await service.persistent.restore(config);
    await until(() => service.get(id).permissions.length);
    assert.equal(service.get(id).permissions[0].id, permission.id);
    assert.equal(service.get(id).remoteTask.id, taskId);
    await service.respond(id, permission.id, { allow: true, answers: Object.fromEntries(permission.input.questions.map(question => [question.question, 'Continue'])) });
    await until(() => service.get(id).status === 'working');
    await service.close(); await ssh.close();
    // No client or SSH connection exists while the tool and Claude complete.
    await pause(22000);
    await client(); await service.persistent.restore(config);
    await until(() => !service.get(id).remoteTask);
    const restored = service.get(id);
    assert.equal(restored.status, 'idle', JSON.stringify(restored.messages.at(-1)));
    assert.ok(restored.messages.at(-1).blocks.some(block => block.type === 'text' && block.text.includes(token)));
    assert.equal(restored.messages.filter(message => message.role === 'user').length, 1);
    assert.equal(restored.messages.filter(message => message.role === 'assistant').length, 1);
    console.log('PASS: automatic SSH recovery retains task/approval IDs; pending permission survives client shutdown; approval resumes same task; Claude finishes without SSH; restart restores exact result without duplicate messages');
  } finally {
    if (service?.get(id)?.remoteTask && ssh?.state(config).status === 'connected') {
      await service.stop(id).catch(() => {}); await pause(1000);
    }
    if (taskId && ssh?.state(config).status === 'connected') {
      const remoteId = service.get(id).remoteSessionId;
      const child = ssh.spawn(config, 'python3 -c ' + shellQuote('import os,shutil,glob; shutil.rmtree(os.path.expanduser("~/.local/state/remotecc/tasks/' + taskId + '"),ignore_errors=True)\n' + (remoteId ? 'for p in glob.glob(os.path.expanduser("~/.claude/projects/*/' + remoteId + '.jsonl")): os.unlink(p)' : '')));
      child.stdin.end(); await new Promise(resolve => child.on('close', resolve));
    }
    await service?.close(); await ssh?.close(); fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
