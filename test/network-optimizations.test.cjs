const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ChatStore } = require('../src/store.cjs');
const { createSession } = require('../src/remote.cjs');
const { SessionUpdates } = require('../src/session-updates.cjs');
const { RequestScheduler } = require('../src/request-scheduler.cjs');
const { RemoteFiles } = require('../src/files.cjs');
const { FileCache } = require('../src/file-cache.cjs');

test('metadata startup does not read message files; saving unloaded sessions preserves their messages', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-lazy-'));
  try {
    const file = path.join(directory, 'chats.json');
    const original = new ChatStore(file);
    const session = createSession({host:'axi'});
    session.messages.push({id:'u1', role:'user', text:'saved message'});
    original.save([session]);
    const store = new ChatStore(file);
    const sessionFile = store.sessionFile(session.id);
    fs.renameSync(sessionFile, sessionFile + '.hold');
    const sessions = store.load({lazy:true}); // Does not require access to the transcript file.
    assert.equal(sessions[0].messageCount, 1);
    assert.deepEqual(sessions[0].messages, []);
    sessions[0].name = 'metadata update';
    store.save(sessions);
    assert.equal(fs.existsSync(sessionFile), false);
    fs.renameSync(sessionFile + '.hold', sessionFile);
    store.hydrate(sessions[0]);
    assert.equal(sessions[0].messages[0].text, 'saved message');
    assert.equal(sessions[0].name, 'metadata update');
    store.save(sessions);
    assert.equal(new ChatStore(file).load()[0].messages[0].text, 'saved message');
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
});

test('IPC updates exclude unchanged historical content and include edited message revisions', () => {
  const updates = new SessionUpdates();
  const session = {id:'s', messages:[{id:'old', text:'x'.repeat(1024*1024)}, {id:'reply', revision:1, text:'hi'}]};
  assert.equal(updates.packet(session).changedMessages.length, 2);
  session.messages[1].text += ' there'; session.messages[1].revision++;
  const packet = updates.packet(session);
  assert.deepEqual(packet.changedMessages.map(item=>item.id), ['reply']);
  assert.ok(JSON.stringify(packet).length < 1000);
  session.messages[0].text = 'edited'; session.messages[0].revision = 1;
  assert.equal(updates.packet(session).changedMessages[0].id, 'old');
});

test('file scheduler bounds concurrency, cancels queued reads and gives writes priority', async () => {
  const scheduler = new RequestScheduler(1), events = [];
  let release;
  const first = scheduler.run('axi', () => new Promise(resolve => { release = resolve; }));
  await Promise.resolve();
  const controller = new AbortController();
  const cancelled = scheduler.run('axi', () => events.push('cancelled'), controller.signal);
  const rejection = assert.rejects(cancelled, /取消/);
  const read = scheduler.run('axi', () => events.push('read'));
  const write = scheduler.run('axi', () => events.push('write'), undefined, 1);
  controller.abort(); release();
  await Promise.all([first,rejection,read,write]);
  assert.deepEqual(events,['write','read']);
});

test('preview metadata survives restart and cache eviction respects active readers', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'rcc-preview-'));
  try {
    const session = {host:'axi',directory:'/project'};
    const first = new RemoteFiles({},()=>{},directory);
    first.run = async()=>({kind:'text',version:'v1',path:'/project/a',text:'cached',size:6});
    await first.preview(session,'a');
    const second = new RemoteFiles({},()=>{},directory);
    second.run = async(_session,request)=>{
      assert.equal(request.knownVersion,'v1');
      return {notModified:true};
    };
    assert.equal((await second.preview(session,'a')).text,'cached');
    const cache = new FileCache(directory); cache.limit = 0;
    await cache.put('pinned','payload');
    await cache.withLease('pinned', async()=>{
      await cache.sweep();
      assert.ok(await cache.get('pinned'));
    });
    await cache.sweep(); assert.equal(await cache.get('pinned'),null);
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
});

test('remote capability requests coalesce within a project and isolate different settings', async () => {
  const { ChatService } = require('../src/chat-service.cjs');
  let inspections = 0;
  const service = new ChatService({load:()=>[],save(){}}, async()=>()=>{
    inspections++;
    return {supportedCommands:async()=>[{name:'usage'}],supportedModels:async()=>[],supportedAgents:async()=>[],initializationResult:async()=>({claude_code_version:'test'}),close(){}};
  });
  try {
    const a=service.create({host:'axi',directory:'/project'}), b=service.create({host:'axi',directory:'/project'});
    await Promise.all([service.capabilities(a.id),service.capabilities(b.id)]);
    assert.equal(inspections,1);
    await service.capabilities(b.id); assert.equal(inspections,1);
    await service.capabilities(b.id,true); assert.equal(inspections,2);
    service.configure(b.id,{additionalDirectories:['/other']});
    await service.capabilities(b.id); assert.equal(inspections,3);
  } finally {await service.close();}
});
