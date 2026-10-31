const { createSession } = require('./remote.cjs');
const { agentFor } = require('./agent-client.cjs');
const { connectionKey } = require('./ssh.cjs');
const { Transcript, newAssistant } = require('./transcript.cjs');

// The CLI stores slash commands and their output inside XML-like tags.
function userText(text) {
  const command = /<command-name>([^<]*)<\/command-name>/.exec(text);
  if (command) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
    return command[1].trim() + (args ? ' ' + args : '');
  }
  const output = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(text);
  if (output) return output[1].trim();
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '').trim();
}

function historyMessages(records) {
  const messages = [];
  for (const event of records) {
    const blocks = event.message.content;
    if (event.type === 'user') {
      const previous = messages.at(-1);
      if (previous?.role === 'assistant') new Transcript(previous).toolResults(event);
      const text = userText(blocks.filter(block => block.type === 'text').map(block => block.text).join('\n'));
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
  run(config, request) { return agentFor(this.connections).call(config, 'history', request); }
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
