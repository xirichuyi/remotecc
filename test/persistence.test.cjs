const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ChatService } = require('../src/chat-service.cjs');
const { ChatStore } = require('../src/store.cjs');
const { PersistentTasks } = require('../src/persistent-tasks.cjs');

test('restart reserves a detached task; repeated snapshots replace rather than duplicate its reply', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'remotecc-persist-unit-'));
  try {
    const store = new ChatStore(path.join(folder, 'chats.json'));
    const original = new ChatService(store);
    const session = original.create({ host: 'axi', directory: '/tmp' });
    session.messages = [{ id: 'reply', role: 'assistant', blocks: [] }];
    session.remoteTask = { id: 'task', messageId: 'reply', version: 0 };
    session.status = 'working'; store.save(original.sessions);
    const service = new ChatService(store);
    const restored = service.get(session.id);
    assert.equal(restored.status, 'detached'); assert.ok(service.runs.has(session.id));
    assert.throws(() => service.send(session.id, 'duplicate'), /正在回复/);
    const transport = new PersistentTasks({}, service); service.persistent = transport;
    const state = { version: 2, done: false, status: 'permission', permissions: [{ id: 'approval' }],
      message: { id: 'reply', role: 'assistant', blocks: [{ type: 'text', text: 'saved' }] } };
    transport.apply(restored, state); transport.apply(restored, state);
    transport.apply(restored, { ...state, version: 1, status: 'working' });
    assert.equal(restored.status, 'permission'); assert.equal(restored.messages.length, 1);
    await service.close();
    assert.equal(restored.status, 'detached'); assert.ok(restored.remoteTask);
    transport.apply(restored, { ...state, version: 3, done: true, status: 'idle', permissions: [] });
    assert.equal(restored.remoteTask, undefined); assert.equal(service.runs.has(session.id), false);
    assert.equal(restored.messages[0].blocks[0].text, 'saved');
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('remote supervisor never re-executes a completed or uncertain task', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'remotecc-owner-unit-'));
  const helper = path.resolve('src/task-bridge.py');
  try {
    const request = { session: { messages: [{ id: 'reply', blocks: [] }] } };
    fs.writeFileSync(path.join(folder, 'request.json'), JSON.stringify(request));
    fs.writeFileSync(path.join(folder, 'started.json'), 'true');
    let result = spawnSync('python3', [helper, 'supervise', folder, '/nonexistent'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const state = JSON.parse(fs.readFileSync(path.join(folder, 'state.json')));
    assert.equal(state.done, true); assert.equal(state.status, 'error');
    result = spawnSync('python3', [helper, 'supervise', folder, '/nonexistent'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder, 'state.json'))), state);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('resident idle snapshots keep owner and command catalogue; old turn snapshots cannot overwrite a new turn', async () => {
  const service = new ChatService({load:()=>[],save(){}});
  const transport = new PersistentTasks({},service);service.persistent=transport;
  const session=service.create({host:'axi',directory:'/tmp'});
  session.messages=[{id:'one',role:'assistant',blocks:[]}];
  session.remoteTask={id:'owner',messageId:'one',version:-1};service.runs.set(session.id,{persistent:true});
  const state={resident:true,version:1,done:false,status:'idle',permissions:[],message:session.messages[0],capabilities:{commands:[{name:'new-skill'}]}};
  transport.apply(session,state);
  assert.equal(session.remoteTask,undefined);assert.equal(session.remoteOwner.id,'owner');assert.equal(service.runs.has(session.id),false);
  assert.equal(session.capabilities.commands[0].name,'new-skill');
  session.messages.push({id:'two',role:'assistant',blocks:[]});session.status='connecting';
  session.remoteTask={id:'owner',messageId:'two',version:-1};service.runs.set(session.id,{persistent:true});
  transport.apply(session,{...state,version:2});
  assert.equal(session.status,'connecting');assert.equal(session.remoteTask.messageId,'two');
  transport.apply(session,{...state,version:3,status:'working',message:session.messages[1]});
  assert.equal(session.status,'working');
  transport.apply(session,{...state,version:4,message:session.messages[1],status:'idle'});
  assert.equal(session.messages.length,2);assert.equal(session.remoteOwner.id,'owner');assert.equal(session.remoteTask,undefined);
  await service.close();
});

test('dead resident owner rejects an undispatched turn instead of leaving it connecting forever', async () => {
  const service=new ChatService({load:()=>[],save(){}});
  const transport=new PersistentTasks({},service);service.persistent=transport;
  const session=service.create({host:'axi'});
  session.messages=[{id:'old',blocks:[]},{id:'new',blocks:[]}];
  session.remoteOwner={id:'owner',version:2};session.remoteTask={id:'owner',messageId:'new'};
  service.runs.set(session.id,{persistent:true});
  transport.apply(session,{version:3,done:true,status:'error',message:session.messages[0]});
  assert.equal(session.remoteOwner,undefined);assert.equal(session.remoteTask,undefined);
  assert.equal(session.status,'error');assert.match(session.messages[1].error,/未执行/);
  await service.close();
});
