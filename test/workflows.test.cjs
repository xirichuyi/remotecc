const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { ChatService } = require('../src/chat-service.cjs');
const { Transcript, newAssistant } = require('../src/transcript.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ChatStore } = require('../src/store.cjs');
async function until(service, condition) { while (!condition()) await once(service, 'changed'); }
function harness() {
  const calls = [];
  const releases = [];
  const service = new ChatService({ load: () => [], save() {} }, async () => ({ prompt, options }) => {
    calls.push({ prompt, options });
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    releases.push(release);
    const stream = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'shared-context', model: 'test' };
      await pending;
      yield { type: 'result', result: 'OK', is_error: false };
    })();
    stream.close = release; stream.interrupt = async () => release();
    return stream;
  });
  return { service, calls, releases };
}
test('queue sends sequentially in same context, cancellation prevents delivery', async () => {
  const { service, calls, releases } = harness();
  const session = service.create({ host: 'axi' });
  service.send(session.id, 'first');
  await until(service, () => calls.length === 1);
  service.enqueue(session.id, 'second');
  service.enqueue(session.id, 'cancel me');
  service.cancelQueued(session.id, session.queue[1].id);
  assert.throws(() => service.organize(session.id, { archived: true }));
  releases[0]();
  await until(service, () => calls.length === 2);
  assert.equal(calls[1].prompt, 'second');
  assert.equal(calls[1].options.resume, 'shared-context');
  releases[1](); await until(service, () => !service.runs.size);
  assert.equal(calls.length, 2);
  service.organize(session.id, { archived: true, pinned: true });
  assert.equal(session.archived, true);
  assert.equal(session.pinned, true);
  await service.close();
});
test('stop pauses queued messages; explicit resume sends them', async () => {
  const { service, calls, releases } = harness();
  const session = service.create({ host: 'axi' });
  service.send(session.id, 'first'); await until(service, () => calls.length === 1);
  service.enqueue(session.id, 'later');
  await service.stop(session.id); await until(service, () => !service.runs.size);
  assert.equal(calls.length, 1); assert.equal(session.queuePaused, true);
  service.resumeQueue(session.id); await until(service, () => calls.length === 2);
  releases[1](); await until(service, () => !service.runs.size);
  await service.close();
});
test('restart preserves queued attachments and pauses auto-delivery', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'remotecc-queue-test-'));
  const store = new ChatStore(path.join(folder, 'chats.json'));
  try {
    const service = new ChatService(store);
    const session = service.create({ host: 'axi' });
    service.enqueue(session.id, 'read', [{ path: '/tmp/file', name: 'file' }]);
    await service.close();
    const restored = store.load()[0];
    assert.equal(restored.queuePaused, true);
    assert.equal(restored.queue[0].attachments[0].path, '/tmp/file');
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
test('thinking stream and final event render a single thought block', () => {
  const message = newAssistant('a'); const transcript = new Transcript(message);
  transcript.consume({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm' } } });
  transcript.consume({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } });
  transcript.consume({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Reasoning' } } });
  transcript.consume({ type: 'assistant', message: { id: 'm', content: [{ type: 'thinking', thinking: 'Reasoning' }, { type: 'text', text: 'Answer' }] } });
  assert.equal(message.blocks.filter(block => block.type === 'thinking').length, 1);
  assert.equal(message.blocks[0].text, 'Reasoning');
});
