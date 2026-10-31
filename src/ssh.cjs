const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { validateSession } = require('./remote.cjs');
const execute = promisify(execFile);

function connectionKey(input) {
  const connection = validateSession(input);
  return createHash('sha256').update(JSON.stringify([connection.host, connection.port || ''])).digest('hex').slice(0, 16);
}
function connectionArgs(connection) {
  return connection.port ? ['-p', String(connection.port)] : [];
}

class SSHConnections extends EventEmitter {
  constructor() {
    super();
    this.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-'));
    fs.chmodSync(this.directory, 0o700);
    this.connections = new Map();
    this.pending = new Map();
    this.desired = new Map();
    this.retries = new Map();
    this.monitor = setInterval(() => this.checkConnections(), 15000);
    this.monitor.unref();
  }

  state(input) {
    const connection = this.connections.get(connectionKey(input));
    return { key: connectionKey(input), host: input.host, status: connection?.status || 'disconnected', error: connection?.error || '' };
  }

  async connect(input) {
    const config = validateSession(input);
    const key = connectionKey(config);
    this.desired.set(key, config);
    const retry = this.retries.get(key);
    if (retry?.timer) { clearTimeout(retry.timer); retry.timer = null; }
    if (this.connections.get(key)?.status === 'connected') return this.state(config);
    if (this.pending.has(key)) return this.pending.get(key);
    const promise = this.start(config, key).finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }

  async start(config, key) {
    const socket = path.join(this.directory, key);
    const entry = { config, socket, status: this.retries.has(key) ? 'reconnecting' : 'connecting', error: '', tunnels: this.connections.get(key)?.tunnels || [] };
    this.connections.set(key, entry);
    this.emit('state', this.state(config));
    try {
      await execute('/usr/bin/ssh', [
        '-M', '-N', '-f', '-S', socket, '-o', 'ControlPersist=no', '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
        ...connectionArgs(config), config.host,
      ], { timeout: 20000, maxBuffer: 64 * 1024 });
      entry.status = 'connected';
      this.emit('state', this.state(config));
      if (this.desired.has(key) && this.retries.has(key)) {
        this.retries.delete(key);
        for (const tunnel of [...entry.tunnels]) {
          try { await this.forward(config, tunnel.localPort, tunnel.remotePort); }
          catch (error) { entry.tunnels = entry.tunnels.filter(item => item !== tunnel); this.emit('recovery-error', error); }
        }
        this.emit('recovered', config);
      }
      return this.state(config);
    } catch (error) {
      entry.status = 'error';
      entry.error = error.stderr?.trim() || error.message;
      this.emit('state', this.state(config));
      this.scheduleReconnect(config);
      throw new Error(entry.error);
    }
  }

  spawn(input, command, options = {}) {
    const entry = this.connections.get(connectionKey(input));
    if (entry?.status !== 'connected') throw new Error('请先连接 SSH 服务器');
    // ProxyCommand=false prevents a failed master from silently opening a new connection.
    const child = spawn('/usr/bin/ssh', ['-T', '-S', entry.socket, '-o', 'BatchMode=yes',
      '-o', 'ProxyCommand=false', ...connectionArgs(entry.config), entry.config.host, command],
    { stdio: ['pipe', 'pipe', 'pipe'], ...options });
    child.on('exit', code => {
      // A remote command (or a cancelled subscription) can itself exit 255.
      // Only mark the transport disconnected when its master is actually gone.
      if (code === 255 && entry.status === 'connected') void this.checkMaster(entry);
    });
    return child;
  }

  checkConnections() {
    for (const entry of this.connections.values()) if (entry.status === 'connected') void this.checkMaster(entry);
  }

  scheduleReconnect(config) {
    const key = connectionKey(config);
    if (!this.desired.has(key)) return;
    const retry = this.retries.get(key) || { attempt: 0 };
    if (retry.timer) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(retry.attempt++, 5)) * (0.8 + Math.random() * 0.4);
    retry.timer = setTimeout(() => {
      retry.timer = null;
      if (this.desired.has(key)) void this.connect(config).catch(() => {});
    }, delay);
    retry.timer.unref();
    this.retries.set(key, retry);
    const entry = this.connections.get(key);
    if (entry) { entry.status = 'reconnecting'; this.emit('state', this.state(config)); }
  }

  async checkMaster(entry) {
    if (entry.checking) return;
    entry.checking = true;
    try {
      await execute('/usr/bin/ssh', ['-S', entry.socket, '-O', 'check', ...connectionArgs(entry.config), entry.config.host], { timeout: 5000 });
    } catch {
      if (this.connections.get(connectionKey(entry.config)) !== entry || entry.status !== 'connected') return;
      entry.status = 'error'; entry.error = 'SSH 连接已断开';
      this.emit('state', this.state(entry.config));
      this.scheduleReconnect(entry.config);
    } finally { entry.checking = false; }
  }

  tunnels(input) {
    return [...(this.connections.get(connectionKey(input))?.tunnels || [])];
  }

  async forward(input, localPort, remotePort, remove = false) {
    const entry = this.connections.get(connectionKey(input));
    if (entry?.status !== 'connected') throw new Error('请先连接 SSH');
    for (const port of [localPort, remotePort]) if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口应为 1–65535');
    const rule = `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`;
    await execute('/usr/bin/ssh', ['-S', entry.socket, '-O', remove ? 'cancel' : 'forward', '-L', rule,
      '-o', 'ExitOnForwardFailure=yes', ...connectionArgs(entry.config), entry.config.host], { timeout: 10000 });
    entry.tunnels ||= [];
    entry.tunnels = entry.tunnels.filter(item => item.localPort !== localPort || item.remotePort !== remotePort);
    if (!remove) entry.tunnels.push({ localPort, remotePort });
    return this.tunnels(input);
  }

  async disconnect(input) {
    const key = connectionKey(input);
    this.desired.delete(key);
    clearTimeout(this.retries.get(key)?.timer);
    this.retries.delete(key);
    if (this.pending.has(key)) await this.pending.get(key).catch(() => {});
    const entry = this.connections.get(key);
    if (!entry) return;
    await execute('/usr/bin/ssh', ['-S', entry.socket, '-O', 'exit', entry.config.host], { timeout: 5000 }).catch(() => {});
    this.connections.delete(key);
    this.emit('state', this.state(input));
  }

  async close() {
    clearInterval(this.monitor);
    this.desired.clear();
    for (const retry of this.retries.values()) clearTimeout(retry.timer);
    this.retries.clear();
    await Promise.allSettled([...this.connections.values()].map(entry => this.disconnect(entry.config)));
    fs.rmSync(this.directory, { recursive: true, force: true });
  }
}
module.exports = { SSHConnections, connectionKey, connectionArgs };
