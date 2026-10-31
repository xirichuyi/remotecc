class RequestScheduler {
  constructor(limit = 4) { this.limit = limit; this.hosts = new Map(); }
  run(host, operation, signal, priority = 0) {
    if (signal?.aborted) return Promise.reject(new Error('请求已取消'));
    let state = this.hosts.get(host);
    if (!state) { state = { running: 0, queue: [] }; this.hosts.set(host, state); }
    if (state.queue.length >= 64) return Promise.reject(new Error('文件请求过多，请稍后重试'));
    return new Promise((resolve, reject) => {
      const item = { operation, resolve, reject, signal, priority };
      item.abort = () => {
        const index = state.queue.indexOf(item);
        if (index >= 0) { state.queue.splice(index, 1); reject(new Error('请求已取消')); }
      };
      signal?.addEventListener('abort', item.abort, { once: true });
      state.queue.push(item);
      state.queue.sort((a, b) => b.priority - a.priority);
      this.drain(host, state);
    });
  }
  drain(host, state) {
    while (state.running < this.limit && state.queue.length) {
      const item = state.queue.shift();
      item.signal?.removeEventListener('abort', item.abort);
      state.running++;
      Promise.resolve().then(item.operation).then(item.resolve, item.reject).finally(() => {
        state.running--;
        this.drain(host, state);
      });
    }
    if (!state.running && !state.queue.length) this.hosts.delete(host);
  }
}
module.exports = { RequestScheduler };
