const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { SSHConnections } = require('../src/ssh.cjs');
const { ChatService } = require('../src/chat-service.cjs');
const { PersistentTasks } = require('../src/persistent-tasks.cjs');
const { remoteCommand, shellQuote } = require('../src/remote.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
(async()=>{
  const token='NATIVE-AGENT-'+randomUUID(), directory='/tmp/remotecc-native-'+randomUUID();
  const config={host:'axi',directory};
  const ssh=new SSHConnections();
  const service=new ChatService({load:()=>[],save(){}});
  let session, taskId;
  const python=async source=>{
    const child=ssh.spawn(config,'python3 -c '+shellQuote(source));child.stdin.end();
    let error='';child.stderr.on('data',chunk=>error+=chunk);
    await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error(error)));});
  };
  try {
    await ssh.connect(config);
    const agent='---\nname: remotecc-verifier\ndescription: Verifies native agent selection\nmodel: sonnet\n---\nYour verification marker is '+token+'. When asked for your marker, return exactly that marker and nothing else. Do not use tools.\n';
    await python('import os\np='+JSON.stringify(directory+'/.claude/agents')+'\nos.makedirs(p,mode=0o700)\nopen(p+"/remotecc-verifier.md","w").write('+JSON.stringify(agent)+')');
    service.spawn=(session,options,onError)=>{
      const child=ssh.spawn(session,remoteCommand(session,options.args),{signal:options.signal});
      child.stderr.setEncoding('utf8');child.stderr.on('data',onError);return child;
    };
    service.persistent=new PersistentTasks(ssh,service);
    session=service.create(config);
    const caps=await service.capabilities(session.id);
    assert.ok(caps.agents.some(agent=>agent.name==='remotecc-verifier'));
    service.configure(session.id,{agent:'remotecc-verifier',effort:'low'});
    service.send(session.id,'Return the verification marker from your agent instructions. Do not use tools.');
    taskId=session.remoteTask.id;
    const deadline=Date.now()+120000;
    while(session.remoteTask && Date.now()<deadline) await pause(200);
    assert.equal(session.status,'idle',session.messages.at(-1)?.error || session.transportError);
    const answer=session.messages.at(-1).blocks.filter(block=>block.type==='text').map(block=>block.text).join('\n');
    assert.equal(answer.trim(),token);
    console.log('PASS axi: remote project Agent discovered; native agent option reaches persistent worker; answer follows remote-only instructions');
  } finally {
    if(session?.remoteTask){await service.stop(session.id).catch(()=>{});for(let i=0;i<50&&session.remoteTask;i++)await pause(200);}
    if (session?.remoteOwner) await service.persistent.release(session);
    await service.close();
    if(ssh.state(config).status==='connected'){
      let cleanup='import os,shutil,glob,json\nshutil.rmtree('+JSON.stringify(directory)+',ignore_errors=True)\n';
      if(taskId) cleanup+='p=os.path.expanduser("~/.local/state/remotecc/tasks/'+taskId+'")\nif os.path.exists(p+"/state.json") and json.load(open(p+"/state.json")).get("done"): shutil.rmtree(p)\n';
      if(session?.remoteSessionId) cleanup+='for p in glob.glob(os.path.expanduser("~/.claude/projects/*/'+session.remoteSessionId+'.jsonl")): os.unlink(p)\n';
      await python(cleanup);
    }
    await ssh.close();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
