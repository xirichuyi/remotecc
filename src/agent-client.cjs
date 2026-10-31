// Client side of remote-agent.cjs: one persistent SSH channel per server carries all small requests.
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createHash, randomUUID } = require('node:crypto');
const readline = require('node:readline');
const { shellQuote } = require('./remote.cjs');
const { connectionKey } = require('./ssh.cjs');

const source = fs.readFileSync(path.join(__dirname, 'remote-agent.cjs'));
const digest = createHash('sha256').update(source).digest('hex');
const agentFile = `$HOME/.local/share/remotecc/agent/${digest}/remote-agent.cjs`;

// Non-interactive login shells often miss nvm/fnm/volta, so look there before giving up on node.
const bootstrapScript = `A="${agentFile}"
if ! command -v node >/dev/null 2>&1; then
  for N in "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node "$HOME"/.fnm/node-versions/*/installation/bin/node "$HOME"/.volta/bin/node "$HOME"/.asdf/shims/node /usr/local/bin/node /opt/homebrew/bin/node; do
    [ -x "$N" ] && PATH="$(dirname "$N"):$PATH"
  done
fi
PATH="$PATH:$HOME/.local/bin:$HOME/.claude/local:$HOME/.npm-global/bin"
export PATH
command -v node >/dev/null 2>&1 || { echo __RCC_NO_NODE__; exit 0; }
[ -f "$A" ] || { echo __RCC_INSTALL__; exit 0; }
exec node "$A"`;
// Profile scripts may print anything to stdout; the client ignores lines until the handshake.
// The outer `sh -c` keeps this valid when the account's login shell is fish or csh.
const startCommand = () => 'sh -c ' + shellQuote('if command -v bash >/dev/null 2>&1; then exec bash -lc ' + shellQuote(bootstrapScript) + '; else exec sh -lc ' + shellQuote(bootstrapScript) + '; fi');
const installScript = () => `D="$(dirname "${agentFile}")"; T="$D/.install.$$"; mkdir -p "$D" && chmod 700 "$D" && cat > "$T" && [ "$(wc -c < "$T" | tr -d ' ')" = "${source.length}" ] && mv "$T" "${agentFile}" || { rm -f "$T"; echo "无法写入远端代理程序" >&2; exit 1; }`;

function exitResult(child, stderr) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(stderr().trim() || 'SSH 操作失败')));
  });
}

class AgentChannel extends EventEmitter {
  constructor(connections, config) {
    super();
    this.connections = connections;
    this.config = config;
    this.pending = new Map();
    this.subscriptions = new Map();
    this.sequence = 0;
    this.closed = false;
  }

  async start() {
    let outcome = await this.launch();
    if (outcome === 'install') {
      await this.install();
      outcome = await this.launch();
    }
    if (outcome !== 'ready') throw new Error('远端代理启动失败');
    this.info = await this.call('file', { operation: 'hello' });
    if (!this.info.nodeSupported) { this.close(); throw new Error(`服务器 Node.js 版本过低（${this.info.node}），需要 18.14 或更高版本`); }
    return this;
  }

  launch() {
    const child = this.connections.spawn(this.config, startCommand());
    this.child = child;
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
    child.stdin.on('error', () => {});
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (action, value) => { if (!settled) { settled = true; clearTimeout(timer); action(value); } };
      const timer = setTimeout(() => { settle(reject, new Error('远端代理启动超时')); child.kill(); }, 30000);
      lines.on('line', line => {
        if (!settled) {
          if (line === '__RCC_INSTALL__') return settle(resolve, 'install');
          if (line === '__RCC_NO_NODE__') return settle(reject, new Error('服务器未找到 Node.js。Claude 控制通道需要 Node.js 18.14 或更高版本，请先在服务器上安装。'));
          if (line.startsWith('{"rcc":"ready"')) { this.live = child; settle(resolve, 'ready'); }
          return;
        }
        if (line[0] === '{') { try { this.dispatch(JSON.parse(line)); } catch (error) { this.emit('protocol-error', error); } }
      });
      child.once('error', error => settle(reject, error));
      child.once('close', () => {
        settle(reject, new Error(stderr.trim() || '远端代理已退出'));
        // The install probe exits by design; only losing a running agent ends the channel.
        if (this.live === child) this.shutdown(new Error(stderr.trim() || 'SSH 通道已断开'));
      });
    });
  }

  async install() {
    let stderr = '';
    const child = this.connections.spawn(this.config, 'sh -c ' + shellQuote(installScript()));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
    child.stdin.on('error', () => {});
    const finished = exitResult(child, () => stderr);
    child.stdin.end(source);
    await finished;
  }

  dispatch(message) {
    if (message.event === 'fs') return this.emit('fs', message.directories);
    if (message.sub !== undefined) {
      const subscription = this.subscriptions.get(message.sub);
      if (!subscription) return;
      if (message.end) { this.subscriptions.delete(message.sub); subscription.onEnd(message.error || ''); }
      else subscription.onPacket(message.packet);
      return;
    }
    const request = this.pending.get(message.id);
    if (!request) return;
    this.pending.delete(message.id);
    clearTimeout(request.timer);
    request.cleanup?.();
    if (message.error !== undefined) request.reject(new Error(message.error));
    else request.resolve(message.result);
  }

  write(value) { this.child.stdin.write(JSON.stringify(value) + '\n'); }

  call(op, params, { signal, timeout = 60000 } = {}) {
    if (this.closed) return Promise.reject(new Error('SSH 通道已断开'));
    if (signal?.aborted) return Promise.reject(new Error('请求已取消'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const request = { resolve, reject };
      const fail = error => {
        if (!this.pending.delete(id)) return;
        clearTimeout(request.timer); request.cleanup?.();
        try { this.write({ cancel: id }); } catch { /* The channel is already closing. */ }
        reject(error);
      };
      request.timer = setTimeout(() => fail(new Error('远端操作超时')), timeout);
      if (signal) {
        const abort = () => fail(new Error('请求已取消'));
        signal.addEventListener('abort', abort, { once: true });
        request.cleanup = () => signal.removeEventListener('abort', abort);
      }
      this.pending.set(id, request);
      this.write({ id, op, params });
    });
  }

  // Returns an object with kill(), so a subscription can be held like the process it replaces.
  subscribe(params, onPacket, onEnd) {
    const subscription = randomUUID();
    const entry = { onPacket, onEnd };
    this.subscriptions.set(subscription, entry);
    const id = ++this.sequence;
    this.pending.set(id, { resolve: () => { entry.requestId = id; }, reject: error => { if (this.subscriptions.delete(subscription)) onEnd(error.message); } });
    this.write({ id, op: 'taskWatch', params: { ...params, subscription } });
    return { kill: () => { if (this.subscriptions.delete(subscription)) { try { this.write({ cancel: 'sub:' + subscription }); } catch { /* Channel closed. */ } } } };
  }

  shutdown(error) {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.cleanup?.(); request.reject(error); }
    this.pending.clear();
    const subscriptions = [...this.subscriptions.values()];
    this.subscriptions.clear();
    for (const subscription of subscriptions) subscription.onEnd(error.message);
    this.emit('closed', error);
  }

  close() { this.child?.kill(); this.shutdown(new Error('SSH 通道已关闭')); }
}

class AgentClient extends EventEmitter {
  constructor(connections) {
    super();
    this.connections = connections;
    this.channels = new Map();
  }

  channel(config) {
    const key = connectionKey(config);
    if (!this.channels.has(key)) {
      const channel = new AgentChannel(this.connections, config);
      channel.on('fs', directories => this.emit('fs', { key, host: config.host, port: config.port, directories }));
      channel.on('closed', () => {
        if (this.channels.get(key)?.channel === channel) this.channels.delete(key);
        this.emit('closed', { key, host: config.host, port: config.port });
      });
      const ready = channel.start().catch(error => {
        if (this.channels.get(key)?.channel === channel) this.channels.delete(key);
        channel.close();
        throw error;
      });
      this.channels.set(key, { channel, ready });
    }
    return this.channels.get(key).ready;
  }

  async call(config, op, params, options) { return (await this.channel(config)).call(op, params, options); }
  async info(config) { return (await this.channel(config)).info; }
  async subscribe(config, params, onPacket, onEnd) { return (await this.channel(config)).subscribe(params, onPacket, onEnd); }

  // Bulk data gets its own SSH channel, so the mux shares bandwidth fairly with the control channel.
  async spawnTransfer(config, request) {
    const { nodePath, agentPath } = await this.info(config);
    return this.connections.spawn(config, `${shellQuote(nodePath)} ${shellQuote(agentPath)} transfer ${shellQuote(JSON.stringify(request))}`);
  }

  close(config) {
    const key = connectionKey(config);
    this.channels.get(key)?.channel.close();
    this.channels.delete(key);
  }
}

const clients = new WeakMap();
function agentFor(connections) {
  if (!clients.has(connections)) clients.set(connections, new AgentClient(connections));
  return clients.get(connections);
}

module.exports = { AgentClient, AgentChannel, agentFor, startCommand, digest };
