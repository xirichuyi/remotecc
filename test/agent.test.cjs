// Drives the real agent as a child process; `sh -c` stands in for the SSH channel.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { gzipSync } = require('node:zlib');
const { AgentClient } = require('../src/agent-client.cjs');
const { RemoteFiles } = require('../src/files.cjs');

const config = { host: 'test', directory: '~' };
function fixture(extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-agent-'));
  const spawned = [];
  const connections = {
    spawn(_config, command) {
      spawned.push(command);
      const child = spawn('sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HOME: home, ...extraEnv } });
      return child;
    },
  };
  const client = new AgentClient(connections);
  const close = () => { client.close(config); fs.rmSync(home, { recursive: true, force: true }); };
  return { home, client, connections, spawned, close };
}
const until = async (predicate, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('timed out'); await new Promise(done => setTimeout(done, 20)); }
};

test('agent installs itself once, ignores login-shell noise, and multiplexes requests on one channel', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.home, '.profile'), 'echo "welcome to the server"\n');
    fs.writeFileSync(path.join(f.home, 'note.txt'), 'hello');
    fs.mkdirSync(path.join(f.home, '.hidden'));
    const info = await f.client.info(config);
    assert.equal(info.home, f.home); assert.equal(info.nodeSupported, true);
    const launches = () => f.spawned.filter(command => command.includes('exec node')).length;
    const before = launches();
    const results = await Promise.all(Array.from({ length: 20 }, () => f.client.call(config, 'file', { operation: 'list', base: '~', path: '~', hidden: true })));
    assert.equal(launches(), before);
    assert.deepEqual(results[0].entries.map(entry => entry.name), ['.hidden', '.local', '.profile', 'note.txt']);
    await assert.rejects(f.client.call(config, 'file', { operation: 'list', path: '/definitely/missing' }), /ENOENT/);
  } finally { f.close(); }
});

test('a missing node is reported in words instead of a broken pipe', async () => {
  const f = fixture({ PATH: '/usr/bin:/bin' });
  try {
    if (fs.existsSync('/usr/bin/node') || fs.existsSync('/usr/local/bin/node') || fs.existsSync('/bin/node')) return;
    await assert.rejects(f.client.info(config), /未找到 Node\.js/);
  } finally { f.close(); }
});

test('files: upload never overwrites, download is byte-exact, edits detect concurrent changes', async () => {
  const f = fixture();
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-local-'));
  try {
    const session = { ...config, id: 's' };
    const files = new RemoteFiles(f.connections, () => {}, path.join(local, 'cache'));
    // The client under test uses the shared per-connections agent, not fixture.client.
    const payload = Buffer.from(Array.from({ length: 300000 }, (_, index) => index % 251));
    const source = path.join(local, 'data.bin');
    fs.writeFileSync(source, payload);
    const attachment = await files.upload(session, source, f.home);
    assert.equal(attachment.path, path.join(f.home, 'data.bin'));
    await assert.rejects(files.upload(session, source, f.home), /同名/);
    assert.deepEqual(fs.readdirSync(f.home).filter(name => name.startsWith('.remotecc-')), []);
    const destination = path.join(local, 'copy.bin');
    await files.download(session, attachment.path, destination);
    assert.ok(fs.readFileSync(destination).equals(payload));

    const text = path.join(f.home, 'edit.txt');
    fs.writeFileSync(text, 'one\n');
    const opened = await files.preview(session, text);
    assert.equal(opened.kind, 'text');
    const saved = await files.save(session, text, 'two\n', opened.revision);
    assert.equal(saved.text, 'two\n'); assert.equal(fs.readFileSync(text, 'utf8'), 'two\n');
    fs.writeFileSync(text, 'changed elsewhere\n');
    await assert.rejects(files.save(session, text, 'three\n', saved.revision), /已变化/);
    assert.equal(fs.readFileSync(text, 'utf8'), 'changed elsewhere\n');
    const png = path.join(f.home, 'a.png');
    fs.writeFileSync(png, Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(64, 7)]));
    const image = await files.preview(session, png);
    assert.equal(image.kind, 'image'); assert.equal(image.data.length, 72);
  } finally { fs.rmSync(local, { recursive: true, force: true }); require('../src/agent-client.cjs').agentFor(f.connections).close(config); f.close(); }
});

test('directory watches push changes without polling', async () => {
  const f = fixture();
  try {
    const seen = [];
    f.client.on('fs', event => seen.push(...event.directories));
    const directory = path.join(f.home, 'project');
    fs.mkdirSync(directory);
    assert.deepEqual((await f.client.call(config, 'watchDirectories', { directories: [directory, '/definitely/missing'] })).failed, ['/definitely/missing']);
    fs.writeFileSync(path.join(directory, 'made-by-claude.txt'), 'x');
    await until(() => seen.includes(directory));
    seen.length = 0;
    fs.writeFileSync(path.join(directory, '.remotecc-upload-abc'), 'x');
    await new Promise(done => setTimeout(done, 300));
    assert.deepEqual(seen, []);
  } finally { f.close(); }
});

function workerBundle(source) {
  const data = Buffer.from(JSON.stringify({ 'task-worker.cjs': source }));
  return { digest: createHash('sha256').update(data).digest('hex'), payload: gzipSync(data).toString('base64') };
}
const startRequest = (taskId, digest) => ({ operation: 'start', taskId, digest, request: { session: { directory: '~', messages: [{ id: 'reply', role: 'assistant', blocks: [] }] }, prompt: 'hi' } });

test('task: starts once, streams deltas, answers commands immediately, survives the channel closing', async () => {
  const f = fixture();
  try {
    // A stand-in worker: state.json protocol is what the agent depends on, not the SDK.
    const bundle = workerBundle(`
      const fs=require('fs'),path=require('path');const folder=process.argv[2];let version=0;
      const write=(status,text,done=false)=>{fs.writeFileSync(path.join(folder,'state.json.tmp'),JSON.stringify({version:++version,done,resident:true,status,permissions:[],message:{id:'reply',blocks:[{type:'text',text}]}}));fs.renameSync(path.join(folder,'state.json.tmp'),path.join(folder,'state.json'));};
      fs.appendFileSync(path.join(folder,'runs'),'x');write('working','he');setTimeout(()=>write('working','hello'),50);
      setInterval(()=>{for(const name of fs.readdirSync(path.join(folder,'commands'))){if(!name.endsWith('.json'))continue;const file=path.join(folder,'commands',name);const c=JSON.parse(fs.readFileSync(file));fs.writeFileSync(file+'.result',JSON.stringify({ok:true,value:c.value}));fs.renameSync(file,file+'.done');if(c.value==='finish')write('idle','hello world',true);}},20);
    `);
    assert.deepEqual(await f.client.call(config, 'task', { operation: 'installed', digest: bundle.digest }), { installed: false });
    await f.client.call(config, 'task', { operation: 'install', ...bundle });
    const taskId = randomUUID(), folder = path.join(f.home, '.local/state/remotecc/tasks', taskId);
    await f.client.call(config, 'task', startRequest(taskId, bundle.digest));
    await f.client.call(config, 'task', startRequest(taskId, bundle.digest));
    const packets = [];
    let ended = false;
    await f.client.subscribe(config, { taskId }, packet => packets.push(packet), () => { ended = true; });
    await until(() => packets.some(packet => packet.delta));
    assert.deepEqual(packets.find(packet => packet.delta).patches.find(patch => 'append' in patch).append, 'llo');

    const reply = await f.client.call(config, 'task', { operation: 'command', taskId, commandId: randomUUID(), command: { value: 'ping' }, wait: true });
    assert.deepEqual(reply, { ok: true, value: 'ping' });

    // Losing SSH only ends the subscription; the owner keeps running and is rejoined.
    f.client.close(config);
    await new Promise(done => setTimeout(done, 100));
    await f.client.call(config, 'task', startRequest(taskId, bundle.digest));
    assert.equal(fs.readFileSync(path.join(folder, 'runs'), 'utf8'), 'x');
    const later = []; ended = false;
    await f.client.subscribe(config, { taskId }, packet => later.push(packet), () => { ended = true; });
    await until(() => later.length > 0);
    assert.equal(later[0].delta, undefined);
    await f.client.call(config, 'task', { operation: 'command', taskId, commandId: randomUUID(), command: { value: 'finish' }, wait: true });
    await until(() => ended);
    process.kill(JSON.parse(fs.readFileSync(path.join(folder, 'started.json'))).pid, 'SIGKILL');
  } finally { f.close(); }
});

test('task: a killed owner is reported to subscribers and never re-executed', async () => {
  const f = fixture();
  try {
    const bundle = workerBundle(`
      const fs=require('fs'),path=require('path');const folder=process.argv[2];
      fs.appendFileSync(path.join(folder,'runs'),'x');
      fs.writeFileSync(path.join(folder,'state.json'),JSON.stringify({version:1,done:false,resident:true,status:'working',permissions:[],message:{id:'reply',blocks:[]}}));
      setInterval(()=>{},1000);
    `);
    await f.client.call(config, 'task', { operation: 'install', ...bundle });
    const taskId = randomUUID(), folder = path.join(f.home, '.local/state/remotecc/tasks', taskId);
    await f.client.call(config, 'task', startRequest(taskId, bundle.digest));
    await until(() => fs.existsSync(path.join(folder, 'state.json')));
    const packets = [];
    let ended = false;
    await f.client.subscribe(config, { taskId }, packet => packets.push(packet), () => { ended = true; });
    await until(() => packets.length > 0);
    process.kill(JSON.parse(fs.readFileSync(path.join(folder, 'started.json'))).pid, 'SIGKILL');
    await until(() => ended, 8000);
    const state = JSON.parse(fs.readFileSync(path.join(folder, 'state.json')));
    assert.equal(state.done, true); assert.equal(state.status, 'error');
    await f.client.call(config, 'task', startRequest(taskId, bundle.digest));
    assert.equal(fs.readFileSync(path.join(folder, 'runs'), 'utf8'), 'x');
  } finally { f.close(); }
});

test('search and quick-open find files; git status reports changes', async () => {
  const f = fixture();
  try {
    const project = path.join(f.home, 'project');
    fs.mkdirSync(path.join(project, 'src'), { recursive: true });
    fs.mkdirSync(path.join(project, 'node_modules/x'), { recursive: true });
    fs.writeFileSync(path.join(project, 'src/renderer.js'), 'const needle = 1;\n');
    fs.writeFileSync(path.join(project, 'node_modules/x/renderer.js'), 'const needle = 2;\n');
    const call = request => f.client.call(config, 'file', { base: project, ...request });
    assert.deepEqual((await call({ operation: 'suggest', query: 'rendr' })).files.map(file => file.relative), ['src/renderer.js']);
    const found = await call({ operation: 'search', query: 'needle' });
    assert.deepEqual(found.matches.map(match => [match.relative, match.line]), [['src/renderer.js', 1]]);
    assert.equal((await call({ operation: 'gitStatus' })).repository, false);
    const created = await call({ operation: 'create', directory: project, name: 'new.txt' });
    assert.equal(created.name, 'new.txt');
    await assert.rejects(call({ operation: 'create', directory: project, name: 'new.txt' }), /EEXIST/);
    await assert.rejects(call({ operation: 'create', directory: project, name: '../escape' }), /无效文件名/);
    await assert.rejects(call({ operation: 'rename', path: created.path, name: 'src' }), /已存在/);
    await call({ operation: 'remove', path: created.path });
    assert.equal(fs.existsSync(created.path), false);
    await assert.rejects(call({ operation: 'remove', path: f.home, recursive: true }), /不能删除/);
  } finally { f.close(); }
});
