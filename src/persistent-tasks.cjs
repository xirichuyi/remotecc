const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { gzipSync } = require('node:zlib');
const { applyStateDelta } = require('./state-delta.cjs');
const { connectionKey } = require('./ssh.cjs');
const { agentFor } = require('./agent-client.cjs');

function taskBundle() {
  const files = {};
  for (const name of ['checkpoint-control.cjs', 'task-worker.cjs', 'task-inspect.cjs', 'chat-service.cjs', 'remote.cjs', 'transcript.cjs', 'capabilities.cjs', 'interaction-schema.js', 'session-input.cjs'])
    files[name] = fs.readFileSync(path.join(__dirname, name), 'utf8');
  files['sdk.mjs'] = fs.readFileSync(require.resolve('@anthropic-ai/claude-agent-sdk'), 'utf8');
  const data = Buffer.from(JSON.stringify(files));
  return { digest: createHash('sha256').update(data).digest('hex'), payload: gzipSync(data).toString('base64') };
}

class PersistentTasks {
  constructor(connections, service) {
    this.connections = connections;
    this.service = service;
    this.bundle = taskBundle();
    this.installs = new Map();
    this.watchers = new Map();
    this.pending = new Map();
  }

  call(session, request) { return agentFor(this.connections).call(session, 'task', request); }

  async install(session) {
    const key = connectionKey(session);
    if (!this.installs.has(key)) this.installs.set(key, (async () => {
      const status = await this.call(session, { operation: 'installed', digest: this.bundle.digest });
      if (!status.installed) await this.call(session, { operation: 'install', ...this.bundle });
    })().catch(error => { this.installs.delete(key); throw error; }));
    await this.installs.get(key);
  }

  start(session, prompt) {
    // Persist identity and request before dispatch: uncertain ACKs reuse this exact task ID.
    session.remoteTask = { id: session.remoteOwner?.id || randomUUID(), prompt, version: -1, submitted: false, messageId: session.messages.at(-1).id, continuation: !!session.remoteOwner };
    if (session.remoteOwner) {
      void this.continueTurn(session).catch(error => this.dispatchFailed(session, error));
      return;
    }
    this.service.changed(session, true);
    void this.attach(session);
  }

  dispatchFailed(session, error) {
    if (!error.confirmed) { this.detached(session, error.message); return; }
    if (!session.remoteTask) return;
    const message = session.messages.find(item => item.id === session.remoteTask.messageId);
    if (message) message.error = error.message;
    delete session.remoteTask; this.service.runs.delete(session.id);
    session.status = 'error'; session.queuePaused = true; this.service.changed(session, true);
  }

  async continueTurn(session) {
    const task = session.remoteTask;
    this.service.changed(session, true);
    await this.attach(session);
    await this.command(session, { kind: 'send', prompt: task.prompt, message: session.messages.find(item => item.id === task.messageId) }, task.messageId);
    task.submitted = true;
    this.service.changed(session, true);
  }

  attach(session) {
    this.service.store.hydrate?.(session);
    if (this.pending.has(session.id)) return this.pending.get(session.id);
    const task = this.attachOnce(session).catch(error => this.detached(session, error.message))
      .finally(() => this.pending.delete(session.id));
    this.pending.set(session.id, task);
    return task;
  }

  async attachOnce(session) {
    if ((!session.remoteTask && !session.remoteOwner) || this.watchers.has(session.id)) return;
    if (session.remoteTask) this.service.runs.set(session.id, { persistent: true });
    await this.install(session);
    const task = session.remoteTask || session.remoteOwner;
    // start is idempotent, and also resolves a worker crash without re-executing Claude.
    await this.call(session, { operation: 'start', taskId: task.id, digest: this.bundle.digest, request: {
      session: { ...session, messages: [session.messages.find(message => message.id === task.messageId) || session.messages.at(-1)],
        remoteTask: undefined, remoteOwner: undefined, capabilities: undefined, queue: [], permissions: [] }, prompt: task.prompt,
    } });
    if (!task.continuation) task.submitted = true;
    delete session.transportError;
    this.service.changed(session, true);
    this.watch(session);
  }

  watch(session) {
    const taskId = (session.remoteOwner || session.remoteTask).id;
    let previous = null, error = '';
    const entry = { kill() { this.killed = true; this.subscription?.kill(); } };
    this.watchers.set(session.id, entry);
    const ended = reason => {
      if (this.watchers.get(session.id) !== entry) return;
      this.watchers.delete(session.id);
      if ((session.remoteOwner || session.remoteTask)?.id === taskId) this.detached(session, error || reason);
    };
    const packet = value => {
      if (this.watchers.get(session.id) !== entry || (session.remoteOwner || session.remoteTask)?.id !== taskId) return;
      try { if (!value.heartbeat) { previous = applyStateDelta(previous, value); this.apply(session, previous); } }
      catch (failure) { error = failure.message; entry.kill(); ended(error); }
    };
    return agentFor(this.connections).subscribe(session, { taskId }, packet, ended).then(subscription => {
      entry.subscription = subscription;
      if (entry.killed) subscription.kill();
    }, failure => ended(failure.message));
  }

  apply(session, state) {
    const task = session.remoteTask;
    const owner = session.remoteOwner || task;
    if (!owner || state.version < (owner.version ?? -1)) return;
    // A queued new turn must not be overwritten by the previous turn's idle snapshot.
    if (task && state.message.id !== task.messageId) {
      if (state.done) {
        const message = session.messages.find(item => item.id === task.messageId);
        if (message) message.error = '远端会话已退出，新消息未执行。请重新发送。';
        session.status = 'error'; session.queuePaused = true;
        delete session.remoteTask; delete session.remoteOwner; this.service.runs.delete(session.id);
        this.watchers.get(session.id)?.kill(); this.watchers.delete(session.id);
        this.service.changed(session, true);
      }
      return;
    }
    const index = session.messages.findIndex(message => message.id === state.message.id);
    if (index < 0) throw new Error('远端任务与本地消息不匹配');
    session.messages[index] = { ...state.message, revision: state.version };
    for (const key of ['status', 'permissions', 'remoteSessionId', 'model', 'preferences', 'capabilities', 'tools', 'plugins', 'terminalCommands', 'usage', 'tasks', 'forkPending'])
      if (key in state) session[key] = state[key];
    owner.version = state.version;
    if (state.resident && !state.done) session.remoteOwner = { id: owner.id, version: state.version, messageId: state.message.id };
    const turnEnded = state.done || ['idle', 'stopped', 'error'].includes(state.status);
    if (turnEnded) {
      delete session.remoteTask;
      this.service.runs.delete(session.id);
      if (state.status !== 'idle') session.queuePaused = true;
    }
    if (state.done) {
      this.watchers.get(session.id)?.kill(); this.watchers.delete(session.id);
      delete session.remoteOwner;
      void this.call(session, { operation: 'acknowledge', taskId: owner.id }).catch(() => {});
    }
    delete session.transportError;
    if (!turnEnded && this.service.store.saveLater) {
      this.service.store.saveLater(this.service.sessions, session); this.service.emit('changed', session);
    } else this.service.changed(session, true);
    if (turnEnded && task && !this.service.closing && !session.queuePaused) this.service.drainQueue(session);
  }

  detached(session, error = '') {
    if (!session.remoteTask && !session.remoteOwner) return;
    if (session.remoteTask) session.status = 'detached';
    session.transportError = error;
    session.queuePaused = true;
    this.service.changed(session, true);
  }

  async command(session, command, commandId = randomUUID()) {
    const owner = session.remoteOwner || session.remoteTask;
    if (!owner) throw new Error('远端会话已经结束');
    const response = await this.call(session, { operation: 'command', taskId: owner.id, commandId, command,
      wait: !!session.remoteOwner || command.kind === 'control' || command.kind === 'send' });
    if (response.ok === false) { const error = new Error(response.error); error.confirmed = !response.uncertain; throw error; }
    return response.value;
  }

  async control(session, action, value) {
    await this.attach(session);
    return this.command(session, { kind: 'control', action, value });
  }

  async release(session) {
    if (!session.remoteOwner) return;
    if (session.remoteTask) throw new Error('请等待当前回复完成');
    await this.command(session, { kind: 'close' });
    this.watchers.get(session.id)?.kill(); this.watchers.delete(session.id);
    delete session.remoteOwner;
    this.service.changed(session, true);
  }

  async restore(config) {
    await Promise.all(this.service.sessions.filter(session => (session.remoteTask || session.remoteOwner) && connectionKey(session) === connectionKey(config))
      .map(session => session.remoteTask?.continuation && !session.remoteTask.submitted ? this.continueTurn(session).catch(error => this.dispatchFailed(session, error)) : this.attach(session)));
  }

  async detach(config) {
    // Wait for dispatch to settle before closing SSH; uncertain outcomes stay recoverable.
    await Promise.all([...this.pending.values()]);
    for (const session of this.service.sessions) {
      if ((!session.remoteTask && !session.remoteOwner) || (config && connectionKey(session) !== connectionKey(config))) continue;
      this.watchers.get(session.id)?.kill();
      this.watchers.delete(session.id);
      this.detached(session);
    }
  }
}
module.exports = { PersistentTasks, taskBundle };
