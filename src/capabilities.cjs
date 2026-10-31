class EmptyInput {
  constructor() { this.waiters = []; this.closed = false; }
  [Symbol.asyncIterator]() { return this; }
  next() {
    if (this.closed) return Promise.resolve({ done: true });
    return new Promise(resolve => this.waiters.push(resolve));
  }
  return() { this.close(); return Promise.resolve({ done: true }); }
  close() { this.closed = true; for (const resolve of this.waiters.splice(0)) resolve({ done: true }); }
}

async function inspectRemote(service, session, callback) {
  const running = service.runs.get(session.id)?.query;
  if (running) return callback(running);
  const query = await service.loadQuery();
  const input = new EmptyInput();
  const run = { stderr: '' };
  const options = service.options(session, run);
  options.persistSession = false; // Capability probes must not create history entries.
  options.onElicitation = async () => ({ action: 'cancel' }); // Inspection never parks a hidden interactive request.
  options.canUseTool = async () => ({ behavior: 'deny', message: '仅查询客户端能力' });
  delete options.forkSession;
  delete options.agent; // Discover available definitions even if the previously selected agent was removed.
  const client = query({ prompt: input, options });
  service.inspectors ||= new Set();
  service.inspectors.add(client);
  let timer;
  try {
    return await Promise.race([callback(client), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('读取远端能力超时')), 45000);
    })]);
  } catch (error) { throw new Error([error.message, run.stderr.trim()].filter(Boolean).join('\n')); }
  finally { clearTimeout(timer); input.close(); client.close(); service.inspectors.delete(client); }
}

async function catalogue(client) {
  const [commands, models, agents, init] = await Promise.all([
    client.supportedCommands(), client.supportedModels(), client.supportedAgents(), client.initializationResult(),
  ]);
  return {
    commands,
    models, agents, version: init.claude_code_version || '', outputStyles: init.available_output_styles || [],
    fetchedAt: Date.now(),
  };
}

function preferencePatch(patch) {
  if (!patch || typeof patch !== 'object') throw new Error('无效设置');
  const result = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'agent') {
      if (typeof value !== 'string' || value.length > 200 || /[\x00-\x1f]/.test(value)) throw new Error('无效 Agent 名称');
      result.agent = value;
    } else if (key === 'selectedModel') {
      if (typeof value !== 'string' || (value && !/^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,199}$/.test(value))) throw new Error('无效模型 ID');
      result.selectedModel = value === 'default' ? '' : value;
    } else if (key === 'effort') {
      if (!['', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)) throw new Error('无效思考强度');
      result.effort = value;
    } else if (key === 'permissionMode') {
      if (!['default', 'acceptEdits', 'plan', 'dontAsk', 'auto'].includes(value)) throw new Error('无效权限模式');
      result.permissionMode = value;
    } else if (key === 'fastMode') {
      if (typeof value !== 'boolean') throw new Error('无效快速模式');
      result.fastMode = value;
    } else if (key === 'additionalDirectories') {
      if (!Array.isArray(value) || value.length > 20 || value.some(folder => typeof folder !== 'string' || !folder.startsWith('/') || /[\x00-\x1f]/.test(folder))) throw new Error('额外目录必须为远端绝对路径，最多 20 个');
      result.additionalDirectories = [...new Set(value)];
    } else if (key === 'outputStyle') {
      if (typeof value !== 'string' || value.length > 120 || /[\x00-\x1f]/.test(value)) throw new Error('无效输出样式');
      result.outputStyle = value;
    } else throw new Error('未知设置：' + key);
  }
  return result;
}

module.exports = { inspectRemote, catalogue, preferencePatch, EmptyInput };
