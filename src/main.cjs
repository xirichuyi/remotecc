const { app, BrowserWindow, ipcMain, shell, dialog, powerMonitor } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { interaction } = require('./command-interactions.cjs');
const { ChatStore } = require('./store.cjs');
const { SessionUpdates } = require('./session-updates.cjs');
const sessionUpdates = new SessionUpdates();
const { ChatService } = require('./chat-service.cjs');
const { SSHConnections, connectionKey } = require('./ssh.cjs');
const { RemoteFiles } = require('./files.cjs');
const { PersistentTasks } = require('./persistent-tasks.cjs');
const { RemoteHistory } = require('./history.cjs');
const { agentFor } = require('./agent-client.cjs');
const { remoteCommand, validateSession } = require('./remote.cjs');

let window;
let service;
let connections;
let files;
let history;
let quitting = false;
let unsavedEditor = false;
function confirmDiscardEditor() {
  if (!unsavedEditor) return true;
  const choice = dialog.showMessageBoxSync(window, { type: 'question', message: '远端文件有未保存的修改', detail: '关闭后这些编辑将丢失。', buttons: ['继续编辑', '放弃修改'], defaultId: 0, cancelId: 0 });
  if (choice !== 1) return false;
  unsavedEditor = false; return true;
}
const notify = (channel, data) => {
  if (window && !window.isDestroyed()) window.webContents.send(channel, data);
};

function registerHandlers() {
  const handle = (channel, handler) => ipcMain.handle(channel, (event, ...args) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
      throw new Error('非法调用');
    return handler(...args);
  });
  handle('editor:dirty', value => { unsavedEditor = value === true; });
  handle('history:discover', (config, offset) => history.discover(validateSession(config), typeof offset === 'string' && /^[a-f0-9]{32}:\d+$/.test(offset) ? offset : 0));
  handle('history:load', (id, older) => history.load(id, older === true));
  handle('chats:list', () => service.sessions.map(session => service.store.metadata(session)));
  handle('chats:load', id => service.get(id));
  handle('chats:create', input => service.create(input));
  handle('chats:remove', id => service.remove(id));
  handle('chats:organize', (id, patch) => service.organize(id, patch));
  handle('chat:cancel-queued', (id, itemId) => service.cancelQueued(id, itemId));
  handle('chat:resume-queue', id => {
    if (connections.state(service.get(id)).status !== 'connected') throw new Error('请先连接 SSH');
    return service.resumeQueue(id);
  });
  handle('chats:rename', (id, name) => service.rename(id, name));
  handle('chat:capabilities', (id, refresh) => service.capabilities(id, refresh === true));
  handle('chat:interaction', async (id, text) => {
    if (typeof text !== 'string' || text.length > 200000) throw new Error('无效命令');
    if (!text.trim().startsWith('/')) return null;
    return interaction(await service.capabilities(id), text, service.get(id).preferences);
  });
  handle('chat:effort', (id, value) => service.selectEffort(id, value));
  handle('chat:model', (id, model) => service.selectModel(id, model));
  handle('chat:configure', (id, patch) => service.configure(id, patch));
  handle('chat:details', (id, section) => service.details(id, section));
  handle('chat:fork', id => service.fork(id));
  handle('chat:export', async id => {
    const session = service.get(id);
    const selection = await dialog.showSaveDialog(window, { title: '导出对话', defaultPath: path.join(app.getPath('downloads'), session.name.replace(/[\\/:]/g, '-') + '.md') });
    if (selection.canceled) return null;
    const content = '# ' + session.name + '\n\n' + session.messages.map(message => '## ' + (message.role === 'user' ? 'User' : 'Claude') + '\n\n' +
      (message.text || message.blocks.filter(block => block.type === 'text').map(block => block.text).join('\n\n'))).join('\n\n');
    await fs.promises.writeFile(selection.filePath, content, { mode: 0o600 });
    return selection.filePath;
  });
  handle('chat:send', (id, text, attachmentIds = []) => {
    const session = service.get(id);
    if (connections.state(session).status !== 'connected') throw new Error('请先连接 SSH 服务器');
    const attachments = files.resolveAttachments(session, attachmentIds);
    return service.runs.has(id) ? service.enqueue(id, text, attachments) : service.send(id, text, attachments);
  });
  handle('chat:stop', id => service.stop(id));
  handle('chat:respond', (id, requestId, answer) => service.respond(id, requestId, answer));
  handle('ssh:connect', async input => {
    const config = validateSession(input);
    await connections.connect(config);
    const info = await files.run(config, { operation: 'hello' });
    void service.persistent?.restore(config)?.catch(error => notify('ssh:recovery-error', error.message));
    return { ...connections.state(config), ...info, host: config.host, port: config.port };
  });
  handle('ssh:tunnels', id => connections.tunnels(service.get(id)));
  handle('ssh:forward', (id, localPort, remotePort, remove) => connections.forward(service.get(id), localPort, remotePort, remove === true));
  handle('ssh:state', input => connections.state(input));
  handle('ssh:disconnect', async input => {
    const active = [...service.runs.keys()].some(id => connectionKey(service.get(id)) === connectionKey(input));
    if (active && !service.persistent) throw new Error('请先停止此服务器上的回复，再断开 SSH');
    await service.persistent?.detach(input);
    agentFor(connections).close(input);
    await connections.disconnect(input);
  });
  handle('files:list', (id, folder, hidden, force) => files.latest('list', () => files.list(service.get(id), folder, hidden === true, force === true)));
  // Expanded tree folders load side by side, so these do not cancel one another.
  handle('files:list-dir', (id, folder, hidden, force) => files.list(service.get(id), folder, hidden === true, force === true));
  handle('files:refresh', (id, file) => files.preview(service.get(id), file));
  handle('files:watch', (id, directories) => {
    if (!Array.isArray(directories) || directories.some(item => typeof item !== 'string')) throw new Error('无效目录');
    return agentFor(connections).call(service.get(id), 'watchDirectories', { directories });
  });
  handle('files:search', (id, query) => {
    if (typeof query !== 'string' || query.length > 500) throw new Error('无效搜索内容');
    return files.latest('search', () => files.run(service.get(id), { operation: 'search', query }));
  });
  handle('files:git-status', id => files.run(service.get(id), { operation: 'gitStatus' }));
  handle('files:git-diff', (id, file) => files.run(service.get(id), { operation: 'gitFileDiff', path: file }));
  handle('files:create', async (id, directory, name, folder) => {
    try { return await files.run(service.get(id), { operation: 'create', directory, name, folder: folder === true }); }
    finally { files.invalidate(); }
  });
  handle('files:rename', async (id, file, name) => {
    try { return await files.run(service.get(id), { operation: 'rename', path: file, name }); }
    finally { files.invalidate(); }
  });
  handle('files:remove', async (id, file, recursive) => {
    try { return await files.run(service.get(id), { operation: 'remove', path: file, recursive: recursive === true }); }
    finally { files.invalidate(); }
  });
  handle('files:cancel', kind => { if (['list', 'preview', 'search', 'suggest'].includes(kind)) files.cancel(kind); });
  handle('files:save', (id, file, text, revision) => files.save(service.get(id), file, text, revision));
  handle('files:diff', id => files.run(service.get(id), { operation: 'diff' }));
  handle('files:preview', (id, file) => files.latest('preview', () => files.preview(service.get(id), file)));
  handle('files:attach', async (id, file) => files.attachment(service.get(id), await files.stat(service.get(id), file)));
  handle('files:upload', uploadFiles);
  handle('files:drop', async (id, paths) => {
    if (!Array.isArray(paths) || paths.length > 20 || paths.some(file => typeof file !== 'string' || !path.isAbsolute(file))) throw new Error('无效文件');
    return uploadSelection(service.get(id), paths, service.get(id).directory);
  });
  handle('files:paste-image', async (id, bytes) => {
    const session = service.get(id);
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength > 20 * 1024 * 1024) throw new Error('图片不能超过 20 MB');
    const data = Buffer.from(bytes);
    const header = data.subarray(0, 12);
    const extension = header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'png' :
      header.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) ? 'jpg' :
      header.toString('ascii', 0, 3) === 'GIF' ? 'gif' :
      header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP' ? 'webp' : null;
    if (!extension) throw new Error('请粘贴 PNG、JPEG、GIF 或 WebP 图片');
    const folder = await fs.promises.mkdtemp(path.join(app.getPath('temp'), 'remotecc-paste-'));
    const filename = path.join(folder, 'screenshot-' + randomUUID() + '.' + extension);
    try { await fs.promises.writeFile(filename, data, { mode: 0o600 }); return await files.upload(session, filename, session.directory); }
    finally { await fs.promises.rm(folder, { recursive: true, force: true }); }
  });
  handle('files:suggest', (id, query) => {
    if (typeof query !== 'string' || query.length > 200) throw new Error('无效文件查询');
    return files.latest('suggest', () => files.run(service.get(id), { operation: 'suggest', query }));
  });
  handle('files:download', downloadFile);
  handle('files:open', openLocalFile);
  handle('workspace:set', async (id, directory) => {
    const session = service.get(id);
    if (service.runs.has(id)) throw new Error('请先停止当前回复');
    const listing = await files.list(session, directory);
    if (session.messages.length) return service.create({ ...session, name: '新对话', directory: listing.path });
    session.directory = listing.path;
    service.changed(session, true);
    return session;
  });
  handle('link:open', url => {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('不支持的链接');
    return shell.openExternal(parsed.href);
  });
  agentFor(connections).on('fs', event => { files.invalidate(); notify('files:changed', event); });
  service.on('changed', session => notify('chat:changed', sessionUpdates.packet(session)));
  connections.on('state', state => {
    if (state.status === 'connected') service.capabilityCache.clear();
    notify('ssh:state', state);
  });
  connections.on('recovered', config => {
    files.invalidate();
    void (async () => {
      await service.persistent?.detach(config);
      if (connections.state(config).status === 'connected') await service.persistent?.restore(config);
    })().catch(error => notify('ssh:recovery-error', error.message));
  });
  connections.on('recovery-error', error => notify('ssh:recovery-error', error.message));
  powerMonitor.on('resume', () => connections.checkConnections?.());
}

async function uploadFiles(id, directory) {
  const session = service.get(id);
  const selection = await dialog.showOpenDialog(window, { title: '上传文件到 ' + directory, properties: ['openFile', 'multiSelections'] });
  if (selection.canceled) return { files: [], errors: [] };
  if (selection.filePaths.length > 20) throw new Error('一次最多上传 20 个文件');
  return uploadSelection(session, selection.filePaths, directory);
}

async function uploadSelection(session, paths, directory) {
  const result = { files: [], errors: [] };
  for (const file of paths) {
    try { result.files.push(await files.upload(session, file, directory)); }
    catch (error) { result.errors.push(path.basename(file) + ': ' + error.message); }
  }
  return result;
}

async function downloadFile(id, file) {
  const session = service.get(id);
  const info = await files.stat(session, file);
  const selection = await dialog.showSaveDialog(window, { title: '下载文件', defaultPath: path.join(app.getPath('downloads'), info.name) });
  if (selection.canceled) return null;
  return files.download(session, info.path, selection.filePath);
}

async function openLocalFile(id, file) {
  const session = service.get(id);
  const info = await files.stat(session, file);
  const allowed = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.txt', '.md', '.csv', '.tsv', '.json', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.rtf']);
  if (!allowed.has(path.extname(info.name).toLowerCase())) throw new Error('此类型请在预览中查看，或下载后选择合适的软件打开');
  const folder = path.join(app.getPath('cache'), 'RemoteCC', randomUUID());
  await fs.promises.mkdir(folder, { recursive: true, mode: 0o700 });
  const localPath = await files.download(session, info.path, path.join(folder, info.name));
  const error = await shell.openPath(localPath);
  if (error) throw new Error(error);
  return localPath;
}

function createWindow() {
  window = new BrowserWindow({ width: 1440, height: 900, minWidth: 1060, minHeight: 650,
    title: 'RemoteCC', backgroundColor: '#ffffff', titleBarStyle: 'hiddenInset',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.on('close', event => { if (!confirmDiscardEditor()) event.preventDefault(); });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  try {
    service = new ChatService(new ChatStore(path.join(app.getPath('userData'), 'chats.json')));
    connections = new SSHConnections();
    files = new RemoteFiles(connections, event => notify('files:progress', event), path.join(app.getPath('cache'), 'RemoteCC', 'content'));
    history = new RemoteHistory(connections, service);
    service.persistent = new PersistentTasks(connections, service);
    service.spawn = (session, options, onError) => {
      const child = connections.spawn(session, remoteCommand(session, options.args), { signal: options.signal });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', onError);
      return child;
    };
  } catch (error) {
    dialog.showErrorBox('无法启动', error.message);
    app.quit();
    return;
  }
  registerHandlers();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', event => {
  if (quitting || !connections) return;
  event.preventDefault();
  if (!confirmDiscardEditor()) return;
  quitting = true;
  Promise.resolve(service?.close()).then(() => connections.close()).finally(() => app.quit());
});
