const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { applyStateDelta } = require('../src/state-delta.cjs');
const { ChatStore } = require('../src/store.cjs');
const { createSession } = require('../src/remote.cjs');
const { RemoteFiles } = require('../src/files.cjs');

test('remote deltas reconstruct text, tools, removed fields and permissions; out-of-order deltas fail', () => {
  const states = [
    { version:1, done:false, permissions:[], message:{id:'m',blocks:[{type:'text',text:'hello'}]}, temporary:true },
    { version:2, done:false, permissions:[{id:'p'}], message:{id:'m',blocks:[{type:'text',text:'hello world'},{type:'tool',input:{x:1}}]} },
    { version:3, done:true, permissions:[], message:{id:'m',blocks:[{type:'text',text:'replaced'},{type:'tool',input:{x:2}}]} },
  ];
  const script = `import importlib.util,json,sys\ns=importlib.util.spec_from_file_location('bridge','src/task-bridge.py'); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)\na=json.load(sys.stdin)\nprint(json.dumps([dict(delta=True,base=a[i-1]['version'],version=a[i]['version'],patches=m.state_delta(a[i-1],a[i])) for i in range(1,len(a))]))`;
  const result = spawnSync('python3',['-c',script],{input:JSON.stringify(states),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const packets=JSON.parse(result.stdout);
  let state=states[0]; packets.forEach((packet,i)=>{state=applyStateDelta(state,packet);assert.deepEqual(state,states[i+1]);});
  assert.equal(states[0].message.blocks[0].text,'hello');
  assert.throws(()=>applyStateDelta(state,packets[0]),/不连续/);
  assert.throws(()=>applyStateDelta(state,{delta:true,base:3,version:4,patches:[{path:['__proto__','x'],value:1}]}),/无效/);
});

test('legacy migration preserves backup; updating one conversation does not write other conversations', () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'rcc-store-test-'));
  try {
    const file=path.join(directory,'chats.json');
    const initial=[createSession({host:'axi'}),createSession({host:'axi'})];
    const legacy=JSON.stringify(initial);fs.writeFileSync(file,legacy);
    const store=new ChatStore(file),sessions=store.load();store.save(sessions);
    assert.equal(fs.readFileSync(file+'.legacy','utf8'),legacy);
    const writes=[];const atomic=store.atomic.bind(store);store.atomic=(file,text)=>{writes.push(file);atomic(file,text);};
    sessions[0].name='changed';store.save(sessions,sessions[0]);
    assert.deepEqual(writes,[store.sessionFile(sessions[0].id), file]);
    store.saveLater(sessions,sessions[0]);sessions[0].name='pending';
    store.save(sessions); // Shutdown flushes the pending change before returning.
    assert.equal(new ChatStore(file).load()[0].name,'pending');
    store.save([sessions[0]]);assert.equal(new ChatStore(file).load().length,1);
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
});

test('directory cache coalesces reads, refresh bypasses cache, and file preview checks remote versions', async () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'rcc-cache-test-'));
  try {
    const files=new RemoteFiles({},()=>{},directory),session={host:'axi',directory:'/project'};
    let calls=0,version='v1',text='first';
    files.run=async (_session,request)=>{
      calls++;
      if(request.operation==='list') return {entries:[]};
      assert.equal(request.operation,'preview');
      if(request.knownVersion===version)return {notModified:true,version};
      return {path:'/project/file',version,kind:'text',size:text.length,text,truncated:false};
    };
    await Promise.all([files.list(session,'/project'),files.list(session,'/project')]);assert.equal(calls,1);
    await files.list(session,'/project');assert.equal(calls,1);
    await files.list(session,'/project',false,true);assert.equal(calls,2);
    assert.equal((await files.preview(session,'file')).text,'first');
    assert.equal((await files.preview(session,'file')).text,'first');
    version='v2';text='updated';assert.equal((await files.preview(session,'file')).text,'updated');
    files.invalidate();await files.list(session,'/project');assert.equal(calls,6);
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
});
