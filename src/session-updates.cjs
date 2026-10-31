// Keep historical messages out of repeated IPC updates. A renderer can request a
// full session if it missed the initial snapshot (for example after a reload).
class SessionUpdates {
  constructor() { this.previous = new Map(); }
  packet(session) {
    const prior = this.previous.get(session.id) || new Map();
    const next = new Map();
    const changedMessages = [];
    for (const message of session.messages) {
      const old = prior.get(message.id);
      if (!old || old.message !== message || old.revision !== message.revision) changedMessages.push(message);
      next.set(message.id, { message, revision: message.revision });
    }
    this.previous.delete(session.id);
    this.previous.set(session.id, next);
    while (this.previous.size > 128) this.previous.delete(this.previous.keys().next().value);
    const { messages, ...metadata } = session;
    return { ...metadata, localMessagesLoaded: true, changedMessages, messageIds: messages.map(message => message.id) };
  }
}
module.exports = { SessionUpdates };
