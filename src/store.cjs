const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { validateSession } = require('./remote.cjs');

class ChatStore {
  constructor(file) {
    this.file = file;
    this.directory = file + '.sessions';
    this.saved = new Map();
    this.index = null;
    this.pending = new Map();
  }
  sessionFile(id) { return path.join(this.directory, createHash('sha256').update(id).digest('hex') + '.json'); }
  atomic(file, text) {
    fs.writeFileSync(file + '.tmp', text, { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  }
  metadata(session) {
    const { messages, ...metadata } = session;
    return { ...metadata, messages: [], messageCount: session.localMessagesLoaded === false ? session.messageCount : messages.length, localMessagesLoaded: false };
  }
  hydrate(session) {
    if (session.localMessagesLoaded !== false) return session;
    const text = fs.readFileSync(this.sessionFile(session.id), 'utf8');
    const data = JSON.parse(text);
    if (!Array.isArray(data.messages)) throw new Error('聊天记录损坏');
    this.saved.set(session.id, text);
    Object.assign(session, data, { ...session, messages: data.messages, localMessagesLoaded: true });
    if (session.status === 'stopped' && session.messages.at(-1)?.role === 'assistant') session.messages.at(-1).interrupted = true;
    return session;
  }
  load({ lazy = false } = {}) {
    if (!fs.existsSync(this.file)) return [];
    const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    let sessions;
    if (Array.isArray(data)) { sessions = data; this.legacy = true; } // Legacy data remains intact until the first successful save.
    else if (data?.version === 2 && Array.isArray(data.ids)) {
      this.index = JSON.stringify(data);
      sessions = data.ids.map(id => {
        const text = fs.readFileSync(this.sessionFile(id), 'utf8');
        this.saved.set(id, text);
        return JSON.parse(text);
      });
    } else if (data?.version === 3 && Array.isArray(data.sessions)) {
      this.index = JSON.stringify(data);
      sessions = data.sessions;
      if (!lazy) sessions.forEach(session => this.hydrate(session));
    } else throw new Error('聊天记录格式不正确');
    this.knownIds = new Set(sessions.map(session => session.id));
    for (const session of sessions) {
      validateSession(session);
      if (!Array.isArray(session.messages) || typeof session.id !== 'string') throw new Error('聊天记录损坏');
      if (session.remoteTask) { session.status = 'detached'; session.queuePaused = true; }
      else if (['connecting', 'working', 'permission', 'stopping'].includes(session.status)) {
        const message = session.messages.at(-1);
        if (message?.role === 'assistant') message.interrupted = true;
        session.status = 'stopped';
      }
      session.permissions = [];
      if (session.queue?.length) session.queuePaused = true;
    }
    return sessions;
  }
  saveLater(sessions, session) {
    this.pending.set(session.id, session);
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.save(sessions, null); }, 1000);
  }
  save(sessions, changed) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const ids = new Set(sessions.map(session => session.id));
    const updates = !this.index || changed === undefined ? sessions : [...this.pending.values(), ...(changed ? [changed] : [])];
    for (const session of updates) {
      if (!ids.has(session.id) || session.localMessagesLoaded === false) continue;
      const text = JSON.stringify(session);
      if (this.saved.get(session.id) !== text) {
        this.atomic(this.sessionFile(session.id), text);
        this.saved.set(session.id, text);
      }
    }
    const index = JSON.stringify({ version: 3, sessions: sessions.map(session => this.metadata(session)) });
    if (index !== this.index) {
      if (this.legacy && !fs.existsSync(this.file + '.legacy')) fs.copyFileSync(this.file, this.file + '.legacy', fs.constants.COPYFILE_EXCL);
      this.atomic(this.file, index);
      this.legacy = false;
      this.index = index;
    }
    for (const id of this.knownIds || this.saved.keys()) if (!ids.has(id)) {
      fs.rmSync(this.sessionFile(id), { force: true }); this.saved.delete(id);
    }
    this.knownIds = ids;
    clearTimeout(this.timer); this.timer = null; this.pending.clear();
  }
}
module.exports = { ChatStore };
