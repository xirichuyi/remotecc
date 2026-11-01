const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { historyOperations } = require('../src/remote-agent.cjs');
const { randomUUID } = require('node:crypto');
const { RemoteHistory, historyMessages } = require('../src/history.cjs');
const { ChatService } = require('../src/chat-service.cjs');
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remotecc-history-unit-'));
  const project = path.join(root, 'projects', '-tmp-test'); fs.mkdirSync(project, { recursive: true });
  const id = randomUUID(); const file = path.join(project, id + '.jsonl');
  const call = async request => {
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = root;
    try { return await historyOperations[request.operation](request); }
    finally { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; }
  };
  return { root, file, reference: '-tmp-test/' + id + '.jsonl', call };
}
test('listing exposes metadata only; messages follow active branch and paginate without duplication', async () => {
  const f = fixture();
  try {
    const rows = [];
    let parent = null;
    for (let index = 0; index < 65; index++) {
      const uuid = randomUUID();
      rows.push({ type: index % 2 ? 'assistant' : 'user', uuid, parentUuid: parent, cwd: '/tmp/test', timestamp: new Date().toISOString(), message: { content: 'message-' + index } });
      parent = uuid;
    }
    const abandoned = randomUUID();
    rows.push({ type: 'user', uuid: abandoned, parentUuid: parent, cwd: '/tmp/test', message: { content: 'abandoned branch' } });
    rows.push({ type: 'user', uuid: randomUUID(), parentUuid: parent, cwd: '/tmp/test', message: { content: 'active branch' } });
    rows.push({ type: 'custom-title', customTitle: 'remote title' });
    fs.writeFileSync(f.file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const list = await f.call({ operation: 'list' });
    assert.equal(list.sessions.length, 1); assert.equal(list.sessions[0].name, 'remote title');
    assert.equal(list.sessions[0].messages, undefined);
    const page = await f.call({ operation: 'messages', reference: f.reference });
    assert.equal(page.records.length, 50);
    assert.equal(page.records.at(-1).message.content[0].text, 'active branch');
    assert.ok(!page.records.some(row => row.uuid === abandoned));
    const earlier = await f.call({ operation: 'messages', reference: f.reference, before: page.before });
    assert.equal(earlier.records.length, 16); assert.equal(earlier.before, null);
    assert.equal(new Set([...earlier.records, ...page.records].map(row => row.uuid)).size, 66);
    await assert.rejects(() => f.call({ operation: 'messages', reference: '../' + f.reference.split('/')[1] }));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
test('discovery deduplicates host/session and does not load transcript until selected', async () => {
  const service = new ChatService({ load: () => [], save() {} });
  const history = new RemoteHistory(null, service);
  const requests = [];
  history.run = async (_config, request) => {
    requests.push(request.operation);
    if (request.operation === 'list') return { sessions: [{ sessionId: 'remote-id', reference: 'project/session.jsonl', name: 'remote title', directory: '/tmp/project', updatedAt: 10 }], nextOffset: null, total: 1, unreadable: [] };
    return { directory: '/tmp/project', before: null, records: [{ type: 'user', uuid: 'u1', message: { content: [{ type: 'text', text: 'hello' }] } }] };
  };
  await history.discover({ host: 'axi' }); await history.discover({ host: 'axi' });
  assert.equal(service.sessions.length, 1);
  const session = service.sessions[0];
  assert.equal(session.historyLoaded, false); assert.deepEqual(session.messages, []);
  assert.throws(() => service.send(session.id, 'continue'), /加载/);
  await history.load(session.id);
  assert.deepEqual(requests, ['list', 'list', 'messages']);
  assert.equal(session.remoteSessionId, 'remote-id'); assert.equal(session.messages[0].text, 'hello');
  await service.close();
});
test('history tool results attach to assistant without turning tool output into user text', () => {
  const messages = historyMessages([
    { type: 'assistant', uuid: 'a', message: { id: 'a', content: [{ type: 'tool_use', id: 'tool', name: 'Read', input: {} }] } },
    { type: 'user', uuid: 'r', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'result' }] } },
  ]);
  assert.equal(messages.length, 1); assert.equal(messages[0].blocks[0].output, 'result');
});

test('persistent history index handles append, incomplete lines and rewritten files', async () => {
  const f = fixture();
  try {
    const row = (id,parent,text)=>({type:'user',uuid:id,parentUuid:parent,cwd:'/tmp/test',message:{content:text}});
    fs.writeFileSync(f.file,JSON.stringify(row('first',null,'one'))+'\n');
    assert.equal((await f.call({operation:'messages',reference:f.reference})).records.length,1);
    const append=JSON.stringify(row('second','first','two'));
    fs.appendFileSync(f.file,append.slice(0,20));
    assert.equal((await f.call({operation:'messages',reference:f.reference})).records.length,1);
    fs.appendFileSync(f.file,append.slice(20)+'\n');
    assert.equal((await f.call({operation:'messages',reference:f.reference})).records.length,2);
    fs.writeFileSync(f.file,JSON.stringify(row('new',null,'replacement'))+'\n');
    const page=await f.call({operation:'messages',reference:f.reference});
    assert.deepEqual(page.records.map(item=>item.uuid),['new']);
  } finally {fs.rmSync(f.root,{recursive:true,force:true});}
});

test('list cursor uses a stable snapshot while new sessions arrive', async () => {
  const f=fixture();
  try {
    for(let i=0;i<205;i++) fs.writeFileSync(path.join(path.dirname(f.file),randomUUID()+'.jsonl'),JSON.stringify({type:'user',cwd:'/tmp/test',message:{content:'session '+i}})+'\n');
    const first=await f.call({operation:'list'});
    assert.equal(first.sessions.length,200);
    fs.writeFileSync(f.file,JSON.stringify({type:'user',cwd:'/tmp/test',message:{content:'newcomer'}})+'\n');
    const second=await f.call({operation:'list',offset:first.nextOffset});
    assert.equal(second.total,205);
    assert.equal(new Set([...first.sessions,...second.sessions].map(item=>item.sessionId)).size,205);
    assert.equal((await f.call({operation:'list'})).total,206);
  } finally {fs.rmSync(f.root,{recursive:true,force:true});}
});

test('history preserves real API failure markers through agent and transcript conversion', async () => {
  const f = fixture();
  try {
    const row = { type: 'assistant', uuid: randomUUID(), parentUuid: null, cwd: '/tmp/test', isApiErrorMessage: true, error: 'rate_limit', message: { content: [{ type: 'text', text: 'Usage limit reached' }] } };
    fs.writeFileSync(f.file, JSON.stringify(row) + '\n');
    const page = await f.call({ operation: 'messages', reference: f.reference });
    assert.equal(page.records[0].isApiErrorMessage, true);
    assert.equal(historyMessages(page.records)[0].error, 'Usage limit reached');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
