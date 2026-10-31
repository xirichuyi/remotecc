const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {SSHConnections} = require('../src/ssh.cjs');
const {ChatService} = require('../src/chat-service.cjs');
const {ChatStore} = require('../src/store.cjs');
const {PersistentTasks} = require('../src/persistent-tasks.cjs');
const {shellQuote} = require('../src/remote.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const directory = '/tmp/remotecc-elicitation-' + randomUUID();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'remotecc-elicitation-'));
  const config = {host:'axi', directory};
  const store = new ChatStore(path.join(profile, 'chats.json'));
  let ssh, service, id, taskId;
  async function client() {
    ssh = new SSHConnections(); await ssh.connect(config);
    service = new ChatService(store); service.persistent = new PersistentTasks(ssh, service);
  }
  async function python(source) {
    const child = ssh.spawn(config, 'python3 -c ' + shellQuote(source)); child.stdin.end();
    let output='', error='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>error+=data);
    await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error(error)));});
    return output;
  }
  async function nextRequest() {
    const deadline = Date.now()+120000;
    while (Date.now()<deadline) {
      const session=service.get(id);
      const permission=session.permissions[0];
      if (permission?.kind==='elicitation') return permission;
      if (permission) {
        assert.match(permission.name,/^mcp__remotecc-interaction__collect_preferences$/);
        await service.respond(id,permission.id,{allow:true});
        await pause(1000);
      }
      assert.ok(!['idle','error','stopped'].includes(session.status), JSON.stringify(session.messages.at(-1)));
      await pause(200);
    }
    throw new Error('Timed out waiting for native elicitation: '+JSON.stringify(service.get(id).messages.at(-1)));
  }
  try {
    await client();
    const files = {
      '/server.py':fs.readFileSync(path.join(__dirname,'elicitation-server.py'),'utf8'),
      '/.mcp.json':JSON.stringify({mcpServers:{'remotecc-interaction':{command:'python3',args:[directory+'/server.py',directory+'/result.json']}}}),
      '/.claude/settings.local.json':JSON.stringify({enableAllProjectMcpServers:true}),
    };
    await python('import os,json\np='+JSON.stringify(directory)+'\nos.makedirs(p+"/.claude",mode=0o700)\nfor name,content in json.loads('+JSON.stringify(JSON.stringify(files))+').items():\n open(p+name,"w").write(content)');
    const session=service.create(config);id=session.id;
    service.configure(id,{selectedModel:'sonnet',effort:'low'});
    service.send(id,'Call mcp__remotecc-interaction__collect_preferences exactly once. Wait for both user forms, then reply ELICITATION-TEST-DONE. Do not use any other tools.');
    taskId=session.remoteTask.id;
    const first=await nextRequest();
    assert.equal(first.request.message,'First test form');
    console.log('Native form received; disconnecting client with request pending');
    await service.close();await ssh.close();await pause(1000);
    await client();await service.persistent.restore(config);
    const restored=await nextRequest();
    assert.equal(restored.id,first.id);assert.equal(service.get(id).remoteTask.id,taskId);
    assert.throws(()=>service.respond(id,restored.id,{interaction:{action:'accept',content:{name:'X',count:9,enabled:'false',tags:['c']}}}));
    const content={name:'RemoteCC',count:2,enabled:false,tags:['a','b']};
    await service.respond(id,restored.id,{interaction:{action:'accept',content}});
    const deadline=Date.now()+30000;
    while(service.get(id).permissions.some(item=>item.id===first.id)&&Date.now()<deadline) await pause(100);
    const second=await nextRequest();assert.equal(second.request.message,'Second test form');
    await service.respond(id,second.id,{interaction:{action:'decline'}});
    while(service.get(id).remoteTask&&Date.now()<deadline)await pause(200);
    assert.equal(service.get(id).status,'idle',JSON.stringify(service.get(id).messages.at(-1)));
    const result=JSON.parse(await python('print(open('+JSON.stringify(directory+'/result.json')+').read())'));
    assert.deepEqual(result,{first:{action:'accept',content},second:{action:'decline'}});
    console.log('PASS axi: native MCP forms; same pending request after client shutdown; invalid answer rejected; typed accept and follow-up decline reach MCP server');
  } finally {
    if(service?.get(id)?.remoteTask){await service.stop(id).catch(()=>{});for(let i=0;i<50&&service.get(id).remoteTask;i++)await pause(200);}
    await service?.close();
    if(ssh?.state(config).status==='connected') {
      let cleanup='import os,shutil,glob,json\nshutil.rmtree('+JSON.stringify(directory)+',ignore_errors=True)\n';
      if(taskId)cleanup+='p=os.path.expanduser("~/.local/state/remotecc/tasks/'+taskId+'")\nif os.path.exists(p+"/state.json") and json.load(open(p+"/state.json")).get("done"): shutil.rmtree(p)\n';
      const remoteId=service?.get(id)?.remoteSessionId;
      if(remoteId)cleanup+='for p in glob.glob(os.path.expanduser("~/.claude/projects/*/'+remoteId+'.jsonl")): os.unlink(p)\n';
      await python(cleanup);
    }
    await ssh?.close();fs.rmSync(profile,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
