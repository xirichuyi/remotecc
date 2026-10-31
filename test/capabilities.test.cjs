const test = require('node:test');
const assert = require('node:assert/strict');
const { ChatService } = require('../src/chat-service.cjs');
const { preferencePatch } = require('../src/capabilities.cjs');
const { Transcript, newAssistant } = require('../src/transcript.cjs');
test('settings are validated and sent to remote query, branches preserve context without mutating source', async () => {
  const service = new ChatService({ load: () => [], save() {} });
  const source = service.create({ host: 'axi', directory: '/tmp' });
  source.remoteSessionId = 'original';
  source.messages.push({ role: 'user', text: 'remember' });
  service.configure(source.id, { selectedModel: 'sonnet', effort: 'low', permissionMode: 'plan', additionalDirectories: ['/tmp/a'] });
  const branch = service.fork(source.id);
  const options = service.options(branch, { stderr: '' });
  assert.equal(options.model, 'sonnet');
  assert.equal(options.effort, 'low');
  assert.equal(options.permissionMode, 'plan');
  assert.equal(options.forkSession, true);
  assert.equal(options.resume, 'original');
  branch.messages[0].text = 'changed';
  assert.equal(source.messages[0].text, 'remember');
  assert.throws(() => preferencePatch({ permissionMode: 'bypassPermissions' }));
  assert.throws(() => preferencePatch({ additionalDirectories: ['relative'] }));
  assert.throws(() => preferencePatch({ selectedModel: 'sonnet\n--unsafe' }));
  await service.close();
});
test('local slash command output appears in transcript', () => {
  const message = newAssistant('test');
  new Transcript(message).consume({ type: 'system', subtype: 'local_command_output', content: 'Context compacted' });
  assert.ok(message.blocks.some(block => block.text?.includes('Context compacted')));
});

test('remote command catalogue preserves names, aliases and metadata without a local allowlist', async () => {
  const { catalogue } = require('../src/capabilities.cjs');
  const commands = [
    { name: 'model', description: 'remote model description', argumentHint: '[remote options]', aliases: ['choose-model'], builtin: true },
    { name: 'team.review', description: 'project command', aliases: ['审阅'], customMetadata: 'preserved' },
  ];
  const result = await catalogue({
    supportedCommands: async () => commands, supportedModels: async () => [],
    supportedAgents: async () => [], initializationResult: async () => ({}),
  });
  assert.deepEqual(result.commands, commands);
  assert.equal(result.commands.some(command => command.name === 'ports'), false);
});

test('selecting a remote agent passes its exact name to Claude and preserves it in branches', async () => {
  const service = new ChatService({load:()=>[],save(){}});
  try {
    const session=service.create({host:'axi',directory:'/project'});
    session.capabilities={agents:[{name:'project-reviewer',description:'Remote definition'}],models:[]};
    session.remoteSessionId='remote';
    service.configure(session.id,{agent:'project-reviewer'});
    assert.equal(service.options(session,{stderr:''}).agent,'project-reviewer');
    assert.deepEqual(service.options(session,{stderr:''}).systemPrompt,{type:'preset',preset:'claude_code'});
    assert.equal(service.options(service.fork(session.id),{stderr:''}).agent,'project-reviewer');
    assert.throws(()=>service.configure(session.id,{agent:'invented-agent'}),/远端列表/);
    service.configure(session.id,{agent:''});
    assert.equal(service.options(session,{stderr:''}).agent,undefined);
  } finally {await service.close();}
});

test('a new session receives a changed event when reusing the remote catalogue cache', async () => {
  const service=new ChatService({load:()=>[],save(){}},async()=>()=>({
    supportedCommands:async()=>[{name:'usage'}],supportedModels:async()=>[],supportedAgents:async()=>[],initializationResult:async()=>({}),close(){}
  }));
  try {
    const a=service.create({host:'axi'}),b=service.create({host:'axi'});
    await service.capabilities(a.id);
    let changed=false;service.on('changed',session=>{if(session.id===b.id)changed=true;});
    await service.capabilities(b.id);
    assert.equal(changed,true);assert.equal(b.capabilities.commands[0].name,'usage');
  }finally{await service.close();}
});

test('capability inspection does not persist a throwaway session or fork history', async () => {
  const {inspectRemote}=require('../src/capabilities.cjs');
  let received;
  const client={close(){}};
  const service={runs:new Map(),options:()=>({forkSession:true,resume:'existing'}),loadQuery:async()=>({options})=>{received=options;return client;}};
  await inspectRemote(service,{id:'test'},async()=>{});
  assert.equal(received.persistSession,false);
  assert.equal(received.forkSession,undefined);
  assert.equal(received.resume,'existing');
});
