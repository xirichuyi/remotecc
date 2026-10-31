const fs = require('node:fs');
const path = require('node:path');
const { shellQuote, createSession } = require('./remote.cjs');
const { connectionKey } = require('./ssh.cjs');
const { Transcript, newAssistant } = require('./transcript.cjs');
const helper = fs.readFileSync(path.join(__dirname, 'remote-history.py'), 'utf8');

function historyMessages(records) {
  const messages = [];
  for (const event of records) {
    const blocks = event.message.content;
    if (event.type === 'user') {
      const previous = messages.at(-1);
      if (previous?.role === 'assistant') new Transcript(previous).toolResults(event);
      const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('\n');
      if (text) messages.push({ id: event.uuid, role: 'user', text, createdAt: Date.parse(event.timestamp) || 0 });
    } else {
      const message = newAssistant(event.uuid);
      message.createdAt = Date.parse(event.timestamp) || 0;
      new Transcript(message).consume(event);
      for (const block of message.blocks) if (block.type === 'tool') block.status = 'history';
      messages.push(message);
    }
  }
  return messages;
}

class RemoteHistory {
  constructor(connections, service) { this.connections = connections; this.service = service; this.pending = new Map(); }
  async run(config, request) {
    const command = 'python3 -c ' + shellQuote(helper) + ' ' + shellQuote(JSON.stringify(request));
    const child = this.connections.spawn(config, 'bash -lc ' + shellQuote(command));
    child.stdin.end();
    let output = '', error = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    const timer = setTimeout(() => { error = '读取历史超时'; child.kill(); }, 60000);
    child.stdout.on('data', data => { output += data; if (output.length > 32 * 1024 * 1024) { error = '历史响应过大'; child.kill(); } });
    child.stderr.on('data', data => { error = (error + data).slice(-4000); });
    try {
      await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(error || '无法读取远端历史'))); });
      return JSON.parse(output);
    } finally { clearTimeout(timer); }
  }
  async discover(config, offset = 0) {
    const result = await this.run(config, { operation: 'list', offset });
    const imported = [];
    const host = connectionKey(config);
    const existing = new Map(this.service.sessions
      .filter(session => !session.forkPending && connectionKey(session) === host)
      .map(session => [session.remoteSessionId, session]));
    for (const item of result.sessions) {
      let session = existing.get(item.sessionId);
      if (!session) {
        session = createSession({ ...config, directory: item.directory || '~', name: item.name.slice(0, 80) || '远端会话' });
        Object.assign(session, { remoteSessionId: item.sessionId, remoteHistoryRef: item.reference, historyLoaded: false,
          historySummary: item.name, remoteProject: item.project, updatedAt: item.updatedAt });
        this.service.sessions.push(session);
        existing.set(item.sessionId, session);
      } else {
        session.remoteHistoryRef = item.reference;
        session.historySummary = item.name;
        if (session.historyLoaded === false) {
          session.updatedAt = item.updatedAt;
          if (!session.localName) session.name = item.name.slice(0, 80) || session.name;
          if (item.directory) session.directory = item.directory;
        }
      }
      imported.push(session);
    }
    this.service.store.save(this.service.sessions);
    return { sessions: imported, nextOffset: result.nextOffset, total: result.total, unreadable: result.unreadable.length };
  }
  load(id, older = false) {
    if (this.pending.has(id)) return this.pending.get(id);
    const task = this.loadPage(id, older).finally(() => this.pending.delete(id));
    this.pending.set(id, task); return task;
  }
  async loadPage(id, older) {
    const session = this.service.get(id);
    if (!session.remoteHistoryRef || (!older && session.historyLoaded !== false)) return session;
    if (this.service.runs.has(id)) throw new Error('请等待当前回复完成后加载历史');
    if (older && !session.historyBefore) return session;
    const page = await this.run(session, { operation: 'messages', reference: session.remoteHistoryRef, ...(older ? { before: session.historyBefore } : {}) });
    if (!page.directory?.startsWith('/')) throw new Error('历史中缺少工作目录，无法安全续接此会话');
    const existingIds = new Set(session.messages.map(message => message.id));
    const messages = historyMessages(page.records).filter(message => !existingIds.has(message.id));
    session.messages = [...messages, ...session.messages];
    Object.assign(session, { directory: page.directory, historyLoaded: true, historyBefore: page.before, historyPreviewLimited: true, historySkipped: page.skippedRecords });
    this.service.changed(session, true);
    return session;
  }
}
module.exports = { RemoteHistory, historyMessages };
