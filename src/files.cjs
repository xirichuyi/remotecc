const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { AsyncLocalStorage } = require('node:async_hooks');
const { RequestScheduler } = require('./request-scheduler.cjs');
const { FileCache } = require('./file-cache.cjs');
const { randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { shellQuote } = require('./remote.cjs');
const helper = fs.readFileSync(path.join(__dirname, 'remote-files.py'), 'utf8');

class RemoteFiles {
  constructor(connections, progress = () => {}, cacheDirectory = path.join(os.tmpdir(), 'remotecc-file-cache')) {
    this.connections = connections;
    this.scheduler = new RequestScheduler();
    this.context = new AsyncLocalStorage();
    this.latestRequests = new Map();
    this.progress = progress;
    this.attachments = new Map();
    this.cache = new FileCache(cacheDirectory);
    this.listings = new Map(); this.previews = new Map(); this.requests = new Map(); this.epoch = 0;
  }

  cancel(kind) { this.latestRequests.get(kind)?.abort(); this.latestRequests.delete(kind); }
  latest(kind, operation) {
    this.cancel(kind);
    const controller = new AbortController();
    this.latestRequests.set(kind, controller);
    return this.context.run({ signal: controller.signal, id: randomUUID() }, async () => {
      try { return await operation(); }
      finally { if (this.latestRequests.get(kind) === controller) this.latestRequests.delete(kind); }
    });
  }
  run(session, request, transfer = {}) {
    const signal = this.context.getStore()?.signal;
    const host = JSON.stringify([session.host, session.port || '']);
    const priority = ['save', 'upload'].includes(request.operation) ? 1 : 0;
    return this.scheduler.run(host, () => this.execute(session, request, transfer, signal), signal, priority);
  }
  async execute(session, request, transfer = {}, signal) {
    if (signal?.aborted) throw new Error('请求已取消');
    const command = 'python3 -c ' + shellQuote(helper) + ' ' + shellQuote(JSON.stringify({ base: session.directory, ...request }));
    const child = this.connections.spawn(session, command);
    const cancel = () => child.kill();
    signal?.addEventListener('abort', cancel, { once: true });
    let stderr = '';
    let output = '';
    let timedOut = false;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-8000); });
    const timeout = setTimeout(() => { timedOut = true; child.kill(); }, transfer.input || transfer.output ? 15 * 60000 : 45000);
    const ended = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error(timedOut ? '传输超时' : stderr.trim() || 'SSH 文件操作失败')));
    });
    let bytes = 0;
    let last = 0;
    const counter = new Transform({ transform: (chunk, _encoding, done) => {
      bytes += chunk.length;
      if (Date.now() - last > 150) {
        this.progress({ sessionId: session.id, name: transfer.name, direction: transfer.input ? 'upload' : 'download', bytes, total: transfer.size });
        last = Date.now();
      }
      done(null, chunk);
    } });
    const jobs = [ended];
    if (transfer.input) jobs.push(pipeline(fs.createReadStream(transfer.input), counter, child.stdin));
    else if (transfer.data !== undefined) {
      jobs.push(new Promise((resolve, reject) => { child.stdin.on('error', reject); child.stdin.end(transfer.data, resolve); }));
    } else child.stdin.end();
    if (transfer.output) jobs.push(pipeline(child.stdout, counter, fs.createWriteStream(transfer.output, { flags: 'wx', mode: 0o600 })));
    else {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', data => {
        output += data;
        if (output.length > 32 * 1024 * 1024) { stderr = '返回数据超过限制'; child.kill(); }
      });
    }
    try {
      await Promise.all(jobs);
      if (transfer.name) this.progress({ sessionId: session.id, name: transfer.name, done: true, bytes, total: transfer.size });
      return transfer.output ? null : JSON.parse(output);
    } catch (error) {
      child.kill();
      await Promise.allSettled(jobs);
      if (transfer.name) this.progress({ sessionId: session.id, name: transfer.name, error: stderr.trim() || error.message });
      throw new Error(stderr.trim() || error.message);
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); }
  }

  key(session, file) { return JSON.stringify([session.host, session.port || '', session.directory, file]); }
  invalidate() { this.epoch++; this.listings.clear(); this.previews.clear(); }
  remember(map, key, value) {
    map.delete(key); map.set(key, value);
    while (map.size > 128) map.delete(map.keys().next().value);
  }
  once(key, operation) {
    const requestKey = this.epoch + ':' + (this.context.getStore()?.id || '') + ':' + key;
    if (!this.requests.has(requestKey)) this.requests.set(requestKey, operation().finally(() => this.requests.delete(requestKey)));
    return this.requests.get(requestKey);
  }
  async list(session, folder, hidden = false, force = false) {
    if (force) this.epoch++;
    const key = this.key(session, folder) + hidden;
    const cached = this.listings.get(key);
    if (!force && cached && Date.now() - cached.time < 3000) return cached.value;
    const epoch = this.epoch;
    return this.once('list:' + key + force, async () => {
      const value = await this.run(session, { operation: 'list', path: folder, hidden });
      if (epoch === this.epoch) this.remember(this.listings, key, { value, time: Date.now() });
      return value;
    });
  }
  async preview(session, file) {
    const key = this.key(session, file), epoch = this.epoch;
    return this.once('preview:' + key, async () => {
      const previous = this.previews.get(key) || await this.cache.readJSON('preview:' + key);
      let info = await this.run(session, { operation: 'preview', path: file, metadataOnly: true, knownVersion: previous?.version });
      if (info.notModified) info = previous;
      if (epoch === this.epoch) {
        this.remember(this.previews, key, info);
        if (!previous || previous.version !== info.version) await this.cache.put('preview:' + key, JSON.stringify(info));
      }
      if (info.kind === 'image' || info.kind === 'pdf') {
        return this.cache.withLease(this.contentKey(session, info), async () => {
          const local = await this.cachedFile(session, info);
          return { ...info, data: await fs.promises.readFile(local) };
        });
      }
      if (info.kind === 'text' && !info.truncated) {
        const contentKey = this.contentKey(session, info);
        if (!await this.cache.get(contentKey)) await this.cache.put(contentKey, Buffer.from(info.text));
      }
      return info;
    });
  }
  async save(session, file, text, revision) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024 || !/^[a-f0-9]{64}$/.test(revision)) throw new Error('无效编辑内容或文件版本');
    try { return await this.run(session, { operation: 'save', path: file, revision }, { data: text }); }
    finally { this.invalidate(); }
  }
  contentKey(session, info) { return JSON.stringify([session.host, session.port || '', info.path, info.version]); }
  async cachedFile(session, info) {
    const key = this.contentKey(session, info);
    return this.once('content:' + key, async () => {
      const cached = await this.cache.get(key);
      if (cached) return cached;
      await fs.promises.mkdir(this.cache.directory, { recursive: true, mode: 0o700 });
      const temporary = path.join(this.cache.directory, randomUUID() + '.tmp');
      try {
        await this.run(session, { operation: 'download', path: info.path, version: info.version }, { output: temporary, name: info.name, size: info.size });
        await fs.promises.rename(temporary, this.cache.file(key));
        await this.cache.prune(this.cache.file(key));
        return this.cache.file(key);
      } finally { await fs.promises.rm(temporary, { force: true }); }
    });
  }
  stat(session, file) { return this.run(session, { operation: 'stat', path: file }); }

  attachment(session, file) {
    const result = { id: randomUUID(), sessionId: session.id, name: file.name, path: file.path, size: file.size };
    this.attachments.set(result.id, result);
    return result;
  }

  resolveAttachments(session, ids) {
    if (!Array.isArray(ids) || ids.length > 20) throw new Error('一次最多附加 20 个文件');
    return ids.map(id => {
      const file = this.attachments.get(id);
      if (!file || file.sessionId !== session.id) throw new Error('附件已失效，请重新添加');
      return { name: file.name, path: file.path, size: file.size };
    });
  }

  async upload(session, localFile, directory) {
    const info = await fs.promises.stat(localFile);
    if (!info.isFile() || info.size > 1024 ** 3) throw new Error('请选择不超过 1 GB 的普通文件');
    const name = path.basename(localFile);
    const file = await this.run(session, { operation: 'upload', directory, name, size: info.size },
      { input: localFile, name, size: info.size });
    this.invalidate();
    return this.attachment(session, file);
  }

  async download(session, remotePath, destination) {
    const info = await this.stat(session, remotePath);
    const temporary = path.join(path.dirname(destination), '.remotecc-' + randomUUID());
    try {
      if (info.size <= 20 * 1024 * 1024) await this.cache.withLease(this.contentKey(session, info), async () => fs.promises.copyFile(await this.cachedFile(session, info), temporary));
      else await this.run(session, { operation: 'download', path: info.path, version: info.version },
        { output: temporary, name: info.name, size: info.size });
      await fs.promises.rename(temporary, destination);
      return destination;
    } finally { await fs.promises.rm(temporary, { force: true }); }
  }
}
module.exports = { RemoteFiles };
