const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function validateSession(input) {
  if (!input || typeof input !== 'object') throw new Error('无效的会话');
  const host = String(input.host || '').trim().replace(/^ssh\s+(\S+)$/, '$1');
  const directory = String(input.directory || '~').trim();
  const name = String(input.name || '新对话').trim();
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]*$/.test(host) || host.length > 200)
    throw new Error('请输入 SSH 别名或 user@host，端口和密钥请在 SSH config 中配置');
  if (!directory || directory.length > 2048 || /[\x00-\x1f]/.test(directory))
    throw new Error('项目目录不能包含控制字符');
  if (!name || name.length > 80) throw new Error('会话名称需为 1–80 个字符');
  const port = input.port === '' || input.port === undefined ? undefined : Number(input.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('SSH 端口需为 1–65535');
  return { name, host, directory, ...(port ? { port } : {}) };
}

function createSession(input) {
  return { ...validateSession(input), id: crypto.randomUUID(), createdAt: Date.now(),
    updatedAt: Date.now(), messages: [], status: 'idle', permissions: [] };
}

function remoteCommand(session, args = []) {
  const { directory } = validateSession(session);
  if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string' && !arg.includes('\0')))
    throw new Error('无效的 Claude 参数');
  const target = directory === '~' ? '"$HOME"' : directory.startsWith('~/') ?
    '"$HOME"/' + shellQuote(directory.slice(2)) : shellQuote(directory);
  return 'bash -lc ' + shellQuote([
    `cd -- ${target} || { echo "无法进入远端项目目录" >&2; exit 1; }`,
    'command -v claude >/dev/null || { echo "远端环境未找到 claude" >&2; exit 127; }',
    'exec claude ' + args.map(shellQuote).join(' '),
  ].join('\n'));
}

function spawnRemote(session, options, onErrorOutput) {
  const child = spawn('/usr/bin/ssh', [
    '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    ...(session.port ? ['-p', String(session.port)] : []), session.host, remoteCommand(session, options.args),
  ], { stdio: ['pipe', 'pipe', 'pipe'], signal: options.signal });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', onErrorOutput);
  return child;
}

module.exports = { shellQuote, validateSession, createSession, remoteCommand, spawnRemote };
