// Test-only app entry. Production packaging excludes scripts/ entirely.
const { ChatService } = require('../src/chat-service.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let sequence = 0;
function fakeQuery({ prompt, options }) {
  let closed = false;
  const controller = new AbortController();
  const number = ++sequence;
  const stream = (async function* () {
    yield { type: 'system', subtype: 'init', session_id: 'test-remote-session', model: 'Claude · test fixture' };
    if (prompt === 'elicitation-test') {
      const responses = [];
      const requests = [
        {message:'Form test',requestedSchema:{type:'object',properties:{name:{type:'string',minLength:2},count:{type:'integer',minimum:1,maximum:4},enabled:{type:'boolean'},tags:{type:'array',items:{type:'string',enum:['a','b']},minItems:1}},required:['name','count','enabled','tags']}},
        {message:'URL test',mode:'url',url:'https://example.com/authorize'},
        {message:'Unsupported test',requestedSchema:{type:'object',properties:{nested:{type:'object'}}}},
      ];
      for (const request of requests) responses.push(await options.onElicitation({serverName:'fixture',...request},{signal:controller.signal,requestId:String(responses.length)}));
      const text = JSON.stringify(responses);
      yield {type:'assistant',message:{id:'elicitation-result',content:[{type:'text',text}]}};
      yield {type:'result',result:text,is_error:false};
      return;
    }
    if (prompt === 'stop-test') {
      yield { type: 'assistant', message: { id: 'partial', content: [{ type: 'text', text: '这是一条尚未完成的回复。' }] } };
      while (!closed) await pause(50);
      return;
    }
    const id = 'model-' + number;
    yield { type: 'stream_event', event: { type: 'message_start', message: { id } } };
    yield { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } };
    const intro = '可以。我会先查看项目结构，再给出具体建议。\n\n';
    for (const text of [intro.slice(0, 7), intro.slice(7)]) {
      await pause(150);
      yield { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } };
    }
    yield { type: 'assistant', message: { id, content: [{ type: 'text', text: intro }, { type: 'tool_use', id: 'tool-' + number, name: 'Bash', input: { command: 'ls -la', description: '查看当前项目目录' } }] } };
    const decision = await options.canUseTool('Bash', { command: 'ls -la', description: '查看当前项目目录' }, { signal: controller.signal, suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls -la' }], behavior: 'allow', destination: 'localSettings' }] });
    if (closed) return;
    yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-' + number, content: decision.behavior === 'allow' ? 'src/  package.json  README.md' : '用户拒绝本次操作', is_error: decision.behavior !== 'allow' }] } };
    const text = '### 我们可以从这三个部分开始\n\n1. **消息界面**：以对话方式查看回复与执行过程。\n2. **远端连接**：通过 SSH 调用服务器上的 Claude。\n3. **会话历史**：保留上下文，继续上一次的讨论。\n\n```javascript\nconst message = await remote.send("你好，Claude");\nconsole.log(message);\n```\n\n你可以继续描述想实现的功能。';
    yield { type: 'assistant', message: { id: id + '-final', content: [{ type: 'text', text }] } };
    yield { type: 'result', result: text, is_error: false, duration_ms: 900 };
  })();
  stream.interrupt = async () => { closed = true; controller.abort(); };
  stream.close = () => { closed = true; controller.abort(); };
  stream.supportedCommands = async () => [{ name: 'compact', description: '压缩上下文', builtin: true }];
  stream.supportedModels = async () => [{ value: 'sonnet', displayName: 'Sonnet', supportedEffortLevels: ['low', 'medium', 'high'] }];
  stream.supportedAgents = async () => [{name:'fixture-agent',description:'Remote fixture agent'}];
  stream.initializationResult = async () => ({ available_output_styles: ['default'] });
  return stream;
}
require.cache[require.resolve('../src/chat-service.cjs')].exports.ChatService = class extends ChatService {
  constructor(store) { super(store, async () => fakeQuery); }
};
const { EventEmitter } = require('node:events');
const { RemoteFiles } = require('../src/files.cjs');
require.cache[require.resolve('../src/ssh.cjs')] ||= { exports: {} };
require.cache[require.resolve('../src/ssh.cjs')].exports = {
  connectionKey: input => input.host,
  SSHConnections: class extends EventEmitter {
    constructor() { super(); this.connected = false; }
    state(input) { return { host: input.host, status: this.connected ? 'connected' : 'disconnected' }; }
    async connect(input) { this.connected = true; return this.state(input); }
    async disconnect() { this.connected = false; }
    async close() {}
  }
};
require.cache[require.resolve('../src/files.cjs')].exports.RemoteFiles = class extends RemoteFiles {
  async run(_session, request) {
    if (request.operation === 'hello') return { home: '/workspace', hostname: 'test' };
    if (request.operation === 'list') return { path: '/workspace', parent: '/', entries: [], truncated: false };
    throw new Error('Not part of the chat UI fixture');
  }
};
require.cache[require.resolve('../src/history.cjs')] = { exports: { RemoteHistory: class { async discover() { return { sessions: [], nextOffset: null, total: 0, unreadable: 0 }; } } } };
const persistentModule = require('../src/persistent-tasks.cjs');
persistentModule.PersistentTasks = class {
  constructor(_connections, service) { this.service = service; }
  start(session, prompt) { void this.service.run(session, prompt, this.service.runs.get(session.id)); }
  async restore() {}
  async detach() {}
};
require('../src/main.cjs');
