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
(async()=>{
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'remotecc-resident-'));
 const config={host:'axi',directory:'/tmp'};
 const store=new ChatStore(path.join(profile,'chats.json'));
 let ssh,service,id,ownerId;
 async function client(){ssh=new SSHConnections();await ssh.connect(config);service=new ChatService(store);service.persistent=new PersistentTasks(ssh,service);}
 async function until(check){const deadline=Date.now()+120000;while(!check()){if(Date.now()>deadline)throw new Error('Timeout: '+JSON.stringify(service.get(id)));await pause(200);}}
 try {
  await client();const session=service.create(config);id=session.id;
  service.configure(id,{selectedModel:'sonnet',effort:'low'});
  const token='RESIDENT-'+randomUUID();
  service.send(id,'Remember this token: '+token+'. Reply OK only. Do not use tools.');
  await until(()=>!service.get(id).remoteTask);
  assert.equal(session.status,'idle',JSON.stringify(session.messages.at(-1)));
  ownerId=session.remoteOwner.id;const remoteId=session.remoteSessionId;
  console.log('First turn complete; resident owner remains',ownerId);
  await service.close();await ssh.close();
  await client();await service.persistent.restore(config);
  await until(()=>service.get(id).remoteOwner?.id===ownerId&&!service.get(id).transportError);
  const restored=service.get(id);
  service.send(id,'First use AskUserQuestion with Continue and Cancel options, and wait. After Continue, return the token I asked you to remember. Do not use any other tools.');
  await until(()=>restored.permissions.length||!restored.remoteTask);
  assert.equal(restored.permissions[0]?.name,'AskUserQuestion',JSON.stringify(restored.messages.at(-1)));
  const permission=restored.permissions[0];
  await service.selectModel(id,'sonnet');await service.selectEffort(id,'low');
  await service.configure(id,{permissionMode:'plan'});await service.configure(id,{permissionMode:'default'});
  await assert.rejects(service.persistent.control(restored,'invalid'),/未知/);
  await service.capabilities(id,true);
  assert.equal(restored.remoteOwner.id,ownerId);assert.equal(restored.status,'permission');
  await service.close();await ssh.close();await client();await service.persistent.restore(config);
  await until(()=>service.get(id).permissions.some(item=>item.id===permission.id));
  await service.respond(id,permission.id,{allow:true,answers:Object.fromEntries(permission.input.questions.map(q=>[q.question,'Continue']))});
  await until(()=>!service.get(id).remoteTask);
  const result=service.get(id);
  assert.equal(result.status,'idle',JSON.stringify(result.messages.at(-1)));
  assert.equal(result.remoteOwner.id,ownerId);assert.equal(result.remoteSessionId,remoteId);
  assert.ok(result.messages.at(-1).blocks.some(b=>b.text?.includes(token)));
  assert.equal(result.messages.length,4);
  await service.persistent.command(result,{kind:'send',prompt:'This replay must not run',message:result.messages.at(-1)},result.messages.at(-1).id);
  await pause(500);assert.equal(result.status,'idle');assert.equal(result.messages.length,4);
  const caps=await service.capabilities(id,true);assert.ok(caps.commands.length);
  service.send(id,'Use AskUserQuestion again with A and B and wait.');
  await until(()=>service.get(id).permissions.length||!service.get(id).remoteTask);
  await service.stop(id);await until(()=>!service.get(id).remoteTask);
  assert.equal(service.get(id).status,'stopped');assert.equal(service.get(id).remoteOwner.id,ownerId);
  service.send(id,'Reply STOP-RECOVERY-OK only. Do not use tools.');
  await until(()=>!service.get(id).remoteTask);
  assert.equal(service.get(id).status,'idle');assert.equal(service.get(id).remoteOwner.id,ownerId);
  console.log('PASS axi: same resident owner and Claude session across turns/restarts; live model/effort control during approval; pending approval restored; stop retains owner; next turn succeeds');
 }finally{
  if(service?.get(id)?.remoteTask){await service.stop(id).catch(()=>{});await until(()=>!service.get(id).remoteTask).catch(()=>{});}
  const session=id&&service?.get(id);const remoteId=session?.remoteSessionId;
  if(session?.remoteOwner)await service.persistent.release(session).catch(console.error);
  await service?.close();
  if(ownerId&&ssh?.state(config).status==='connected'){
   const source='import os,shutil,glob,json\np=os.path.expanduser("~/.local/state/remotecc/tasks/'+ownerId+'")\nif os.path.exists(p+"/state.json") and json.load(open(p+"/state.json")).get("done"): shutil.rmtree(p)\n'+(remoteId?'for p in glob.glob(os.path.expanduser("~/.claude/projects/*/'+remoteId+'.jsonl")): os.unlink(p)\n':'');
   const child=ssh.spawn(config,'python3 -c '+shellQuote(source));child.stdin.end();await new Promise(resolve=>child.on('close',resolve));
  }
  await ssh?.close();fs.rmSync(profile,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
