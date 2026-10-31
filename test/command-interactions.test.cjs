const {test}=require('node:test');
const assert=require('node:assert/strict');
const {interaction}=require('../src/command-interactions.cjs');
const {ChatService}=require('../src/chat-service.cjs');
const caps={commands:[{name:'model',builtin:true,aliases:['choose-model']},{name:'effort',builtin:true,argumentHint:'<low|high|max|auto>'}],models:[{value:'default',displayName:'Remote default',supportedEffortLevels:['low','high']},{value:'test-model',displayName:'Remote test',supportedEffortLevels:['low']}]};
test('interactive arguments are remote-driven and custom commands retain precedence over aliases',()=>{
  assert.equal(interaction(caps,'/model').options[1].label,'Remote test');
  assert.equal(interaction(caps,'/choose-model test-model').argument,'test-model');
  assert.equal(interaction({...caps,commands:[...caps.commands,{name:'choose-model'}]},'/choose-model'),null);
  assert.equal(interaction({...caps,commands:[{name:'model'}]},'/model'),null);
  assert.deepEqual(interaction(caps,'/effort').options.map(option=>option.value),['low','high','auto']);
  assert.equal(interaction({...caps,commands:[{name:'open',builtin:true,argumentHint:'<file>'}]},'/open'),null);
});
test('native controls acknowledge before saving preferences, rejection preserves previous settings',async()=>{
  let fail=false; const calls=[];
  const client={supportedCommands:async()=>caps.commands,supportedModels:async()=>caps.models,supportedAgents:async()=>[],initializationResult:async()=>({}),close(){},setModel:async value=>{calls.push(['model',value]);if(fail)throw new Error('remote rejected');},applyFlagSettings:async value=>calls.push(['settings',value])};
  const service=new ChatService({load:()=>[],save(){}},async()=>()=>client);
  try {
    const session=service.create({host:'axi'});
    await service.selectModel(session.id,'test-model');
    assert.equal(session.preferences.selectedModel,'test-model');
    await service.selectEffort(session.id,'low');
    assert.equal(session.preferences.effort,'low');
    await service.selectEffort(session.id,'auto');
    assert.equal(session.preferences.effort,'');
    fail=true;await assert.rejects(service.selectModel(session.id,'default'),/remote rejected/);
    assert.equal(session.preferences.selectedModel,'test-model');
    assert.deepEqual(calls.slice(0,3),[['model','test-model'],['settings',{effortLevel:'low'}],['settings',{effortLevel:null}]]);
  } finally {await service.close();}
});

test('running resident controls use the owner, preserve pending approval, and commit only acknowledged settings', async () => {
 const service=new ChatService({load:()=>[],save(){}},async()=>{throw new Error('must not spawn an inspector');});
 const session=service.create({host:'axi'});session.remoteOwner={id:'owner'};session.remoteTask={id:'owner'};
 session.permissions=[{id:'waiting'}];session.status='permission';service.runs.set(session.id,{persistent:true});
 let reject=false;
 service.persistent={control:async(_session,action,value)=>{
  if(action==='catalogue')return {models:[{value:'sonnet',supportedEffortLevels:['low']}]};
  if(reject)throw new Error('remote rejection');
  if(action==='configure')return {...session.preferences,...value};
 },detach:async()=>{}};
 try {
  await service.selectModel(session.id,'sonnet');await service.selectEffort(session.id,'low');
  await service.configure(session.id,{permissionMode:'plan'});
  assert.equal(session.status,'permission');assert.equal(session.permissions[0].id,'waiting');
  assert.equal(session.preferences.permissionMode,'plan');assert.equal(session.preferences.selectedModel,'sonnet');
  reject=true;await assert.rejects(service.selectModel(session.id,'opus'),/remote rejection/);
  assert.equal(session.preferences.selectedModel,'sonnet');
 }finally{await service.close();}
});

test('actual response model follows native mid-turn changes without confusing subagent models', async () => {
 const {Transcript,newAssistant}=require('../src/transcript.cjs');
 const service=new ChatService({load:()=>[],save(){}});const session=service.create({host:'axi'});
 const message=newAssistant('reply');session.messages.push(message);
 const run={message,transcript:new Transcript(message)};
 service.consumeEvent(session,{type:'assistant',message:{id:'a',model:'claude-haiku',content:[]}},run);
 assert.equal(session.model,'claude-haiku');assert.equal(message.model,'claude-haiku');
 service.consumeEvent(session,{type:'assistant',parent_tool_use_id:'subagent',message:{id:'b',model:'claude-opus',content:[]}},run);
 assert.equal(session.model,'claude-haiku');await service.close();
});

test('effort picker uses remote model metadata when CLI supplies no finite argument hint', () => {
  const noHint = {...caps, commands:[{name:'effort', builtin:true}]};
  assert.deepEqual(interaction(noHint,'/effort',{selectedModel:'test-model'}).options.map(item=>item.value), ['low','auto']);
});

test('clear creates a separate conversation only for a confirmed native command', () => {
  assert.equal(interaction({...caps,commands:[{name:'clear',builtin:true}]},'/clear').kind,'newConversation');
  assert.equal(interaction({...caps,commands:[{name:'clear'}]},'/clear'),null);
  assert.equal(interaction({...caps,commands:[{name:'clear',builtin:true}]},'/clear unexpected'),null);
});
