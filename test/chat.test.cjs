const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { ChatService } = require('../src/chat-service.cjs');
const { Transcript, newAssistant } = require('../src/transcript.cjs');

function memoryStore() { return { load: () => [], save: () => {} }; }
function queryFrom(generator) {
  const stream = generator();
  stream.close = () => {};
  stream.interrupt = async () => {};
  return stream;
}
async function until(service, predicate) {
  if (predicate()) return;
  for (;;) { await once(service, 'changed'); if (predicate()) return; }
}

test('streaming final text is not duplicated; tool results and errors are preserved', () => {
  const message = newAssistant('reply');
  const t = new Transcript(message);
  t.consume({ type: 'stream_event', event: { type: 'message_start', message: { id: 'model1' } } });
  t.consume({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  t.consume({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } } });
  t.consume({ type: 'assistant', message: { id: 'model1', content: [{ type: 'text', text: 'Hello' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/test' } }] } });
  t.consume({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'data', is_error: false }] } });
  assert.equal(message.blocks.filter(b => b.type === 'text').length, 1);
  assert.equal(message.blocks[0].text, 'Hello');
  assert.equal(message.blocks[1].status, 'done');
  assert.equal(message.blocks[1].output, 'data');
  t.consume({ type: 'result', is_error: true, result: 'Authentication unavailable' });
  assert.equal(message.error, 'Authentication unavailable');
});

test('second turn resumes the same remote session; history stays local', async () => {
  const seen = [];
  const service = new ChatService(memoryStore(), async () => input => {
    seen.push(input.options);
    return queryFrom(async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'remote-1', model: 'test-model' };
      yield { type: 'assistant', message: { id: 'a' + seen.length, content: [{ type: 'text', text: 'Hello' }] } };
      yield { type: 'result', result: 'Hello', is_error: false };
    });
  });
  const session = service.create({ host: 'pas', directory: '~' });
  service.send(session.id, 'One');
  await until(service, () => !service.runs.size);
  service.send(session.id, 'Two');
  await until(service, () => !service.runs.size);
  assert.equal(seen[0].resume, undefined);
  assert.equal(seen[1].resume, 'remote-1');
  assert.equal(seen[1].permissionMode, 'default');
  assert.equal(session.messages.length, 4);
  assert.equal(session.status, 'idle');
  service.close();
});

test('permissions wait for explicit approval and reject a different session', async () => {
  let decision;
  const controller = new AbortController();
  const service = new ChatService(memoryStore(), async () => ({ options }) => queryFrom(async function* () {
    decision = await options.canUseTool('Bash', { command: 'pwd' }, { signal: controller.signal });
    yield { type: 'result', result: 'done', is_error: false };
  }));
  const session = service.create({ host: 'pas' });
  service.send(session.id, 'Run pwd');
  await until(service, () => session.permissions.length > 0);
  assert.equal(decision, undefined);
  assert.equal(session.status, 'permission');
  const permissionId = session.permissions[0].id;
  assert.throws(() => service.respond('other-session', permissionId, { allow: true }));
  service.respond(session.id, permissionId, { allow: true });
  await until(service, () => !service.runs.size);
  assert.deepEqual(decision, { behavior: 'allow', updatedInput: { command: 'pwd' } });
  assert.equal(session.permissions.length, 0);
  service.close();
});

test('stopping a waiting request denies it and retains the partial response', async () => {
  let decision;
  const controller = new AbortController();
  const service = new ChatService(memoryStore(), async () => ({ options }) => queryFrom(async function* () {
    yield { type: 'assistant', message: { id: 'a1', content: [{ type: 'text', text: 'Checking…' }] } };
    decision = await options.canUseTool('Edit', { file_path: '/tmp/a' }, { signal: controller.signal });
    yield { type: 'result', result: '', is_error: false };
  }));
  const session = service.create({ host: 'pas' });
  service.send(session.id, 'Edit');
  await until(service, () => session.permissions.length > 0);
  assert.throws(() => service.send(session.id, 'another'));
  await service.stop(session.id);
  await until(service, () => !service.runs.size);
  assert.equal(decision.behavior, 'deny');
  assert.equal(session.status, 'stopped');
  assert.equal(session.messages.at(-1).blocks[0].text, 'Checking…');
  assert.equal(session.messages.at(-1).interrupted, true);
  service.close();
});

test('attachments reach remote Claude as readable paths and stay on the user message', async () => {
  let delivered;
  const service = new ChatService(memoryStore(), async () => ({ prompt }) => {
    delivered = prompt;
    return queryFrom(async function* () { yield { type: 'result', result: 'OK', is_error: false }; });
  });
  const session = service.create({ host: 'pas' });
  const attachments = [{ name: 'image.png', path: '/project/image.png', size: 42 }];
  service.send(session.id, '', attachments);
  await until(service, () => !service.runs.size);
  assert.ok(delivered.includes('"/project/image.png"'));
  assert.ok(delivered.includes('Read'));
  assert.deepEqual(session.messages[0].attachments, attachments);
  assert.equal(session.messages[0].text, '请查看附件。');
  await service.close();
});

test('permission rules are only echoed from the original remote suggestions after explicit selection', async () => {
  const service=new ChatService(memoryStore());
  try {
    const session=service.create({host:'axi'});
    const suggestions=[{type:'addRules',rules:[{toolName:'Bash',ruleContent:'pwd'}],behavior:'allow',destination:'localSettings'}];
    const request=()=>service.requestPermission(session,{name:'Bash',input:{command:'pwd'}},{signal:new AbortController().signal,suggestions});
    let pending=request();
    assert.deepEqual(session.permissions[0].suggestions,suggestions);
    service.respond(session.id,session.permissions[0].id,{allow:true});
    assert.equal((await pending).updatedPermissions,undefined);
    pending=request();
    // A renderer-supplied rule is ignored; only the worker's original suggestions are returned.
    service.respond(session.id,session.permissions[0].id,{allow:true,useSuggestedPermissions:true,updatedPermissions:[{type:'setMode',mode:'bypassPermissions'}]});
    assert.deepEqual((await pending).updatedPermissions,suggestions);
    pending=request();
    service.respond(session.id,session.permissions[0].id,{allow:false,reason:'Please inspect the file first.'});
    assert.deepEqual(await pending,{behavior:'deny',message:'Please inspect the file first.'});
  } finally {await service.close();}
});
