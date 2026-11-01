'use strict';
// Server-side agent: one long-lived process per SSH connection, Node built-ins only.
// RPC is newline-delimited JSON on stdin/stdout; nothing listens on a port. Bulk transfers run
// as `agent.cjs transfer <json>` on their own SSH channel so they never delay stop or approvals.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawn, execFile } = require('node:child_process');

const HOME = os.homedir();
const expand = value => value === '~' ? HOME : value.startsWith('~/') ? path.join(HOME, value.slice(2)) : value;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const MEGABYTE = 1024 * 1024;

// ---------------------------------------------------------------- files

function resolve(value, base = '~') {
  if (typeof value !== 'string' || /[\x00-\x1f]/.test(value)) throw new Error('无效路径');
  value = expand(value);
  return path.resolve(path.isAbsolute(value) ? value : path.join(expand(base), value));
}

function describe(filename, info, symlink) {
  return { path: filename, name: path.basename(filename), size: Number(info.size), directory: info.isDirectory(),
    modified: Number(info.mtimeMs) / 1000, symlink,
    version: `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}` };
}

async function metadata(filename) {
  const [info, link] = await Promise.all([fsp.stat(filename, { bigint: true }), fsp.lstat(filename)]);
  return describe(filename, info, link.isSymbolicLink());
}

async function regular(filename) {
  const info = await fsp.stat(filename, { bigint: true });
  if (!info.isFile()) throw new Error('请选择普通文件');
  return metadata(filename);
}

async function listing(request) {
  const folder = resolve(request.path ?? '~', request.base);
  const dirents = await fsp.readdir(folder, { withFileTypes: true });
  const visible = dirents.filter(entry => request.hidden || !entry.name.startsWith('.'));
  const entries = (await Promise.all(visible.map(async entry => {
    const filename = path.join(folder, entry.name);
    try { return await metadata(filename); }
    catch { // A dangling symlink is still a real directory entry; show it rather than hide it.
      return entry.isSymbolicLink() ? { path: filename, name: entry.name, size: 0, directory: false, modified: 0, symlink: true, broken: true, version: '' } : null;
    }
  }))).filter(Boolean);
  entries.sort((a, b) => Number(b.directory) - Number(a.directory) || (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0));
  return { path: folder, parent: path.dirname(folder), entries: entries.slice(0, 5000), truncated: entries.length > 5000 };
}

function imageType(magic) {
  if (magic.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (magic.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'image/jpeg';
  const ascii = magic.toString('latin1');
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return 'image/gif';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image/webp';
  if (ascii.startsWith('%PDF-')) return 'application/pdf';
  return null;
}

async function preview(request) {
  const filename = resolve(request.path, request.base);
  const info = await regular(filename);
  if (request.knownVersion === info.version) return { ...info, notModified: true };
  const source = await fsp.open(filename, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(MEGABYTE, Math.max(info.size, 16)));
    const { bytesRead } = await source.read(buffer, 0, buffer.length, 0);
    const data = buffer.subarray(0, bytesRead);
    const mime = imageType(data.subarray(0, 16));
    if (mime) {
      if (info.size > 20 * MEGABYTE) return { ...info, kind: 'binary', reason: '文件超过预览大小限制，请下载查看' };
      return { ...info, kind: mime === 'application/pdf' ? 'pdf' : 'image', mime };
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data, { stream: info.size > data.length });
      if (text.includes('\0')) throw new Error('binary');
      return { ...info, kind: 'text', text, revision: crypto.createHash('sha256').update(data).digest('hex'), truncated: info.size > data.length };
    } catch { return { ...info, kind: 'binary', reason: '此格式请下载或在本地打开' }; }
  } finally { await source.close(); }
}

async function writeDurably(filename, data, mode) {
  const handle = await fsp.open(filename, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
    await handle.chmod(mode);
  } finally { await handle.close(); }
}

const temporaryName = (folder, kind) => path.join(folder, `.remotecc-${kind}-${crypto.randomBytes(8).toString('hex')}`);

async function save(request) {
  const filename = await fsp.realpath(resolve(request.path, request.base));
  await regular(filename);
  const data = Buffer.from(String(request.data ?? ''));
  if (data.length > MEGABYTE) throw new Error('编辑上限为 1 MB');
  const verify = async () => {
    const current = await fsp.readFile(filename);
    if (crypto.createHash('sha256').update(current.subarray(0, MEGABYTE)).digest('hex') !== request.revision)
      throw new Error('远端文件已变化，请重新打开后编辑；本次修改未保存');
  };
  await verify();
  const temporary = temporaryName(path.dirname(filename), 'edit');
  try {
    await writeDurably(temporary, data, (await fsp.stat(filename)).mode & 0o7777);
    await verify();
    await fsp.rename(temporary, filename);
    return await preview({ ...request, path: filename, knownVersion: undefined });
  } finally { await fsp.rm(temporary, { force: true }); }
}

function checkName(name) {
  if (typeof name !== 'string' || !name || name !== path.basename(name) || name === '.' || name === '..' || /[\x00-\x1f]/.test(name)) throw new Error('无效文件名');
  return name;
}

async function createEntry(request) {
  const folder = resolve(request.directory, request.base);
  const target = path.join(folder, checkName(request.name));
  if (request.folder) await fsp.mkdir(target);
  else await (await fsp.open(target, 'wx', 0o666)).close();
  return metadata(target);
}

async function renameEntry(request) {
  const source = resolve(request.path, request.base);
  const target = path.join(path.dirname(source), checkName(request.name));
  // link+unlink would fail for directories; a pre-check keeps rename from silently overwriting.
  if (await fsp.lstat(target).then(() => true, () => false)) throw new Error('目标名称已存在');
  await fsp.rename(source, target);
  return metadata(target);
}

async function removeEntry(request) {
  const target = resolve(request.path, request.base);
  if (target === HOME || target === path.parse(target).root) throw new Error('不能删除此目录');
  await fsp.rm(target, { recursive: request.recursive === true });
  return { removed: target };
}

const EXCLUDED = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.cache', 'dist', 'build', '.next', 'target']);
const fileIndexes = new Map();

// The walk is cached briefly so that typing a query costs one round trip, not one scan per key.
async function fileIndex(base, token) {
  const cached = fileIndexes.get(base);
  if (cached && Date.now() - cached.time < 15000) return cached;
  const files = [], deadline = Date.now() + 3000;
  const pending = [''];
  let truncated = false;
  while (pending.length) {
    if (token?.cancelled) throw new Error('请求已取消');
    if (Date.now() > deadline || files.length >= 20000) { truncated = true; break; }
    const relative = pending.shift();
    let entries;
    try { entries = await fsp.readdir(path.join(base, relative), { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || EXCLUDED.has(entry.name)) continue;
      const child = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isDirectory()) pending.push(child);
      else if (entry.isFile() || entry.isSymbolicLink()) files.push(child);
    }
  }
  const result = { time: Date.now(), files, truncated };
  fileIndexes.set(base, result);
  if (fileIndexes.size > 16) fileIndexes.delete(fileIndexes.keys().next().value);
  return result;
}

// Higher is better: basename match beats path match; contiguous beats scattered. null = no match.
function matchScore(relative, query) {
  if (!query) return 0;
  const lower = relative.toLowerCase(), name = lower.slice(lower.lastIndexOf('/') + 1);
  if (name === query) return 1000;
  if (name.startsWith(query)) return 800 - name.length;
  if (name.includes(query)) return 600 - name.length;
  if (lower.includes(query)) return 400 - lower.length;
  let position = -1;
  for (const char of query) {
    position = lower.indexOf(char, position + 1);
    if (position < 0) return null;
  }
  return 100 - lower.length;
}

async function suggest(request, token) {
  const base = resolve(request.base ?? '~');
  const index = await fileIndex(base, token);
  const query = String(request.query ?? '').toLowerCase();
  const ranked = [];
  for (const relative of index.files) {
    const score = matchScore(relative, query);
    if (score !== null) ranked.push([score, relative]);
  }
  ranked.sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? -1 : 1));
  const files = [];
  for (const [, relative] of ranked) {
    if (files.length >= 40) break;
    try { files.push({ ...await regular(path.join(base, relative)), relative }); } catch { /* removed or not a regular file */ }
  }
  return { files, truncated: index.truncated || ranked.length > 40 };
}

function run(file, args, options = {}) {
  return new Promise(done => {
    const child = execFile(file, args, { maxBuffer: 4 * MEGABYTE, timeout: 20000, ...options }, (error, stdout, stderr) =>
      done({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, missing: error?.code === 'ENOENT', stdout: String(stdout), stderr: String(stderr) }));
    options.token && (options.token.cancel = () => child.kill());
  });
}

const firstAvailable = new Map();
async function hasCommand(name) {
  if (!firstAvailable.has(name)) firstAvailable.set(name, !(await run(name, ['--version'])).missing);
  return firstAvailable.get(name);
}

// Content search. ripgrep when present, otherwise grep; either way results are path\0line:text.
async function search(request, token) {
  const base = resolve(request.base ?? '~');
  const query = String(request.query ?? '');
  if (!query) return { matches: [], truncated: false };
  const excludes = [...EXCLUDED];
  const useRipgrep = await hasCommand('rg');
  const args = useRipgrep ?
    ['--no-heading', '--color', 'never', '-n', '-F', '-S', '--null', '--max-count', '50', '--max-columns', '400', ...excludes.flatMap(name => ['-g', '!' + name]), '--', query, '.'] :
    ['-rnIFi', '-Z', '-m', '50', ...excludes.map(name => '--exclude-dir=' + name), '-e', query, '--', '.'];
  const result = await run(useRipgrep ? 'rg' : 'grep', args, { cwd: base, token });
  if (token?.cancelled) throw new Error('请求已取消');
  if (result.code > 1) throw new Error(result.stderr.trim() || '搜索失败');
  const matches = [];
  for (const line of result.stdout.split('\n')) {
    const separator = line.indexOf('\0');
    if (separator < 0) continue;
    const rest = line.slice(separator + 1), colon = rest.indexOf(':');
    if (colon < 0) continue;
    const relative = line.slice(0, separator).replace(/^\.\//, '');
    matches.push({ path: path.join(base, relative), relative, line: Number(rest.slice(0, colon)), text: rest.slice(colon + 1, colon + 401) });
    if (matches.length >= 500) break;
  }
  return { matches, truncated: matches.length >= 500 };
}

const git = (cwd, ...args) => run('git', ['--no-pager', '-c', 'core.quotepath=off', ...args], { cwd });

async function gitDiffText(request) {
  const folder = resolve(request.base ?? '~');
  const texts = await Promise.all([['diff', '--no-ext-diff', '--no-textconv'], ['diff', '--cached', '--no-ext-diff', '--no-textconv'], ['status', '--short']].map(args => git(folder, ...args)));
  const failed = texts.find(item => item.code);
  if (failed) throw new Error(failed.stderr);
  return { text: 'Working tree\n' + texts[0].stdout + '\nStaged\n' + texts[1].stdout + '\nStatus\n' + texts[2].stdout };
}

async function gitStatus(request) {
  const folder = resolve(request.base ?? '~');
  const top = await git(folder, 'rev-parse', '--show-toplevel');
  if (top.code) return { repository: false, files: [] };
  const root = top.stdout.trim();
  const result = await git(root, 'status', '--porcelain=v1', '-z', '-b');
  if (result.code) throw new Error(result.stderr);
  const parts = result.stdout.split('\0');
  let branch = '';
  const files = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (part.startsWith('## ')) { branch = part.slice(3); continue; }
    if (part.length < 4) continue;
    const status = part.slice(0, 2);
    files.push({ status, path: path.join(root, part.slice(3)), relative: part.slice(3) });
    if (status[0] === 'R' || status[0] === 'C') index++; // The original name follows a rename.
  }
  return { repository: true, root, branch, files: files.slice(0, 2000), truncated: files.length > 2000 };
}

async function gitFileDiff(request) {
  const file = resolve(request.path, request.base);
  const cwd = path.dirname(file);
  const head = await git(cwd, 'diff', 'HEAD', '--no-ext-diff', '--no-textconv', '--', file);
  if (!head.code && head.stdout) return { text: head.stdout };
  const staged = await git(cwd, 'diff', '--cached', '--no-ext-diff', '--no-textconv', '--', file);
  if (!staged.code && staged.stdout) return { text: staged.stdout };
  // Untracked: compare with nothing. `git diff --no-index` exits 1 when files differ.
  const untracked = await git(cwd, 'diff', '--no-index', '--no-ext-diff', '--', '/dev/null', file);
  return { text: untracked.stdout };
}

async function createWorktree(request) {
  const folder = resolve(request.base ?? '~');
  const branch = request.branch;
  if (typeof branch !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,99}$/.test(branch)) throw new Error('分支名称仅支持字母、数字、横线、下划线、点和斜线');
  const valid = await git(folder, 'check-ref-format', '--branch', branch);
  if (valid.code) throw new Error('无效的 Git 分支名');
  const top = await git(folder, 'rev-parse', '--show-toplevel');
  if (top.code) throw new Error('当前项目不是 Git 仓库');
  const root = top.stdout.trim();
  const parent = path.join(path.dirname(root), path.basename(root) + '-worktrees');
  await fsp.mkdir(parent, { recursive: true });
  const destination = path.join(parent, branch.replaceAll('/', '-') + '-' + crypto.randomBytes(4).toString('hex'));
  const result = await git(root, 'worktree', 'add', '-b', branch, '--', destination, 'HEAD');
  if (result.code) throw new Error(result.stderr || '无法创建工作区');
  return { path: destination, branch };
}

async function hello() {
  const located = await run('sh', ['-c', 'command -v claude']);
  const version = process.versions.node.split('.').map(Number);
  return { home: HOME, hostname: os.hostname(), platform: process.platform, arch: process.arch, node: process.versions.node,
    nodeSupported: version[0] > 18 || (version[0] === 18 && version[1] >= 14), nodePath: process.execPath, agentPath: __filename,
    claude: located.code ? null : located.stdout.trim() };
}

const fileOperations = {
  hello, list: listing, preview, save, suggest, search, stat: request => regular(resolve(request.path, request.base)),
  diff: gitDiffText, gitStatus, gitFileDiff, createWorktree, create: createEntry, rename: renameEntry, remove: removeEntry,
};

// ---------------------------------------------------------------- transfers (separate SSH channel)

async function upload(request) {
  const folder = resolve(request.directory);
  const name = checkName(request.name);
  if (!Number.isInteger(request.size) || request.size < 0 || request.size > 1024 ** 3) throw new Error('文件大小超出限制（1 GB）');
  const temporary = temporaryName(folder, 'upload');
  const target = await fsp.open(temporary, 'wx', 0o600);
  try {
    let received = 0;
    for await (const chunk of process.stdin) {
      received += chunk.length;
      if (received > request.size) throw new Error('上传大小不匹配');
      await target.write(chunk);
    }
    if (received !== request.size) throw new Error('上传未完成');
    await target.sync();
    await target.chmod(0o666 & ~process.umask());
    await target.close();
    // Atomic and non-overwriting: a name created while uploading still fails here.
    const destination = path.join(folder, name);
    try { await fsp.link(temporary, destination); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('同名文件已存在：' + name); throw error; }
    return await metadata(destination);
  } finally {
    await target.close().catch(() => {});
    await fsp.rm(temporary, { force: true });
  }
}

async function download(request) {
  const filename = resolve(request.path, request.base);
  const before = await regular(filename);
  if (request.version && request.version !== before.version) throw new Error('远端文件已变化，请重试');
  await new Promise((done, fail) => {
    const source = fs.createReadStream(filename, { highWaterMark: MEGABYTE });
    source.on('error', fail);
    process.stdout.on('error', fail);
    source.on('end', done);
    source.pipe(process.stdout, { end: false });
  });
  if ((await regular(filename)).version !== before.version) throw new Error('传输期间远端文件已变化，请重试');
}

async function transfer(request) {
  if (request.operation === 'upload') process.stdout.write(JSON.stringify(await upload(request)));
  else if (request.operation === 'download') await download(request);
  else throw new Error('未知传输操作');
}

// ---------------------------------------------------------------- history

const CLAUDE_ROOT = () => expand(process.env.CLAUDE_CONFIG_DIR || '~/.claude');
const PROJECTS = () => path.join(CLAUDE_ROOT(), 'projects');
const INDEX_DIRECTORY = () => path.join(CLAUDE_ROOT(), 'remotecc-index');
const SESSION_FILE = /^[0-9a-fA-F-]{36}\.jsonl$/;
const WINDOW = 65536, MAX_LINE = 16 * MEGABYTE;
const listSnapshots = new Map();

async function atomicJSON(filename, value) {
  const temporary = `${filename}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await fsp.rename(temporary, filename);
}
const readJSON = filename => fsp.readFile(filename, 'utf8').then(JSON.parse);

async function mapLimit(items, limit, operation) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await operation(items[index], index); }
  }));
  return results;
}

function historyPath(reference) {
  if (typeof reference !== 'string') throw new Error('无效历史会话');
  const parts = reference.split('/');
  if (parts.length !== 2 || ['', '.', '..'].includes(parts[0]) || !SESSION_FILE.test(parts[1])) throw new Error('无效历史会话');
  const root = fs.realpathSync(PROJECTS());
  const filename = fs.realpathSync(path.join(root, reference));
  if (!filename.startsWith(root + path.sep)) throw new Error('历史路径越界');
  return filename;
}

function parsedLines(data) {
  const rows = [];
  for (const line of data.toString('utf8').split('\n')) {
    if (!line) continue;
    try { const row = JSON.parse(line); if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row); } catch { /* A partial line at a window edge. */ }
  }
  return rows;
}

function textContent(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => block.text ?? '').join('\n') : '';
}

async function summarize(reference, size, modified) {
  const source = await fsp.open(historyPath(reference), 'r');
  let data;
  try {
    const head = Buffer.alloc(Math.min(WINDOW, size));
    await source.read(head, 0, head.length, 0);
    if (size > WINDOW) {
      const start = Math.max(WINDOW, size - WINDOW);
      const tail = Buffer.alloc(size - start);
      await source.read(tail, 0, tail.length, start);
      const newline = tail.indexOf(10);
      data = Buffer.concat([head, Buffer.from('\n'), newline < 0 ? Buffer.alloc(0) : tail.subarray(newline + 1)]);
    } else data = head;
  } finally { await source.close(); }
  let title = '', prompt = '', cwd = '';
  for (const row of parsedLines(data)) {
    cwd = row.cwd || cwd;
    if (row.type === 'custom-title') title = row.customTitle || title;
    if (row.type === 'summary' && !title) title = row.summary || title;
    if (row.type === 'user' && !row.isSidechain && !row.isMeta && !prompt) prompt = textContent(row.message?.content).slice(0, 200);
  }
  const sessionId = reference.split('/')[1].slice(0, -6);
  return { reference, sessionId, directory: cwd, name: (title || prompt || sessionId).slice(0, 200), updatedAt: Math.trunc(modified), size, project: reference.split('/')[0] };
}

async function historyEntries() {
  const root = PROJECTS(), result = [];
  let projects;
  try { projects = await fsp.readdir(root, { withFileTypes: true }); } catch { return result; }
  await mapLimit(projects.filter(entry => entry.isDirectory()), 16, async project => {
    let items;
    try { items = await fsp.readdir(path.join(root, project.name), { withFileTypes: true }); } catch { return; }
    await mapLimit(items.filter(item => item.isFile() && SESSION_FILE.test(item.name)), 32, async item => {
      try {
        const info = await fsp.stat(path.join(root, project.name, item.name), { bigint: true });
        result.push({ reference: project.name + '/' + item.name, modified: Number(info.mtimeMs), size: Number(info.size),
          signature: `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}` });
      } catch { /* Removed between readdir and stat. */ }
    });
  });
  return result.sort((a, b) => b.modified - a.modified);
}

async function historyList(request) {
  const offset = request.offset ?? 0;
  const now = Date.now();
  for (const [key, snapshot] of listSnapshots) if (now - snapshot.created > 3600000) listSnapshots.delete(key);
  let token, position, snapshot;
  if (typeof offset === 'string') {
    const [saved, value] = offset.split(':');
    token = saved; position = Number(value); snapshot = listSnapshots.get(saved);
    if (!snapshot || !(position >= 0)) throw new Error('历史列表已过期，请刷新历史');
  } else {
    position = Math.max(0, Math.trunc(Number(offset)) || 0);
    await fsp.mkdir(INDEX_DIRECTORY(), { recursive: true, mode: 0o700 });
    const cacheFile = path.join(INDEX_DIRECTORY(), 'listing.json');
    const cache = await readJSON(cacheFile).catch(() => ({}));
    const next = {}, rows = [], errors = [];
    let dirty = false;
    const items = await historyEntries();
    await mapLimit(items, 16, async (item, index) => {
      try {
        const known = cache[item.reference];
        const data = known?.signature === item.signature ? known.data : await summarize(item.reference, item.size, item.modified);
        if (data !== known?.data) dirty = true;
        next[item.reference] = { signature: item.signature, data };
        rows[index] = data;
      } catch { errors.push(item.reference); }
    });
    if (dirty || Object.keys(cache).length !== Object.keys(next).length) await atomicJSON(cacheFile, next);
    snapshot = { created: now, rows: rows.filter(Boolean), errors };
    token = crypto.randomBytes(16).toString('hex');
    listSnapshots.set(token, snapshot);
  }
  const end = position + 200;
  return { sessions: snapshot.rows.slice(position, end), nextOffset: end < snapshot.rows.length ? token + ':' + end : null,
    total: snapshot.rows.length + snapshot.errors.length, unreadable: position === 0 ? snapshot.errors : [], metadataBytesPerSession: WINDOW * 2 };
}

const historyIndexes = new Map();
function rememberIndex(key, value) {
  historyIndexes.delete(key); historyIndexes.set(key, value);
  while (historyIndexes.size > 8) historyIndexes.delete(historyIndexes.keys().next().value);
}

async function prefixFingerprint(source, end) {
  const size = Math.min(end, 4096);
  const head = Buffer.alloc(size), tail = Buffer.alloc(size);
  await source.read(head, 0, size, 0);
  await source.read(tail, 0, size, Math.max(0, end - 4096));
  return crypto.createHash('sha256').update(head).update(tail).digest('hex');
}

// Reads only complete lines from `start`; a writer may be halfway through the last one.
async function forEachLine(source, start, limit, visit, chunkSize = MEGABYTE) {
  const chunk = Buffer.allocUnsafe(chunkSize);
  let position = start, lineStart = start, carry = [], carried = 0, oversized = false;
  while (position < limit) {
    const { bytesRead } = await source.read(chunk, 0, Math.min(chunk.length, limit - position), position);
    if (!bytesRead) break;
    let from = 0;
    for (;;) {
      const newline = chunk.subarray(from, bytesRead).indexOf(10);
      if (newline < 0) break;
      const stop = from + newline;
      const end = position + stop + 1;
      if (!oversized && carried + stop - from <= MAX_LINE) {
        const part = chunk.subarray(from, stop);
        if (visit(lineStart, carried ? Buffer.concat([...carry, part]) : part, end) === false) return;
      } else if (visit(lineStart, null, end) === false) return;
      carry = []; carried = 0; oversized = false; lineStart = end; from = stop + 1;
    }
    if (from < bytesRead) {
      carried += bytesRead - from;
      if (carried > MAX_LINE) { oversized = true; carry = []; }
      else carry.push(Buffer.from(chunk.subarray(from, bytesRead)));
    }
    position += bytesRead;
  }
}

async function indexedHistory(reference, source) {
  const key = crypto.createHash('sha256').update(reference).digest('hex');
  const filename = path.join(INDEX_DIRECTORY(), key + '.json');
  const info = await source.stat({ bigint: true });
  const signature = `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  let index = historyIndexes.get(key);
  if (!index) {
    const saved = await readJSON(filename).catch(() => null);
    if (saved) index = { ...saved, nodes: new Map(saved.nodes.map(node => [node[0], node])) };
  }
  if (index?.signature === signature) { rememberIndex(key, index); return index; }
  const size = Number(info.size);
  // Reuse only complete lines, checking both ends of the previously indexed prefix.
  const append = index && index.inode === String(info.ino) && size > index.size && await prefixFingerprint(source, index.end) === index.fingerprint;
  if (!append) index = { nodes: new Map(), leaf: null, cwd: '', skipped: 0, end: 0 };
  await forEachLine(source, index.end, size, (position, line, end) => {
    index.end = end;
    let row = null;
    if (line) { try { row = JSON.parse(line); } catch { row = null; } }
    if (!row || typeof row !== 'object' || Array.isArray(row)) { index.skipped++; return; }
    index.cwd = row.cwd || index.cwd;
    if (typeof row.uuid === 'string' && !row.isSidechain) {
      const visible = (row.type === 'user' || row.type === 'assistant') && !row.isMeta ? 1 : 0;
      index.nodes.set(row.uuid, [row.uuid, row.parentUuid ?? null, position, visible]);
      if (visible) index.leaf = row.uuid;
    }
  });
  if (index.nodes.size > 500000) throw new Error('历史记录过大，当前预览最多索引 50 万条记录');
  Object.assign(index, { signature, inode: String(info.ino), size, fingerprint: await prefixFingerprint(source, index.end) });
  rememberIndex(key, index);
  await fsp.mkdir(INDEX_DIRECTORY(), { recursive: true, mode: 0o700 });
  await atomicJSON(filename, { ...index, nodes: [...index.nodes.values()] });
  return index;
}

async function readRecord(source, position) {
  let found = {};
  const info = await source.stat();
  await forEachLine(source, position, Math.min(info.size, position + MAX_LINE + 1), (start, line) => {
    try { found = JSON.parse(line) || {}; } catch { /* Indexed rows parsed once; the file was rewritten. */ }
    return false;
  }, 65536);
  return found;
}

function resultText(result) {
  if (typeof result === 'string') return result;
  if (!Array.isArray(result)) return '';
  return result.map(block => block?.type === 'text' ? block.text ?? '' : block?.type === 'image' ? '[图片]' : '').filter(Boolean).join('\n');
}

function safeRecord(row) {
  const message = row.message || {};
  let content = message.content ?? [];
  if (typeof content === 'string') content = [{ type: 'text', text: content.slice(0, 40000) }];
  const blocks = [];
  for (const block of Array.isArray(content) ? content : []) {
    const kind = block?.type;
    if (kind === 'text') blocks.push({ type: 'text', text: String(block.text ?? '').slice(0, 40000) });
    else if (kind === 'thinking') blocks.push({ type: 'thinking', thinking: String(block.thinking ?? '').slice(0, 40000) });
    else if (kind === 'tool_use') {
      const value = block.input ?? {};
      blocks.push({ type: kind, id: block.id, name: block.name, input: JSON.stringify(value).length > 20000 ? { preview: '工具参数过长，历史预览已省略' } : value });
    } else if (kind === 'tool_result') blocks.push({ type: kind, tool_use_id: block.tool_use_id, content: resultText(block.content).slice(0, 20000), is_error: block.is_error ?? false });
    else if (kind === 'image' || kind === 'document') blocks.push({ type: 'text', text: '[历史附件：' + kind + '，未下载原始数据]' });
    if (JSON.stringify(blocks).length > 80000) {
      blocks.pop();
      blocks.push({ type: 'text', text: '[历史消息过长，其余内容已省略]' });
      break;
    }
    if (blocks.length >= 100) break;
  }
  return { type: row.type, uuid: row.uuid, timestamp: row.timestamp, ...(row.isApiErrorMessage === true || row.error ? { isApiErrorMessage: true, error: typeof row.error === 'string' ? row.error.slice(0, 200) : undefined } : {}), message: { id: message.id || row.uuid, content: blocks } };
}

async function historyMessages(request) {
  const source = await fsp.open(historyPath(request.reference), 'r');
  try {
    const index = await indexedHistory(request.reference, source);
    const { nodes } = index;
    if (request.before && !nodes.has(request.before)) throw new Error('历史已变化，请重新打开会话');
    let cursor = request.before ? nodes.get(request.before)[1] : index.leaf;
    const chosen = [], seen = new Set();
    while (cursor && nodes.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      const node = nodes.get(cursor);
      if (node[3]) { chosen.push(node); if (chosen.length === 50) break; }
      cursor = node[1];
    }
    const rows = await mapLimit([...chosen].reverse(), 8, node => readRecord(source, node[2]));
    const oldest = chosen.at(-1)?.[0] ?? null;
    let hasMore = false;
    cursor = oldest ? nodes.get(oldest)[1] : null;
    const walked = new Set();
    while (cursor && nodes.has(cursor) && !walked.has(cursor)) {
      walked.add(cursor);
      if (nodes.get(cursor)[3]) { hasMore = true; break; }
      cursor = nodes.get(cursor)[1];
    }
    return { records: rows.map(safeRecord), directory: index.cwd, before: hasMore ? oldest : null, skippedRecords: index.skipped, previewLimits: true };
  } finally { await source.close(); }
}

const historyOperations = { list: historyList, messages: historyMessages };

// ---------------------------------------------------------------- persistent tasks

const TASKS = path.join(HOME, '.local/state/remotecc/tasks');
const BUNDLES = path.join(HOME, '.local/share/remotecc');
const DIGEST = /^[a-f0-9]{64}$/, ID = /^[a-f0-9-]{36}$/;

function taskFolder(identifier) {
  if (typeof identifier !== 'string' || !ID.test(identifier)) throw new Error('Invalid task ID');
  return path.join(TASKS, identifier);
}

function atomicSync(filename, value) {
  const temporary = `${filename}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const handle = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeSync(handle, JSON.stringify(value)); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
  fs.renameSync(temporary, filename);
}
const readSync = filename => { try { return JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { return undefined; } };

function processCommand(pid) {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'latin1'); } catch { return null; }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// started.json names the owner; a task is live only while that exact process exists.
function ownerAlive(folder) {
  const started = readSync(path.join(folder, 'started.json'));
  if (started === undefined) return false;
  if (!started || !started.pid) return legacyOwnerAlive(folder); // Written by a pre-agent client.
  if (!pidAlive(started.pid)) return false;
  const command = processCommand(started.pid); // After a reboot the same PID may be someone else.
  return command === null || command.includes('remote-agent') || command.includes(folder);
}

function legacyOwnerAlive(folder) {
  try {
    for (const entry of fs.readdirSync('/proc')) if (/^\d+$/.test(entry) && processCommand(entry)?.includes('task-worker.cjs\0' + folder)) return true;
  } catch { /* No /proc: treat as dead, which reports rather than re-executes. */ }
  return false;
}

// Never replay a request whose previous owner died after dispatch.
function finalizeTask(folder, code) {
  const stateFile = path.join(folder, 'state.json');
  const state = readSync(stateFile);
  if (state?.done) return state;
  if (state) {
    const idle = state.resident && ['idle', 'stopped'].includes(state.status);
    Object.assign(state, { done: true, status: idle ? state.status : 'error', permissions: [], version: state.version + 1 });
    if (!idle) state.message.error = code === undefined ? '远端任务进程已退出，未自动重新执行。' : `远端任务进程异常退出（${code}）`;
    atomicSync(stateFile, state);
    return state;
  }
  const request = readSync(path.join(folder, 'request.json'));
  const message = request?.session?.messages?.at(-1) || { id: 'unknown', role: 'assistant', blocks: [] };
  message.error = '上次远端任务启动结果未知，未自动重复执行。';
  const failed = { version: 1, done: true, status: 'error', permissions: [], message };
  atomicSync(stateFile, failed);
  return failed;
}

function ensureOwner(folder, bundle) {
  if (ownerAlive(folder)) return;
  const stateFile = path.join(folder, 'state.json'), startedFile = path.join(folder, 'started.json');
  if (fs.existsSync(stateFile) || fs.existsSync(startedFile)) { finalizeTask(folder); return; }
  // Exclusive create is the once-only gate: only one connection can ever dispatch this request.
  let claim;
  try { claim = fs.openSync(startedFile, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') return; throw error; }
  fs.writeSync(claim, JSON.stringify({ pid: process.pid })); fs.closeSync(claim);
  const log = fs.openSync(path.join(folder, 'worker.log'), 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [path.join(bundle, 'task-worker.cjs'), folder], { detached: true, stdio: ['ignore', log, log] });
  } finally { fs.closeSync(log); }
  child.once('error', error => { fs.appendFileSync(path.join(folder, 'worker.log'), error.message + '\n'); finalizeTask(folder, 127); });
  child.once('exit', code => finalizeTask(folder, code ?? 'signal'));
  if (child.pid) atomicSync(startedFile, { pid: child.pid });
  child.unref();
}

async function pruneCompleted() {
  let entries;
  try { entries = await fsp.readdir(TASKS, { withFileTypes: true }); } catch { return; }
  await mapLimit(entries.filter(entry => entry.isDirectory()), 8, async entry => {
    const folder = path.join(TASKS, entry.name);
    try {
      const info = await fsp.stat(path.join(folder, 'state.json'));
      if (Date.now() - info.mtimeMs < 7 * 86400000) return;
      if ((await readJSON(path.join(folder, 'state.json'))).done && fs.existsSync(path.join(folder, 'acknowledged')))
        await fsp.rm(folder, { recursive: true, force: true });
    } catch { /* Unreadable tasks are never pruned. */ }
  });
}

function stateDelta(previous, current, trail = []) {
  if (previous === current) return [];
  if (typeof previous === 'string' && typeof current === 'string' && current.startsWith(previous)) return [{ path: trail, append: current.slice(previous.length) }];
  const previousObject = previous && typeof previous === 'object', currentObject = current && typeof current === 'object';
  if (previousObject && currentObject && !Array.isArray(previous) && !Array.isArray(current)) {
    const patches = [];
    for (const key of Object.keys(previous)) if (!(key in current)) patches.push({ path: [...trail, key], remove: true });
    for (const [key, value] of Object.entries(current)) {
      if (key in previous) patches.push(...stateDelta(previous[key], value, [...trail, key]));
      else patches.push({ path: [...trail, key], value });
    }
    return patches;
  }
  if (Array.isArray(previous) && Array.isArray(current) && current.length >= previous.length) {
    const patches = [];
    current.forEach((value, index) => {
      if (index < previous.length) patches.push(...stateDelta(previous[index], value, [...trail, index]));
      else patches.push({ path: [...trail, index], value });
    });
    return patches;
  }
  return [{ path: trail, value: current }];
}

// Wakes on the next filesystem change in `folder`, or after `fallback` for filesystems without inotify.
function changeSignal(folder, fallback) {
  let wake = null, changed = false;
  const notify = () => { if (wake) wake(); else changed = true; };
  let watcher = null;
  try { watcher = fs.watch(folder, notify); watcher.on('error', () => {}); } catch { /* Polling only. */ }
  return {
    wait: () => new Promise(done => {
      if (changed) { changed = false; return done(); } // Changed while the caller was reading.
      const timer = setTimeout(() => { wake = null; done(); }, fallback);
      wake = () => { wake = null; clearTimeout(timer); done(); };
    }),
    close: () => { watcher?.close(); notify(); },
  };
}

async function taskCommand(request, folder, token) {
  const identifier = request.commandId;
  if (typeof identifier !== 'string' || !ID.test(identifier)) throw new Error('Invalid command ID');
  const directory = path.join(folder, 'commands');
  const filename = path.join(directory, identifier + '.json');
  if (!fs.existsSync(filename + '.done') && !fs.existsSync(filename + '.result')) atomicSync(filename, request.command);
  if (!request.wait) return { accepted: true };
  const signal = changeSignal(directory, 500);
  const deadline = Date.now() + 45000;
  try {
    while (Date.now() < deadline && !token?.cancelled) {
      const result = readSync(filename + '.result');
      if (result !== undefined) return result;
      if (readSync(path.join(folder, 'state.json'))?.done) return { ok: false, error: '远端会话已退出' };
      await signal.wait();
    }
    return { ok: false, uncertain: true, error: '远端操作确认超时，请重连后检查会话状态' };
  } finally { signal.close(); }
}

async function taskOperation(request, token) {
  const { operation } = request;
  if (operation === 'installed' || operation === 'install') {
    void pruneCompleted();
    if (!DIGEST.test(request.digest)) throw new Error('Invalid bundle');
    const bundle = path.join(BUNDLES, request.digest), marker = path.join(bundle, 'ready');
    if (operation === 'install' && !fs.existsSync(marker)) {
      const payload = zlib.gunzipSync(Buffer.from(request.payload, 'base64'));
      if (crypto.createHash('sha256').update(payload).digest('hex') !== request.digest) throw new Error('Bundle checksum mismatch');
      await fsp.mkdir(bundle, { recursive: true, mode: 0o700 });
      for (const [name, content] of Object.entries(JSON.parse(payload))) {
        if (path.basename(name) !== name) throw new Error('Invalid bundle filename');
        await fsp.writeFile(path.join(bundle, name), content, { mode: 0o600 });
      }
      atomicSync(marker, true);
    }
    return { installed: fs.existsSync(marker) };
  }
  if (operation === 'inspect') {
    if (!DIGEST.test(request.digest)) throw new Error('Invalid bundle');
    const directory = path.resolve(expand(request.directory ?? '~'));
    const result = await run(process.execPath, [path.join(BUNDLES, request.digest, 'task-inspect.cjs'),
      JSON.stringify({ action: request.action, value: request.value, directory, preferences: request.preferences })], { cwd: directory, timeout: 50000, token });
    const line = result.stdout.trim().split('\n').at(-1);
    let parsed;
    try { parsed = JSON.parse(line); } catch { throw new Error(result.stderr.trim() || '读取远端能力失败'); }
    if (parsed.error) throw new Error(parsed.error);
    return parsed.result;
  }
  const folder = taskFolder(request.taskId);
  if (operation === 'start') {
    if (!DIGEST.test(request.digest)) throw new Error('Invalid bundle');
    await fsp.mkdir(path.join(folder, 'commands'), { recursive: true, mode: 0o700 });
    const filename = path.join(folder, 'request.json');
    if (!fs.existsSync(filename)) {
      const value = request.request;
      value.session.directory = path.resolve(expand(value.session.directory));
      const temporary = filename + '.' + process.pid + '.tmp';
      atomicSync(temporary, value);
      // link never replaces: a concurrent start keeps whichever request arrived first.
      try { fs.linkSync(temporary, filename); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      fs.rmSync(temporary, { force: true });
    }
    ensureOwner(folder, path.join(BUNDLES, request.digest));
    return { started: true };
  }
  if (operation === 'acknowledge') { atomicSync(path.join(folder, 'acknowledged'), true); return { accepted: true }; }
  if (operation === 'command') return taskCommand(request, folder, token);
  throw new Error('Unknown task operation');
}

// Streams state packets: a full snapshot first, then patches against the previous version.
async function watchTask(taskId, emit, token) {
  const folder = taskFolder(taskId), stateFile = path.join(folder, 'state.json');
  const signal = changeSignal(folder, 1000);
  token.cancel = () => signal.close();
  let previous = null, version = -1, stamp = '', lastHeartbeat = Date.now(), lastOwnerCheck = Date.now();
  try {
    while (!token.cancelled) {
      let info = null;
      try { info = await fsp.stat(stateFile, { bigint: true }); } catch { /* Not written yet. */ }
      const current = info && `${info.ino}:${info.size}:${info.mtimeNs}`;
      if (current && current !== stamp) {
        stamp = current;
        const state = await readJSON(stateFile).catch(() => null);
        if (state && state.version !== version) {
          let packet = state;
          if (previous) {
            const delta = { delta: true, base: version, version: state.version, patches: stateDelta(previous, state) };
            if (JSON.stringify(delta).length < JSON.stringify(state).length) packet = delta;
          }
          emit(packet);
          version = state.version; previous = state;
        }
        if (state?.done) return;
      } else if (Date.now() - lastOwnerCheck > 3000) {
        // A killed owner writes nothing, so report it from here instead of waiting forever.
        lastOwnerCheck = Date.now();
        if (fs.existsSync(path.join(folder, 'started.json')) && !ownerAlive(folder) && !previous?.done) { finalizeTask(folder); continue; }
      }
      if (Date.now() - lastHeartbeat > 10000) { emit({ heartbeat: true }); lastHeartbeat = Date.now(); }
      await signal.wait();
    }
  } finally { signal.close(); }
}

// ---------------------------------------------------------------- filesystem watches

function createDirectoryWatcher(emit) {
  const watchers = new Map(), pending = new Set();
  let timer = null;
  const flush = () => { timer = null; const directories = [...pending]; pending.clear(); if (directories.length) emit({ directories }); };
  const changed = (directory, name) => {
    if (name && String(name).startsWith('.remotecc-')) return;
    pending.add(directory);
    timer ||= setTimeout(flush, 150);
  };
  return {
    set(directories) {
      const wanted = new Set(directories.slice(0, 256).map(item => resolve(item)));
      for (const [directory, watcher] of watchers) if (!wanted.has(directory)) { watcher.close(); watchers.delete(directory); }
      const failed = [];
      for (const directory of wanted) {
        if (watchers.has(directory)) continue;
        try {
          const watcher = fs.watch(directory, (_event, name) => changed(directory, name));
          watcher.on('error', () => { watcher.close(); watchers.delete(directory); changed(directory); });
          watchers.set(directory, watcher);
        } catch { failed.push(directory); } // Missing directory, or the inotify limit was reached.
      }
      return { watching: watchers.size, failed };
    },
    close() { clearTimeout(timer); for (const watcher of watchers.values()) watcher.close(); watchers.clear(); },
  };
}

// ---------------------------------------------------------------- RPC

function serve() {
  const tokens = new Map();
  const send = value => process.stdout.write(JSON.stringify(value) + '\n');
  const watcher = createDirectoryWatcher(data => send({ event: 'fs', ...data }));
  const operations = {
    file: (request, token) => {
      const operation = fileOperations[request.operation];
      if (!operation) throw new Error('未知操作');
      return operation(request, token);
    },
    history: request => {
      const operation = historyOperations[request.operation];
      if (!operation) throw new Error('未知历史操作');
      return operation(request);
    },
    task: taskOperation,
    watchDirectories: request => watcher.set(Array.isArray(request.directories) ? request.directories : []),
    taskWatch: (request, token) => {
      void watchTask(request.taskId, packet => send({ sub: request.subscription, packet }), token).then(
        () => send({ sub: request.subscription, end: true }),
        error => send({ sub: request.subscription, end: true, error: error.message }),
      ).finally(() => tokens.delete('sub:' + request.subscription));
      tokens.set('sub:' + request.subscription, token);
      return { subscribed: true };
    },
  };
  const handle = async message => {
    if (message.cancel !== undefined) {
      const token = tokens.get(message.cancel);
      if (token) { token.cancelled = true; token.cancel?.(); }
      return;
    }
    const token = { cancelled: false };
    tokens.set(message.id, token);
    try {
      const operation = operations[message.op];
      if (!operation) throw new Error('未知请求');
      send({ id: message.id, result: await operation(message.params || {}, token) });
    } catch (error) { send({ id: message.id, error: error.message }); }
    finally { tokens.delete(message.id); }
  };
  let buffered = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', data => {
    buffered += data;
    let index;
    while ((index = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      if (!line) continue;
      try { void handle(JSON.parse(line)); } catch (error) { process.stderr.write(error.message + '\n'); }
    }
  });
  process.stdin.on('end', () => process.exit(0)); // The SSH channel closed; detached tasks keep running.
  process.stdout.on('error', () => process.exit(0));
  send({ rcc: 'ready', pid: process.pid });
}

if (require.main === module) {
  if (process.argv[2] === 'transfer') {
    transfer(JSON.parse(process.argv[3])).catch(error => {
      process.stderr.write(error.message + '\n');
      process.exitCode = 1;
    });
  } else serve();
}

module.exports = { fileOperations, historyOperations, taskOperation, watchTask, finalizeTask, ownerAlive, stateDelta, createDirectoryWatcher, matchScore };
