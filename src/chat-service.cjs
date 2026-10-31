const interactionSchema = require('./interaction-schema.js');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { createSession, spawnRemote } = require('./remote.cjs');
const { Transcript, newAssistant } = require('./transcript.cjs');
const { inspectRemote, catalogue, preferencePatch } = require('./capabilities.cjs');

class ChatService extends EventEmitter {
  constructor(store, loadQuery = async () => (await import('@anthropic-ai/claude-agent-sdk')).query) {
    super();
    this.store = store;
    this.loadQuery = loadQuery;
    this.spawn = spawnRemote;
    this.sessions = store.load({ lazy: true });
    this.runs = new Map();
    this.approvals = new Map();
    this.timers = new Map();
    this.inspections = new Map();
    this.capabilityCache = new Map();
    this.capabilityRequests = new Map();
    for (const session of this.sessions) if (session.remoteTask) this.runs.set(session.id, { persistent: true });
  }

  get(id) {
    const session = this.sessions.find(item => item.id === id);
    if (!session) throw new Error('会话不存在');
    this.store.hydrate?.(session);
    return session;
  }

  changed(session, immediate = false) {
    const latest = session.messages.at(-1);
    if (latest) latest.revision = (latest.revision || 0) + 1;
    if (immediate) {
      clearTimeout(this.timers.get(session.id));
      this.timers.delete(session.id);
      this.store.save(this.sessions, session);
      this.emit('changed', session);
    } else if (!this.timers.has(session.id)) {
      this.timers.set(session.id, setTimeout(() => this.changed(session, true), 100));
    }
  }

  create(input) {
    const session = createSession(input);
    this.sessions.unshift(session);
    this.changed(session, true);
    return session;
  }

  rename(id, name) {
    const session = this.get(id);
    if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new Error('名称需为 1–80 个字符');
    session.name = name.trim();
    session.localName = true;
    this.changed(session, true);
  }

  remove(id) {
    if (this.runs.has(id)) throw new Error('请先停止当前回复，再删除对话');
    const session = this.get(id);
    if (session.remoteOwner) return this.persistent.release(session).then(() => this.remove(id));
    this.sessions = this.sessions.filter(item => item.id !== id);
    this.store.save(this.sessions);
  }

  organize(id, patch) {
    const session = this.get(id);
    for (const [key, value] of Object.entries(patch || {})) {
      if (!['pinned', 'archived'].includes(key) || typeof value !== 'boolean') throw new Error('无效会话设置');
      if (key === 'archived' && value && (this.runs.has(id) || session.queue?.length)) throw new Error('请先完成或取消此会话中的任务');
    }
    Object.assign(session, patch);
    this.changed(session, true);
    return session;
  }

  enqueue(id, text, attachments = []) {
    const session = this.get(id);
    if (typeof text !== 'string' || (!text.trim() && !attachments.length) || text.length > 200000) throw new Error('消息不能为空或超过 20 万字符');
    session.queue ||= [];
    if (session.queue.length >= 20) throw new Error('最多排队 20 条消息');
    session.queue.push({ id: randomUUID(), text: text.trim() || '请查看附件。', attachments: structuredClone(attachments), createdAt: Date.now() });
    this.changed(session, true);
    return session;
  }

  cancelQueued(id, itemId) {
    const session = this.get(id);
    const item = session.queue?.find(item => item.id === itemId);
    if (!item) throw new Error('消息已经发送或取消');
    session.queue = session.queue.filter(item => item.id !== itemId);
    this.changed(session, true);
    return item;
  }

  resumeQueue(id) {
    const session = this.get(id);
    session.queuePaused = false;
    this.drainQueue(session);
    this.changed(session, true);
  }

  drainQueue(session) {
    if (this.closing || this.runs.has(session.id) || session.queuePaused || !session.queue?.length) return;
    const item = session.queue.shift();
    try { this.send(session.id, item.text, item.attachments); }
    catch (error) { session.queue.unshift(item); session.queuePaused = true; this.changed(session, true); throw error; }
  }

  async capabilities(id, refresh = false) {
    const session = this.get(id);
    if (this.persistent && session.remoteOwner) {
      session.capabilities = await this.persistent.control(session, 'catalogue');
      this.changed(session, true);
      return session.capabilities;
    }
    const key = JSON.stringify([session.host, session.port || '', session.directory, session.preferences || {}]);
    const cached = this.capabilityCache.get(key);
    if (!refresh && cached && Date.now() - cached.fetchedAt < 300000) {
      if (session.capabilities !== cached) { session.capabilities = cached; this.changed(session, true); }
      return cached;
    }
    if (!this.capabilityRequests.has(key)) {
      const task = inspectRemote(this, session, catalogue).then(result => {
        this.capabilityCache.set(key, result);
        while (this.capabilityCache.size > 128) this.capabilityCache.delete(this.capabilityCache.keys().next().value);
        return result;
      }).finally(() => this.capabilityRequests.delete(key));
      this.capabilityRequests.set(key, task);
    }
    const task = this.capabilityRequests.get(key);
    this.inspections.set(id, task);
    try {
      session.capabilities = await task;
      this.changed(session, true);
      return session.capabilities;
    } finally { this.inspections.delete(id); }
  }

  async selectEffort(id, value) {
    const session = this.get(id);
    if (this.runs.has(id) && !session.remoteOwner) throw new Error('请等待远端会话连接完成');
    const { effort } = preferencePatch({ effort: value === 'auto' ? '' : value });
    const caps = await this.capabilities(id);
    const model = caps.models.find(item => item.value === (session.preferences?.selectedModel || 'default'));
    if (effort && model && !model.supportedEffortLevels?.includes(effort)) throw new Error('当前模型不支持此思考强度');
    if (this.runs.has(id) && !session.remoteOwner) throw new Error('请等待远端会话连接完成');
    if (this.persistent && session.remoteOwner) {
      await this.persistent.control(session, 'effort', effort);
      session.preferences = { ...session.preferences, effort }; this.changed(session, true); return session;
    }
    await inspectRemote(this, session, client => client.applyFlagSettings({ effortLevel: effort || null }));
    return this.configure(id, { effort });
  }

  async selectModel(id, value) {
    const session = this.get(id);
    if (this.runs.has(id) && !session.remoteOwner) throw new Error('请等待远端会话连接完成');
    const { selectedModel } = preferencePatch({ selectedModel: value });
    const caps = await this.capabilities(id);
    if (this.runs.has(id) && !session.remoteOwner) throw new Error('请等待远端会话连接完成');
    if (this.persistent && session.remoteOwner) {
      await this.persistent.control(session, 'model', selectedModel);
      session.preferences = { ...session.preferences, selectedModel }; this.changed(session, true); return session;
    }
    await inspectRemote(this, session, client => client.setModel(selectedModel || undefined));
    const model = caps.models.find(item => item.value === (selectedModel || 'default') || item.resolvedModel === selectedModel);
    const patch = { selectedModel };
    if (model && session.preferences?.effort && !model.supportedEffortLevels?.includes(session.preferences.effort)) patch.effort = '';
    if (model && session.preferences?.fastMode && !model.supportsFastMode) patch.fastMode = false;
    if (model && session.preferences?.permissionMode === 'auto' && !model.supportsAutoMode) patch.permissionMode = 'default';
    return this.configure(id, patch);
  }

  configure(id, patch) {
    const session = this.get(id);
    patch = preferencePatch(patch);
    const defaults = { agent: '', selectedModel: '', effort: '', outputStyle: '', fastMode: false, permissionMode: 'default', additionalDirectories: [] };
    if (session.remoteOwner) patch = Object.fromEntries(Object.entries(patch).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(session.preferences?.[key] ?? defaults[key])));
    const live = session.remoteOwner && Object.keys(patch).every(key => ['selectedModel', 'effort', 'permissionMode', 'fastMode', 'outputStyle'].includes(key));
    if (this.runs.has(id) && !live) throw new Error('请等待当前回复完成后切换设置');
    const next = { ...session.preferences, ...patch };
    if ('agent' in patch && patch.agent !== (session.preferences?.agent || '') && session.messages.length) throw new Error('请在新对话中选择 Agent，已有会话保留原生上下文');
    if (patch.agent && session.capabilities && !session.capabilities.agents?.some(agent => agent.name === patch.agent)) throw new Error('Agent 不在远端列表中，请刷新后选择');
    const model = session.capabilities?.models.find(item => item.value === (next.selectedModel || 'default') || item.resolvedModel === next.selectedModel);
    if (model && next.effort && !model.supportedEffortLevels?.includes(next.effort)) throw new Error('此模型不支持选定的思考强度，请先设为自动');
    if (model && next.fastMode && !model.supportsFastMode) throw new Error('此模型不支持快速模式，请先关闭快速模式');
    if (model && next.permissionMode === 'auto' && !model.supportsAutoMode) throw new Error('此模型不支持自动权限模式');
    if (live && this.persistent) return this.persistent.control(session, 'configure', patch).then(preferences => {
      session.preferences = preferences; this.changed(session, true); return session;
    });
    if (session.remoteOwner && this.persistent) return this.persistent.release(session).then(() => this.configure(id, patch));
    session.preferences = next;
    this.changed(session, true);
    return session;
  }

  fork(id) {
    const source = this.get(id);
    if (this.runs.has(id) || !source.remoteSessionId) throw new Error('请在当前回复完成后分支对话');
    const session = createSession({ ...source, name: source.name.slice(0, 72) + ' · 分支' });
    session.messages = structuredClone(source.messages);
    session.preferences = structuredClone(source.preferences || {});
    session.remoteSessionId = source.remoteSessionId;
    session.forkPending = true;
    session.capabilities = source.capabilities;
    this.sessions.unshift(session);
    this.changed(session, true);
    return session;
  }

  async details(id, section) {
    const session = this.get(id);
    if (section === 'status') return { host: session.host, directory: session.directory, sessionId: session.remoteSessionId,
      model: session.model, preferences: session.preferences || {}, version: session.capabilities?.version, tools: session.tools || [], plugins: session.plugins || [] };
    if (section === 'cost') return session.usage || { message: '尚无用量数据' };
    if (section === 'tasks') return session.tasks || [];
    if (section === 'skills' || section === 'agents') {
      const result = await this.capabilities(id);
      return section === 'skills' ? result.commands.filter(item => !item.builtin) : result.agents;
    }
    if (this.persistent && session.remoteOwner) return this.persistent.control(session, section);
    return inspectRemote(this, session, async client => {
      if (section === 'context') return client.getContextUsage({ detail: 'summary' });
      if (section === 'mcp') return (await client.mcpServerStatus()).map(server => ({ name: server.name, status: server.status, error: server.error,
        tools: server.tools?.map(tool => ({ name: tool.name, description: tool.description })) }));
      if (section === 'plugins') {
        const result = await client.reloadPlugins({ holdOnCacheImpact: true });
        return { plugins: result.plugins || [], errorCount: result.error_count || 0, held: result.held || false };
      }
      throw new Error('未知面板');
    });
  }

  send(id, text, attachments = []) {
    const session = this.get(id);
    if (session.historyLoaded === false) throw new Error('请先加载此远端会话的历史');
    if (this.runs.has(id)) throw new Error('Claude 正在回复，请先停止或等待完成');
    if (typeof text !== 'string' || (!text.trim() && !attachments.length) || text.length > 200000) throw new Error('消息不能为空或超过 20 万字符');
    session.archived = false;
    text = text.trim() || '请查看附件。';
    if (!session.messages.length && session.name === '新对话') session.name = text.trim().slice(0, 28);
    session.messages.push({ id: randomUUID(), role: 'user', text: text.trim(), attachments, createdAt: Date.now() });
    const message = newAssistant(randomUUID());
    session.messages.push(message);
    session.status = 'connecting';
    session.updatedAt = Date.now();
    const run = { stopped: false, stderr: '', message, transcript: new Transcript(message) };
    this.runs.set(id, run);
    this.changed(session, true);
    // The request returns immediately; subsequent state is delivered over IPC.
    const prompt = attachments.length ? text.trim() + '\n\n用户附加的远端文件（已上传或在远端选定，可通过 Read 等工具访问，包括图片）：\n' +
      attachments.map(file => '- ' + JSON.stringify(file.path)).join('\n') : text.trim();
    if (this.persistent) { run.persistent = true; this.persistent.start(session, prompt); }
    else void this.run(session, prompt, run);
    return session;
  }

  options(session, run) {
    const preferences = session.preferences || {};
    const settings = {};
    if (preferences.fastMode !== undefined) settings.fastMode = preferences.fastMode;
    if (preferences.outputStyle) settings.outputStyle = preferences.outputStyle;
    return {
      pathToClaudeCodeExecutable: '/usr/local/bin/claude',
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      ...(preferences.agent ? { agent: preferences.agent } : {}),
      permissionMode: preferences.permissionMode || 'default', includePartialMessages: true,
      ...(preferences.selectedModel ? { model: preferences.selectedModel } : {}),
      ...(preferences.effort ? { effort: preferences.effort } : {}),
      ...(preferences.additionalDirectories?.length ? { additionalDirectories: preferences.additionalDirectories } : {}),
      ...(Object.keys(settings).length ? { settings } : {}),
      ...(session.forkPending ? { forkSession: true } : {}),
      settingSources: ['user', 'project', 'local'],
      ...(session.remoteSessionId ? { resume: session.remoteSessionId } : {}),
      onElicitation: (request, context) => this.requestElicitation(session, request, context),
      canUseTool: (name, input, context) => this.requestPermission(session, { name, input }, context),
      spawnClaudeCodeProcess: options => this.spawn(session, options, data => {
        run.stderr = (run.stderr + data).slice(-6000);
      }),
    };
  }

  async run(session, prompt, run) {
    try {
      if (this.inspections.has(session.id)) await this.inspections.get(session.id).catch(() => {});
      const query = await this.loadQuery();
      if (run.stopped) return;
      run.query = query({ prompt, options: this.options(session, run) });
      for await (const event of run.query) {
        this.consumeEvent(session, event, run);
      }
    } catch (error) {
      if (!run.stopped) run.message.error ||= [error.message, run.stderr.trim()].filter(Boolean).join('\n');
    } finally {
      this.finish(session, run);
    }
  }

  consumeEvent(session, event, run) {
    if (event.session_id && ['system', 'assistant', 'result'].includes(event.type))
      session.remoteSessionId = event.session_id;
    if (event.type === 'system' && event.subtype === 'init') {
      session.model = event.model;
      session.tools = event.tools || [];
      session.plugins = event.plugins || [];
      session.terminalCommands = event.terminal_slash_commands || [];
      run.message.model = event.model;
      if (session.forkPending) delete session.forkPending;
    }
    const responseModel = event.type === 'assistant' ? event.message?.model :
      event.type === 'stream_event' && event.event?.type === 'message_start' ? event.event.message?.model : null;
    if (!event.parent_tool_use_id && responseModel && responseModel !== '<synthetic>') {
      session.model = responseModel; run.message.model = responseModel;
    }
    if (event.type === 'result') session.usage = { totalCostUSD: event.total_cost_usd, models: event.modelUsage, lastTurn: event.usage, durationMs: event.duration_ms };
    if (event.type === 'system' && event.subtype === 'commands_changed' && session.capabilities) session.capabilities.commands = event.commands;
    if (event.type === 'system' && event.task_id) {
      session.tasks ||= [];
      let task = session.tasks.find(item => item.id === event.task_id);
      if (!task) { task = { id: event.task_id }; session.tasks.push(task); }
      Object.assign(task, { description: event.description || task.description, status: event.status || event.patch?.status || task.status || 'running',
        summary: event.summary || task.summary, outputFile: event.output_file || task.outputFile, usage: event.usage || task.usage });
    }
    if (event.type === 'conversation_reset') session.remoteSessionId = event.new_conversation_id;
    if (!run.stopped && session.status !== 'permission') session.status = 'working';
    run.transcript.consume(event);
    this.changed(session);
  }

  finish(session, run, keepQuery = false) {
    for (const permission of [...session.permissions]) this.respond(session.id, permission.id, { allow: false });
    if (!keepQuery) run.query?.close();
    if (run.stopped) run.message.interrupted = true;
    for (const block of run.message.blocks) {
      if (block.type === 'tool' && block.status === 'running') block.status = run.stopped ? 'stopped' : 'done';
    }
    session.status = run.stopped ? 'stopped' : run.message.error ? 'error' : 'idle';
    this.runs.delete(session.id);
    if (run.stopped || run.message.error) session.queuePaused = true;
    this.changed(session, true);
    if (!session.queuePaused && !this.closing) this.drainQueue(session);
  }

  requestElicitation(session, request, context) {
    if (context.signal.aborted || this.runs.get(session.id)?.stopped) return Promise.resolve({ action: 'cancel' });
    const original = structuredClone(request);
    const permission = { id: randomUUID(), kind: 'elicitation', request: structuredClone(original), remoteRequestId: context.requestId };
    return new Promise(resolve => {
      const abort = () => this.respond(session.id, permission.id, { interaction: { action: 'cancel' } });
      this.approvals.set(permission.id, { sessionId: session.id, kind: 'elicitation', request: original, resolve,
        cleanup: () => context.signal.removeEventListener('abort', abort) });
      context.signal.addEventListener('abort', abort, { once: true });
      session.permissions.push(permission);
      session.status = 'permission';
      this.changed(session, true);
    });
  }

  requestPermission(session, tool, context) {
    if (context.signal.aborted || this.runs.get(session.id)?.stopped)
      return Promise.resolve({ behavior: 'deny', message: '用户已停止请求' });
    const permission = { id: randomUUID(), name: tool.name, input: tool.input,
      title: context.title || `Claude 请求使用 ${tool.name}`, description: context.description || '',
      suggestions: structuredClone(context.suggestions || []), blockedPath: context.blockedPath };
    return new Promise(resolve => {
      const abort = () => this.respond(session.id, permission.id, { allow: false });
      this.approvals.set(permission.id, { sessionId: session.id, resolve, input: tool.input, suggestions: structuredClone(permission.suggestions),
        cleanup: () => context.signal.removeEventListener('abort', abort) });
      context.signal.addEventListener('abort', abort, { once: true });
      session.permissions.push(permission);
      session.status = 'permission';
      this.changed(session, true);
    });
  }

  respond(sessionId, permissionId, answer) {
    const target = this.get(sessionId);
    if (this.persistent && target.remoteTask) {
      const permission = target.permissions.find(item => item.id === permissionId);
      if (!permission) throw new Error('该请求已结束');
      if (permission.kind === 'elicitation') answer = { interaction: interactionSchema.answer(permission.request, answer.interaction || { action: 'cancel' }) };
      return this.persistent.command(target, { kind: 'respond', permissionId, answer });
    }
    const approval = this.approvals.get(permissionId);
    if (!approval || approval.sessionId !== sessionId) throw new Error('该请求已结束');
    const session = this.get(sessionId);
    if (approval.kind === 'elicitation') {
      const response = interactionSchema.answer(approval.request, answer.interaction || { action: 'cancel' });
      this.approvals.delete(permissionId); approval.cleanup();
      session.permissions = session.permissions.filter(item => item.id !== permissionId);
      if (session.status === 'permission' && !session.permissions.length) session.status = 'working';
      approval.resolve(response); this.changed(session, true); return;
    }
    const updatedInput = { ...approval.input };
    if (answer.answers && typeof answer.answers === 'object') {
      updatedInput.answers = {};
      for (const [question, value] of Object.entries(answer.answers)) {
        if (typeof value === 'string' && value.length <= 10000) updatedInput.answers[question] = value;
      }
    }
    if (answer.useSuggestedPermissions === true && answer.allow !== true) throw new Error('拒绝操作时不能应用权限规则');
    if (answer.useSuggestedPermissions === true && !approval.suggestions.length) throw new Error('远端未提供权限规则建议');
    this.approvals.delete(permissionId);
    approval.cleanup();
    session.permissions = session.permissions.filter(item => item.id !== permissionId);
    if (session.status === 'permission' && !session.permissions.length) session.status = 'working';
    approval.resolve(answer.allow === true ? { behavior: 'allow', updatedInput,
      ...(answer.useSuggestedPermissions === true ? { updatedPermissions: structuredClone(approval.suggestions) } : {}) } :
      { behavior: 'deny', message: typeof answer.reason === 'string' && answer.reason.trim() ? answer.reason.trim().slice(0, 10000) : '用户拒绝了本次操作，请调整方案。' });
    this.changed(session, true);
  }

  async stop(id) {
    const sessionTarget = this.get(id);
    if (this.persistent && sessionTarget.remoteTask) {
      await this.persistent.command(sessionTarget, { kind: 'stop' });
      return;
    }
    const run = this.runs.get(id);
    if (!run || run.stopped) return;
    run.stopped = true;
    const session = this.get(id);
    session.status = 'stopping';
    for (const permission of [...session.permissions]) this.respond(id, permission.id, { allow: false });
    this.changed(session, true);
    if (!run.query) return;
    const timeout = setTimeout(() => run.query.close(), 3000);
    try { await run.query.interrupt(); } catch { /* A disconnected transport is already stopped. */ }
    finally { clearTimeout(timeout); run.query.close(); }
  }

  async close() {
    this.closing = true;
    for (const client of this.inspectors || []) client.close();
    if (this.persistent) await this.persistent.detach();
    await Promise.allSettled([...this.runs.keys()].filter(id => !this.get(id).remoteTask).map(id => this.stop(id)));
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.store.save(this.sessions);
  }
}
module.exports = { ChatService };
