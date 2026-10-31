const attachmentDrafts = new Map();
const folderBySession = new Map();
let currentListing = null;
let browseSequence = 0;
let uploading = false;
const tree = { root: null, directories: new Map(), expanded: new Set(), git: new Map() };
window.workspaceState = 'disconnected';
const connectionConfig = () => activeSession() || defaults;
const sizeText = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
window.workspaceAttachments = () => attachmentDrafts.get(activeId) || [];
window.clearWorkspaceAttachments = (id = activeId) => { attachmentDrafts.delete(id); renderAttachments(); };

function fileChip(file, removable) {
  const chip = document.createElement('span');
  chip.className = 'attachment-chip';
  const open = document.createElement('button');
  open.type = 'button';
  open.textContent = file.name;
  open.title = file.path;
  open.onclick = () => window.openRemotePreview(file.path);
  const size = document.createElement('small');
  size.textContent = sizeText(file.size);
  chip.append(open, size);
  if (removable) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = '移除附件';
    remove.onclick = () => {
      attachmentDrafts.set(activeId, window.workspaceAttachments().filter(item => item.id !== file.id));
      renderAttachments(); updateUI();
    };
    chip.append(remove);
  }
  return chip;
}
function renderAttachments() {
  $('#attachments').replaceChildren(...window.workspaceAttachments().map(file => fileChip(file, true)));
}
window.messageAttachments = files => {
  const container = document.createElement('div');
  container.className = 'message-attachments';
  container.append(...files.map(file => fileChip(file, false)));
  return container;
};
function addAttachments(id, files) {
  const previous = attachmentDrafts.get(id) || [];
  const unique = files.filter(file => !previous.some(item => item.path === file.path));
  attachmentDrafts.set(id, [...previous, ...unique]);
  if (id === activeId) { renderAttachments(); updateUI(); }
}

function connectionUI(state) {
  window.workspaceState = state.status;
  $('#ssh-status').textContent = { connected: '已连接', connecting: '连接中', reconnecting: '重连中', disconnected: '未连接', error: '已断开' }[state.status];
  $('#ssh-status').className = state.status;
  $('#connect-server').hidden = state.status === 'connected';
  $('#connect-server').disabled = state.status === 'connecting';
  $('#disconnect-server').hidden = !['connected', 'reconnecting'].includes(state.status);
  for (const selector of ['#upload-files', '#upload-attachment', '#refresh-files', '#use-folder', '#parent-folder', '#new-file', '#new-folder'])
    $(selector).disabled = state.status !== 'connected' || uploading;
  updateUI();
  if (state.status === 'connected') window.controlsChanged?.();
}

window.workspaceChanged = async () => {
  const id = activeId;
  ++browseSequence;
  void api.cancelFiles('list');
  currentListing = null;
  tree.root = null; tree.directories.clear(); tree.expanded.clear(); tree.git.clear();
  $('#file-path').value = folderBySession.get(id) || connectionConfig().directory;
  $('#file-list').replaceChildren();
  $('#file-footer').textContent = '';
  $('#file-error').textContent = '';
  renderAttachments();
  window.renderEditorTabs();
  if (!connectionConfig().host) { connectionUI({ status: 'disconnected' }); $('#file-list').innerHTML = '<div class="file-empty">未连接 SSH</div>'; return; }
  connectionUI({ status: 'disconnected' });
  try {
    const state = await api.connectionState(connectionConfig());
    if (id !== activeId) return;
    connectionUI(state);
    if (state.status === 'connected' && activeId) await browse($('#file-path').value);
    else $('#file-list').innerHTML = '<div class="file-empty">未连接 SSH</div>';
  } catch (error) { showError(error); }
};

const gitLabels = { M: '已修改', A: '已添加', D: '已删除', R: '已重命名', '?': '未跟踪', U: '有冲突' };
const gitCode = status => status.includes('U') ? 'U' : status === '??' ? '?' : (status[1] !== ' ' ? status[1] : status[0]);

function touchedFiles() {
  const touched = new Set();
  for (const block of activeSession()?.messages.at(-1)?.blocks || []) {
    const file = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(block.name) ? block.input?.file_path || block.input?.notebook_path : null;
    if (file) touched.add(file);
  }
  return touched;
}

function treeRow(file, depth, touched) {
  const row = document.createElement('button');
  const expanded = tree.expanded.has(file.path);
  const code = tree.git.get(file.path);
  row.className = 'file-entry' + (touched.has(file.path) ? ' touched' : '') + (code ? ' git-' + (code === '?' ? 'untracked' : code) : '') + (file.broken ? ' broken' : '');
  row.title = file.path + (code && gitLabels[code] ? ' · ' + gitLabels[code] : '') + (file.broken ? ' · 链接目标不存在' : '');
  row.setAttribute('role', 'treeitem');
  row.dataset.path = file.path;
  row.style.paddingLeft = 8 + depth * 13 + 'px';
  if (file.directory) row.setAttribute('aria-expanded', String(expanded));
  const icon = document.createElement('span');
  icon.className = 'file-icon';
  icon.textContent = file.directory ? (expanded ? '▾' : '▸') : '';
  const name = document.createElement('span');
  name.className = 'file-name';
  name.textContent = file.name + (file.symlink ? ' ↗' : '');
  const size = document.createElement('span');
  size.className = 'file-size';
  size.textContent = code && code !== '?' ? code : code === '?' ? 'U' : file.directory ? '' : sizeText(file.size);
  row.append(icon, name, size);
  row.onclick = () => file.directory ? toggleDirectory(file.path) : window.openRemotePreview(file.path);
  row.ondblclick = () => { if (file.directory) browse(file.path); };
  row.oncontextmenu = event => { event.preventDefault(); showFileMenu(event, file); };
  return row;
}

function renderTree() {
  const list = $('#file-list');
  if (!tree.root) return;
  const top = list.scrollTop, touched = touchedFiles(), rows = [];
  const walk = (directory, depth) => {
    for (const file of tree.directories.get(directory)?.entries || []) {
      rows.push(treeRow(file, depth, touched));
      if (file.directory && tree.expanded.has(file.path) && tree.directories.has(file.path)) walk(file.path, depth + 1);
    }
  };
  walk(tree.root, 0);
  list.replaceChildren(...rows);
  if (!rows.length) list.innerHTML = '<div class="file-empty">空目录</div>';
  list.scrollTop = top;
  const listing = tree.directories.get(tree.root);
  $('#file-footer').textContent = `${listing.entries.length} 项${listing.truncated ? ' · 仅显示前 5000 项' : ''}` + (window.watchFailed ? ' · 未能实时监听，回复结束后刷新' : '');
}

async function loadDirectory(directory, force = false) {
  const id = activeId;
  const listing = await api.listDirectory(id, directory, $('#show-hidden').checked, force);
  if (id === activeId) tree.directories.set(listing.path, listing);
  return listing;
}

async function toggleDirectory(directory) {
  if (tree.expanded.delete(directory)) { renderTree(); syncWatches(); return; }
  tree.expanded.add(directory);
  renderTree();
  try { await loadDirectory(directory); }
  catch (error) { tree.expanded.delete(directory); $('#file-error').textContent = error.message; }
  renderTree(); syncWatches();
}

// Only what is on screen is watched: the root, expanded folders and folders of open files.
function syncWatches() {
  if (!activeId || !tree.root || window.workspaceState !== 'connected') return;
  const directories = [tree.root, ...tree.expanded, ...window.openFileDirectories()];
  api.watchDirectories(activeId, [...new Set(directories)]).then(result => {
    const failed = result.failed.length > 0;
    if (failed !== Boolean(window.watchFailed)) { window.watchFailed = failed; renderTree(); }
  }).catch(() => { window.watchFailed = true; });
}

async function refreshGit() {
  const id = activeId;
  if (!id || window.workspaceState !== 'connected') return;
  try {
    const status = await api.gitStatus(id);
    if (id !== activeId) return;
    tree.git.clear();
    for (const file of status.files) {
      tree.git.set(file.path, gitCode(file.status));
      // A folder shows that something inside it changed.
      for (let parent = file.path.slice(0, file.path.lastIndexOf('/')); parent.length > (status.root || '').length; parent = parent.slice(0, parent.lastIndexOf('/')))
        if (!tree.git.has(parent)) tree.git.set(parent, 'M');
    }
    renderChanges(status); renderTree();
  } catch { /* Git is optional; the file tree stays usable. */ }
}

function renderChanges(status) {
  $('#changes-count').textContent = status.files.length ? ' ' + status.files.length : '';
  $('#changes-branch').textContent = !status.repository ? '当前目录不是 Git 仓库' : (status.branch || '') + (status.files.length ? '' : ' · 没有未提交的变更');
  $('#changes-list').replaceChildren(...status.files.map(file => {
    const row = document.createElement('button');
    row.className = 'file-entry git-' + (gitCode(file.status) === '?' ? 'untracked' : gitCode(file.status));
    row.title = file.path;
    const name = document.createElement('span'); name.className = 'file-name'; name.textContent = file.relative;
    const code = document.createElement('span'); code.className = 'file-size'; code.textContent = file.status.trim();
    row.append(name, code);
    row.onclick = () => window.openRemoteDiff(file.path);
    return row;
  }));
}

async function browse(folder, force = false) {
  if (!activeId || window.workspaceState !== 'connected') return;
  const sequence = ++browseSequence;
  const id = activeId;
  $('#file-error').textContent = '';
  $('#file-footer').textContent = '读取中…';
  try {
    const listing = await api.listFiles(id, folder, $('#show-hidden').checked, force);
    if (id !== activeId || sequence !== browseSequence) return;
    currentListing = listing;
    folderBySession.set(id, listing.path);
    $('#file-path').value = listing.path;
    if (tree.root !== listing.path) { tree.expanded.clear(); tree.directories.clear(); tree.root = listing.path; }
    tree.directories.set(listing.path, listing);
    await Promise.all([...tree.expanded].map(directory => loadDirectory(directory, force).catch(() => tree.expanded.delete(directory))));
    if (id !== activeId || sequence !== browseSequence) return;
    renderTree(); syncWatches(); void refreshGit();
  } catch (error) {
    if (id === activeId && sequence === browseSequence) {
      $('#file-error').textContent = error.message;
      $('#file-footer').textContent = '读取失败';
      $('#file-list').replaceChildren();
    }
  }
}
window.reloadFileTree = () => browse($('#file-path').value);

let changeTimer = null;
const changedDirectories = new Set();
api.onFilesChanged(event => {
  const config = connectionConfig();
  if (event.host !== config.host || (event.port || '') !== (config.port || '')) return;
  for (const directory of event.directories) changedDirectories.add(directory);
  changeTimer ||= setTimeout(async () => {
    changeTimer = null;
    const directories = [...changedDirectories];
    changedDirectories.clear();
    await Promise.all(directories.filter(directory => tree.directories.has(directory)).map(directory => loadDirectory(directory, true).catch(() => {})));
    renderTree();
    void refreshGit();
    window.refreshOpenFiles(directories);
  }, 100);
});

function showFileMenu(event, file) {
  const menu = $('#file-menu');
  const item = (label, action) => {
    const button = document.createElement('button'); button.textContent = label;
    button.onclick = () => { menu.hidden = true; Promise.resolve(action()).catch(showError); };
    return button;
  };
  const directory = file.directory ? file.path : file.path.slice(0, file.path.lastIndexOf('/')) || '/';
  const items = [];
  if (file.directory) items.push(item('进入此目录', () => browse(file.path)), item('新建文件', () => createEntry(directory, false)), item('新建文件夹', () => createEntry(directory, true)));
  else items.push(item('打开', () => window.openRemotePreview(file.path)), item('附加到消息', async () => addAttachments(activeId, [await api.attach(activeId, file.path)])), item('下载', () => api.download(activeId, file.path)));
  if (tree.git.has(file.path) && !file.directory) items.push(item('查看变更', () => window.openRemoteDiff(file.path)));
  items.push(item('复制路径', () => navigator.clipboard.writeText(file.path)), item('重命名', () => renameEntry(file)), item('删除', () => removeEntry(file)));
  menu.replaceChildren(...items);
  menu.hidden = false;
  menu.style.left = Math.min(event.clientX, innerWidth - 170) + 'px';
  menu.style.top = Math.min(event.clientY, innerHeight - items.length * 32 - 12) + 'px';
}
document.addEventListener('click', () => { $('#file-menu').hidden = true; });

// Electron has no window.prompt, so names are collected with a small dialog.
function askName(title, initial = '') {
  return new Promise(resolve => {
    const dialog = $('#name-dialog');
    $('#name-title').textContent = title;
    $('#name-input').value = initial;
    dialog.onclose = () => resolve(dialog.returnValue === 'ok' ? $('#name-input').value.trim() || null : null);
    dialog.returnValue = '';
    dialog.showModal();
    $('#name-input').select();
  });
}
async function createEntry(directory, folder) {
  const name = await askName(folder ? '新文件夹名称' : '新文件名称');
  if (!name) return;
  const created = await api.createEntry(activeId, directory, name, folder);
  if (directory !== tree.root && !tree.expanded.has(directory)) tree.expanded.add(directory);
  await loadDirectory(directory, true).catch(() => {});
  renderTree(); syncWatches();
  if (!folder) window.openRemotePreview(created.path);
}
async function renameEntry(file) {
  const name = await askName('重命名', file.name);
  if (!name || name === file.name) return;
  await api.renameEntry(activeId, file.path, name);
  await browse(tree.root, true);
}
async function removeEntry(file) {
  const label = file.directory ? `删除文件夹 ${file.path} 及其全部内容？` : `删除文件 ${file.path}？`;
  if (!window.confirm(label + '\n此操作在服务器上执行，无法撤销。')) return;
  await api.removeEntry(activeId, file.path, file.directory);
  await browse(tree.root, true);
}
$('#new-file').onclick = () => createEntry(tree.root, false).catch(showError);
$('#new-folder').onclick = () => createEntry(tree.root, true).catch(showError);

function selectPanel(name) {
  for (const panel of ['files', 'changes', 'search']) {
    $('#panel-' + panel).classList.toggle('selected', panel === name);
    $('#' + panel + '-view').hidden = panel !== name;
  }
  if (name === 'changes') void refreshGit();
  if (name === 'search') $('#content-search').focus();
}
$('#panel-files').onclick = () => selectPanel('files');
$('#panel-changes').onclick = () => selectPanel('changes');
$('#panel-search').onclick = () => selectPanel('search');

let searchSequence = 0;
$('#search-form').onsubmit = async event => {
  event.preventDefault();
  const query = $('#content-search').value, sequence = ++searchSequence;
  if (!query || !activeId) return;
  $('#search-status').textContent = '搜索中…';
  $('#search-results').replaceChildren();
  try {
    const result = await api.searchFiles(activeId, query);
    if (sequence !== searchSequence) return;
    $('#search-status').textContent = `${result.matches.length} 处匹配${result.truncated ? '（已截断）' : ''}`;
    $('#search-results').replaceChildren(...result.matches.map(match => {
      const row = document.createElement('button');
      row.className = 'search-result'; row.title = match.path;
      const place = document.createElement('small'); place.textContent = `${match.relative}:${match.line}`;
      const text = document.createElement('span'); text.textContent = match.text.trim();
      row.append(place, text);
      row.onclick = () => window.openRemotePreview(match.path, match.line);
      return row;
    }));
  } catch (error) { if (sequence === searchSequence) $('#search-status').textContent = error.message; }
};

let quickSequence = 0, quickTimer, quickResults = [], quickSelection = 0;
function renderQuickOpen() {
  $('#quick-open-results').replaceChildren(...quickResults.map((file, index) => {
    const row = document.createElement('button');
    row.className = 'command-item' + (index === quickSelection ? ' selected' : '');
    row.textContent = file.relative; row.title = file.path;
    row.onclick = () => { $('#quick-open').close(); window.openRemotePreview(file.path); };
    return row;
  }));
  $('#quick-open-results .selected')?.scrollIntoView({ block: 'nearest' });
}
$('#quick-open-input').oninput = () => {
  clearTimeout(quickTimer);
  const sequence = ++quickSequence, query = $('#quick-open-input').value;
  quickTimer = setTimeout(async () => {
    try {
      const result = await api.suggestFiles(activeId, query);
      if (sequence === quickSequence) { quickResults = result.files; quickSelection = 0; renderQuickOpen(); }
    } catch { /* A newer query replaced this one. */ }
  }, 60);
};
$('#quick-open-input').onkeydown = event => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    quickSelection = (quickSelection + (event.key === 'ArrowDown' ? 1 : -1) + quickResults.length) % (quickResults.length || 1);
    renderQuickOpen();
  } else if (event.key === 'Enter' && quickResults[quickSelection]) {
    event.preventDefault();
    $('#quick-open').close();
    window.openRemotePreview(quickResults[quickSelection].path);
  }
};
document.addEventListener('keydown', event => {
  if (!(event.metaKey || event.ctrlKey)) return;
  const key = event.key.toLowerCase();
  if (key === 'p' && !event.shiftKey && activeId && window.workspaceState === 'connected') {
    event.preventDefault();
    $('#quick-open-input').value = ''; quickResults = []; renderQuickOpen();
    $('#quick-open').showModal(); $('#quick-open-input').dispatchEvent(new Event('input'));
  }
  if (key === 'f' && event.shiftKey) { event.preventDefault(); document.body.classList.remove('files-hidden'); selectPanel('search'); }
  if (key === 'w' && window.closeActiveTab()) event.preventDefault();
});

async function connect(config) {
  connectionUI({ status: 'connecting' });
  try {
    const result = await api.connect(config);
    defaults = { host: result.host, directory: config.directory || result.home, ...(result.port ? { port: result.port } : {}) };
    localStorage.setItem('last-connection', JSON.stringify(defaults));
    if (!result.claude) showError(new Error('已连接，但服务器上未找到 claude 命令，聊天不可用。文件功能不受影响。'));
    const current = activeSession();
    if (!current || current.host !== defaults.host || (current.port || '') !== (defaults.port || '') || current.directory !== defaults.directory) {
      const session = await api.create({ ...defaults, name: '新对话' });
      if (!sessions.some(item => item.id === session.id)) sessions.unshift(session);
      selectSession(session.id);
    }
    connectionUI({ status: 'connected' });
    void window.refreshRemoteHistory?.(defaults);
    if (activeSession().historyLoaded === false) void window.openHistory?.(activeId);
    else await browse(activeSession().directory);
  } catch (error) { connectionUI({ status: 'error' }); throw error; }
}

window.showSSHSettings = () => {
  const config = connectionConfig();
  const form = $('#connection-form');
  form.elements.host.value = config.host || '';
  form.elements.port.value = config.port || '';
  form.elements.directory.value = config.directory || '~';
  $('#connection-error').textContent = '';
  $('#connection-dialog').showModal();
};
$('#connection-settings').onclick = window.showSSHSettings;
$('#cancel-connection').onclick = () => $('#connection-dialog').close();
$('#connection-form').onsubmit = async event => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  button.textContent = '连接中…';
  try { await connect(Object.fromEntries(new FormData(event.target))); $('#connection-dialog').close(); }
  catch (error) { $('#connection-error').textContent = error.message; }
  finally { button.disabled = false; button.textContent = '连接'; }
};
$('#connect-server').onclick = () => connectionConfig().host ? connect(connectionConfig()).catch(showError) : window.showSSHSettings();
window.autoConnect = () => {
  if (connectionConfig().host && localStorage.getItem('last-connection')) connect(connectionConfig()).catch(() => window.showSSHSettings());
};
$('#disconnect-server').onclick = async () => {
  try { await api.disconnect(connectionConfig()); await window.workspaceChanged(); }
  catch (error) { showError(error); }
};
$('#new-chat').onclick = async () => {
  if (window.workspaceState !== 'connected') return window.showSSHSettings();
  try {
    const session = await api.create({ ...connectionConfig(), name: '新对话' });
    if (!sessions.some(item => item.id === session.id)) sessions.unshift(session);
    selectSession(session.id);
  } catch (error) { showError(error); }
};
$('#toggle-files').onclick = () => document.body.classList.toggle('files-hidden');
$('#path-form').onsubmit = event => { event.preventDefault(); browse($('#file-path').value); };
$('#parent-folder').onclick = () => { if (currentListing) browse(currentListing.parent); };
$('#refresh-files').onclick = () => browse($('#file-path').value, true);
$('#show-hidden').onchange = () => browse($('#file-path').value);
$('#use-folder').onclick = async () => {
  if (!currentListing) return;
  try {
    const session = await api.setWorkspace(activeId, currentListing.path);
    const index = sessions.findIndex(item => item.id === session.id);
    if (index < 0) sessions.unshift(session); else sessions[index] = session;
    selectSession(session.id);
  } catch (error) { showError(error); }
};

async function upload(directory) {
  if (!activeId || uploading) return;
  const id = activeId;
  uploading = true;
  connectionUI({ status: window.workspaceState });
  try {
    const result = await api.upload(id, directory);
    addAttachments(id, result.files);
    if (id === activeId) await browse($('#file-path').value);
    if (result.errors.length) showError(new Error(result.errors.join('\n')));
  } catch (error) { showError(error); }
  finally { uploading = false; connectionUI({ status: window.workspaceState }); }
}
$('#upload-attachment').onclick = () => upload(activeSession()?.directory);
$('#upload-files').onclick = () => upload(currentListing?.path || $('#file-path').value);

// ---- Editor: tabs per conversation, next to the chat rather than a modal over it.
const tabsBySession = new Map();
let previewURL = null;
const tabs = (id = activeId) => { if (!tabsBySession.has(id)) tabsBySession.set(id, { list: [], active: null }); return tabsBySession.get(id); };
const activeTab = () => { const group = tabs(); return group.list.find(tab => tab.key === group.active) || null; };
const isDirty = tab => tab.draft !== undefined && tab.draft !== tab.result?.text;
function syncDirty() { void api.setEditorDirty([...tabsBySession.values()].some(group => group.list.some(isDirty))); }
window.openFileDirectories = () => tabs().list.filter(tab => !tab.diff).map(tab => (tab.result?.path || tab.path).replace(/\/[^/]*$/, '') || '/').filter(directory => directory.startsWith('/'));

function stashDraft() {
  const tab = activeTab(), editor = $('#remote-editor');
  if (tab && editor) tab.draft = editor.value;
}

function renderCode(result, line) {
  const wrapper = document.createElement('div'); wrapper.className = 'code-view';
  const lines = result.text.split('\n').length;
  const gutter = document.createElement('pre'); gutter.className = 'code-gutter'; gutter.setAttribute('aria-hidden', 'true');
  gutter.textContent = Array.from({ length: lines }, (_, index) => index + 1).join('\n');
  const pre = document.createElement('pre'); const code = document.createElement('code');
  const extension = (result.name.split('.').at(-1) || '').toLowerCase();
  if (window.hljs && result.text.length < 200000 && hljs.getLanguage(extension)) code.innerHTML = hljs.highlight(result.text, { language: extension, ignoreIllegals: true }).value;
  else code.textContent = result.text;
  pre.append(code); wrapper.append(gutter, pre);
  if (line) requestAnimationFrame(() => {
    const height = parseFloat(getComputedStyle(pre).lineHeight) || 20;
    $('#preview-content').scrollTop = Math.max(0, (line - 4) * height);
    const mark = document.createElement('div'); mark.className = 'line-mark'; mark.style.top = (line - 1) * height + parseFloat(getComputedStyle(pre).paddingTop || 0) + 'px';
    wrapper.append(mark);
  });
  return wrapper;
}

function renderTabContent(tab) {
  const content = $('#preview-content');
  if (previewURL) { URL.revokeObjectURL(previewURL); previewURL = null; }
  content.replaceChildren();
  const result = tab.result;
  $('#preview-conflict').hidden = !tab.conflict;
  $('#preview-conflict').textContent = tab.conflict ? '服务器上的文件已被修改。保存会被拒绝，请先复制你的修改再重新打开。' : '';
  $('#edit-preview').hidden = true; $('#save-preview').hidden = true; $('#render-preview').hidden = true;
  for (const selector of ['#attach-preview', '#download-preview', '#open-preview']) { $(selector).hidden = Boolean(tab.diff); $(selector).disabled = !result; }
  if (tab.error) { $('#preview-info').textContent = '无法预览'; content.textContent = tab.error; return; }
  if (tab.diff) {
    $('#preview-info').textContent = 'Git 变更';
    if (result) content.append(window.renderUnifiedDiff(result.text)); else $('#preview-info').textContent = '读取中…';
    return;
  }
  if (!result) { $('#preview-info').textContent = '读取中…'; return; }
  $('#preview-info').textContent = sizeText(result.size) + (result.truncated ? ' · 仅预览前 1 MB' : '');
  if (result.kind === 'text') {
    const editable = !result.truncated && result.revision;
    if (tab.draft !== undefined) {
      const editor = document.createElement('textarea'); editor.id = 'remote-editor'; editor.value = tab.draft;
      editor.oninput = () => { tab.draft = editor.value; syncDirty(); renderTabBar(); };
      editor.spellcheck = false; editor.setAttribute('aria-label', '远端文件内容');
      content.append(editor);
      $('#save-preview').hidden = false;
      return;
    }
    $('#edit-preview').hidden = !editable;
    const markdownFile = /\.(md|markdown)$/i.test(result.name) && !result.truncated;
    $('#render-preview').hidden = !markdownFile;
    $('#render-preview').textContent = tab.source ? '渲染' : '源码';
    if (markdownFile && !tab.source) { const page = window.renderMarkdownBlock(result.text); page.classList.add('markdown-page'); content.append(page); }
    else content.append(renderCode(result, tab.line));
  } else if (result.kind === 'image') {
    const image = document.createElement('img');
    image.alt = result.name;
    previewURL = URL.createObjectURL(new Blob([result.data], { type: result.mime }));
    image.src = previewURL;
    content.append(image);
  } else if (result.kind === 'pdf') {
    previewURL = URL.createObjectURL(new Blob([result.data], { type: 'application/pdf' }));
    const frame = document.createElement('iframe');
    frame.title = result.name;
    frame.src = previewURL;
    content.append(frame);
  } else {
    const note = document.createElement('div');
    note.className = 'preview-note';
    note.textContent = result.reason;
    content.append(note);
  }
}

function renderTabBar() {
  const group = tabs();
  $('#editor-tabs').replaceChildren(...group.list.map(tab => {
    const button = document.createElement('div');
    button.className = 'editor-tab' + (tab.key === group.active ? ' active' : '');
    button.title = tab.path;
    const label = document.createElement('button'); label.textContent = (isDirty(tab) ? '● ' : '') + tab.path.split('/').at(-1) + (tab.diff ? ' · 变更' : '');
    label.onclick = () => activateTab(tab.key);
    const close = document.createElement('button'); close.textContent = '×'; close.setAttribute('aria-label', '关闭 ' + tab.path);
    close.onclick = () => closeTab(tab);
    button.append(label, close);
    return button;
  }));
}

window.renderEditorTabs = () => {
  const tab = activeTab();
  $('#preview-dialog').hidden = !tab;
  document.body.classList.toggle('editor-open', Boolean(tab));
  renderTabBar();
  if (!tab) { if (previewURL) URL.revokeObjectURL(previewURL); previewURL = null; $('#preview-content').replaceChildren(); return; }
  $('#preview-name').textContent = tab.result?.name || tab.path.split('/').at(-1);
  $('#preview-path').textContent = tab.result?.path || tab.path;
  renderTabContent(tab);
};

function activateTab(key) {
  stashDraft();
  tabs().active = key;
  window.renderEditorTabs();
}

function closeTab(tab) {
  stashDraft();
  if (isDirty(tab) && !window.confirm('文件有未保存的修改，放弃修改？')) return false;
  const group = tabs();
  const index = group.list.indexOf(tab);
  group.list.splice(index, 1);
  if (group.active === tab.key) group.active = (group.list[index] || group.list[index - 1])?.key ?? null;
  syncDirty(); window.renderEditorTabs(); syncWatches();
  return true;
}
window.closeActiveTab = () => { const tab = activeTab(); if (!tab) return false; closeTab(tab); return true; };

function openTab(key, path, extra) {
  stashDraft();
  const group = tabs();
  let tab = group.list.find(item => item.key === key);
  if (tab) { Object.assign(tab, extra); group.active = key; window.renderEditorTabs(); return { tab, created: false }; }
  // Images and PDFs hold their bytes in memory, so old clean tabs are dropped.
  while (group.list.length >= 12) { const old = group.list.find(item => !isDirty(item) && item.key !== group.active); if (!old) break; group.list.splice(group.list.indexOf(old), 1); }
  tab = { key, path, ...extra };
  group.list.push(tab); group.active = key;
  window.renderEditorTabs();
  return { tab, created: true };
}

window.openRemotePreview = async (file, line) => {
  if (!activeId || window.workspaceState !== 'connected') return showError(new Error('请先连接 SSH 服务器'));
  const id = activeId;
  const existing = tabs().list.find(item => !item.diff && (item.path === file || item.result?.path === file));
  const { tab } = openTab(existing?.key || 'file:' + file, file, { line });
  try {
    const result = await api.preview(id, file);
    tab.result = result; tab.path = result.path; delete tab.error;
    if (id === activeId && activeTab() === tab) { window.renderEditorTabs(); syncWatches(); }
  } catch (error) {
    if (/取消/.test(error.message)) return;
    tab.error = error.message;
    if (id === activeId && activeTab() === tab) window.renderEditorTabs();
  }
};

window.openRemoteDiff = async file => {
  const id = activeId;
  const { tab } = openTab('diff:' + file, file, { diff: true, result: null });
  try {
    tab.result = await api.gitFileDiff(id, file);
    if (id === activeId && activeTab() === tab) window.renderEditorTabs();
  } catch (error) { tab.error = error.message; if (id === activeId && activeTab() === tab) window.renderEditorTabs(); }
};

// An open file follows the server unless it holds unsaved edits, which are flagged instead.
window.refreshOpenFiles = directories => {
  const id = activeId;
  for (const tab of tabs().list) {
    if (!directories.includes(tab.path.replace(/\/[^/]*$/, '') || '/')) continue;
    if (tab.diff) { void api.gitFileDiff(id, tab.path).then(result => { tab.result = result; if (activeTab() === tab) window.renderEditorTabs(); }).catch(() => {}); continue; }
    void api.refreshFile(id, tab.path).then(result => {
      if (result.version === tab.result?.version) return;
      if (tab.draft !== undefined && isDirty(tab)) { tab.conflict = true; if (activeTab() === tab) { stashDraft(); window.renderEditorTabs(); } return; }
      const content = $('#preview-content'), top = content.scrollTop;
      tab.result = result; delete tab.draft; delete tab.conflict; delete tab.line;
      if (id === activeId && activeTab() === tab) { window.renderEditorTabs(); content.scrollTop = top; }
    }).catch(error => { tab.error = error.message; if (activeTab() === tab) window.renderEditorTabs(); });
  }
};

$('#close-preview').onclick = () => window.closeActiveTab();
$('#attach-preview').onclick = async () => {
  const tab = activeTab();
  if (!tab?.result) return;
  try {
    addAttachments(activeId, [await api.attach(activeId, tab.result.path)]);
    $('#prompt').focus();
  } catch (error) { showError(error); }
};
$('#download-preview').onclick = async () => {
  const tab = activeTab();
  if (!tab?.result) return;
  $('#download-preview').disabled = true;
  try { const result = await api.download(activeId, tab.result.path); if (result) showError({ message: '已下载到 ' + result }); }
  catch (error) { showError(error); }
  finally { $('#download-preview').disabled = false; }
};
$('#open-preview').onclick = async () => {
  const tab = activeTab();
  if (!tab?.result) return;
  $('#open-preview').disabled = true;
  try { await api.openFile(activeId, tab.result.path); }
  catch (error) { showError(error); }
  finally { $('#open-preview').disabled = false; }
};
$('#render-preview').onclick = () => {
  const tab = activeTab();
  if (tab) { tab.source = !tab.source; window.renderEditorTabs(); }
};
api.onConnection(async () => {
  const id = activeId;
  if (!connectionConfig().host) return;
  try {
    const state = await api.connectionState(connectionConfig());
    if (id !== activeId) return;
    const wasConnected = window.workspaceState === 'connected';
    connectionUI(state);
    // After an automatic reconnect the tree reloads and its watches are re-established.
    if (state.status === 'connected' && !wasConnected && activeId) await browse($('#file-path').value, true);
  } catch (error) { showError(error); }
});
api.onProgress(event => {
  if (event.sessionId !== activeId) return;
  $('#transfer-status').textContent = event.error ? `${event.name} · 失败` : event.done ? `${event.name} · 完成` :
    `${event.name} · ${event.total ? Math.min(99, Math.round(event.bytes / event.total * 100)) : 0}%`;
});
let lastBusy = new Map(), lastPoll = 0;
api.onChanged(session => {
  const wasBusy = lastBusy.get(session.id);
  const busy = busyStates.has(session.status);
  lastBusy.set(session.id, busy);
  if (wasBusy && !busy && session.id === activeId && window.workspaceState === 'connected') browse($('#file-path').value, true);
  // Watches cannot cover this server, so follow Claude's tool activity instead.
  else if (busy && window.watchFailed && session.id === activeId && Date.now() - lastPoll > 3000) { lastPoll = Date.now(); browse($('#file-path').value, true); }
});

$('#edit-preview').onclick = () => {
  const tab = activeTab();
  if (!tab?.result || tab.result.kind !== 'text' || tab.result.truncated) return;
  tab.draft = tab.result.text;
  window.renderEditorTabs();
  $('#remote-editor').focus();
};
$('#save-preview').onclick = async () => {
  const tab = activeTab();
  const editor = $('#remote-editor');
  if (!tab || !editor) return;
  $('#save-preview').disabled = true;
  try {
    const saved = await api.saveFile(activeId, tab.result.path, editor.value, tab.result.revision);
    tab.result = saved; tab.draft = saved.text; delete tab.conflict;
    syncDirty(); renderTabBar();
    if (activeTab() === tab) { $('#preview-info').textContent = '已保存到远端'; $('#preview-conflict').hidden = true; }
  } catch (error) { $('#preview-info').textContent = error.message; }
  finally { $('#save-preview').disabled = false; }
};

document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && $('#remote-editor')) {
    event.preventDefault(); if (!$('#save-preview').disabled) $('#save-preview').click();
  }
});

api.onRecoveryError(message => showError(new Error(message)));
