const attachmentDrafts = new Map();
const folderBySession = new Map();
let currentListing = null;
let browseSequence = 0;
let previewSequence = 0;
let previewFile = null;
let previewURL = null;
let uploading = false;
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
  for (const selector of ['#upload-files', '#upload-attachment', '#refresh-files', '#use-folder', '#parent-folder'])
    $(selector).disabled = state.status !== 'connected' || uploading;
  updateUI();
  if (state.status === 'connected') window.controlsChanged?.();
}

window.workspaceChanged = async () => {
  const id = activeId;
  ++browseSequence;
  void api.cancelFiles('list');
  void api.cancelFiles('preview');
  currentListing = null;
  $('#file-path').value = folderBySession.get(id) || connectionConfig().directory;
  $('#file-list').replaceChildren();
  $('#file-footer').textContent = '';
  $('#file-error').textContent = '';
  renderAttachments();
  connectionUI({ status: 'disconnected' });
  try {
    const state = await api.connectionState(connectionConfig());
    if (id !== activeId) return;
    connectionUI(state);
    if (state.status === 'connected' && activeId) await browse($('#file-path').value);
    else $('#file-list').innerHTML = '<div class="file-empty">未连接 SSH</div>';
  } catch (error) { showError(error); }
};

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
    $('#file-list').replaceChildren();
    for (const file of listing.entries) {
      const row = document.createElement('button');
      row.className = 'file-entry';
      row.title = file.path;
      const icon = document.createElement('span');
      icon.className = 'file-icon';
      icon.textContent = file.directory ? '▸' : '·';
      const name = document.createElement('span');
      name.className = 'file-name';
      name.textContent = file.name + (file.symlink ? ' ↗' : '');
      const size = document.createElement('span');
      size.className = 'file-size';
      size.textContent = file.directory ? '' : sizeText(file.size);
      row.append(icon, name, size);
      row.onclick = () => file.directory ? browse(file.path) : window.openRemotePreview(file.path);
      $('#file-list').append(row);
    }
    if (!listing.entries.length) $('#file-list').innerHTML = '<div class="file-empty">空目录</div>';
    $('#file-footer').textContent = `${listing.entries.length} 项${listing.truncated ? ' · 仅显示前 5000 项' : ''}`;
  } catch (error) {
    if (id === activeId && sequence === browseSequence) {
      $('#file-error').textContent = error.message;
      $('#file-footer').textContent = '读取失败';
    }
  }
}

async function connect(config) {
  connectionUI({ status: 'connecting' });
  try {
    const result = await api.connect(config);
    defaults = { host: result.host, directory: config.directory || result.home, ...(result.port ? { port: result.port } : {}) };
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
  form.elements.host.value = config.host;
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
$('#connect-server').onclick = () => connect(connectionConfig()).catch(showError);
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

function clearPreview() {
  void api.setEditorDirty(false);
  if (previewURL) URL.revokeObjectURL(previewURL);
  previewURL = null;
  $('#preview-content').replaceChildren();
}
function mayDiscardEdits() {
  const editor = $('#remote-editor');
  return !editor || editor.value === previewFile?.text || window.confirm('文件有未保存的修改，放弃修改？');
}
window.openRemotePreview = async file => {
  if (!mayDiscardEdits()) return;
  if (!activeId || window.workspaceState !== 'connected') return showError(new Error('请先连接 SSH 服务器'));
  const sequence = ++previewSequence;
  const id = activeId;
  previewFile = null;
  $('#edit-preview').hidden = true;
  $('#save-preview').hidden = true;
  clearPreview();
  $('#preview-name').textContent = file.split('/').at(-1);
  $('#preview-path').textContent = file;
  $('#preview-info').textContent = '读取中…';
  for (const selector of ['#attach-preview', '#download-preview', '#open-preview']) $(selector).disabled = true;
  if (!$('#preview-dialog').open) $('#preview-dialog').showModal();
  try {
    const result = await api.preview(id, file);
    if (sequence !== previewSequence || !$('#preview-dialog').open) return;
    previewFile = { ...result, sessionId: id };
    $('#preview-name').textContent = result.name;
    $('#preview-path').textContent = result.path;
    $('#preview-info').textContent = sizeText(result.size) + (result.truncated ? ' · 仅预览前 1 MB' : '');
    for (const selector of ['#attach-preview', '#download-preview', '#open-preview']) $(selector).disabled = false;
    if (result.kind === 'text') {
      $('#edit-preview').hidden = result.truncated || !result.revision;
      const pre = document.createElement('pre');
      pre.textContent = result.text;
      $('#preview-content').append(pre);
    } else if (result.kind === 'image') {
      const image = document.createElement('img');
      image.alt = result.name;
      previewURL = URL.createObjectURL(new Blob([result.data], { type: result.mime }));
      image.src = previewURL;
      $('#preview-content').append(image);
    } else if (result.kind === 'pdf') {
      const bytes = result.data;
      previewURL = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      const frame = document.createElement('iframe');
      frame.title = result.name;
      frame.src = previewURL;
      $('#preview-content').append(frame);
    } else {
      const note = document.createElement('div');
      note.className = 'preview-note';
      note.textContent = result.reason;
      $('#preview-content').append(note);
    }
  } catch (error) { $('#preview-info').textContent = '无法预览'; $('#preview-content').textContent = error.message; }
};
$('#close-preview').onclick = () => { if (mayDiscardEdits()) $('#preview-dialog').close(); };
$('#preview-dialog').addEventListener('cancel', event => { if (!mayDiscardEdits()) event.preventDefault(); });
$('#preview-dialog').addEventListener('close', () => { ++previewSequence; void api.cancelFiles('preview'); clearPreview(); });
$('#attach-preview').onclick = async () => {
  const file = previewFile;
  if (!file) return;
  try {
    addAttachments(file.sessionId, [await api.attach(file.sessionId, file.path)]);
    if (mayDiscardEdits()) $('#preview-dialog').close(); $('#prompt').focus();
  } catch (error) { showError(error); }
};
$('#download-preview').onclick = async () => {
  const file = previewFile;
  if (!file) return;
  $('#download-preview').disabled = true;
  try { const result = await api.download(file.sessionId, file.path); if (result) showError({ message: '已下载到 ' + result }); }
  catch (error) { showError(error); }
  finally { $('#download-preview').disabled = false; }
};
$('#open-preview').onclick = async () => {
  const file = previewFile;
  if (!file) return;
  $('#open-preview').disabled = true;
  try { await api.openFile(file.sessionId, file.path); }
  catch (error) { showError(error); }
  finally { $('#open-preview').disabled = false; }
};
api.onConnection(async () => {
  const id = activeId;
  try { const state = await api.connectionState(connectionConfig()); if (id === activeId) connectionUI(state); }
  catch (error) { showError(error); }
});
api.onProgress(event => {
  if (event.sessionId !== activeId) return;
  $('#transfer-status').textContent = event.error ? `${event.name} · 失败` : event.done ? `${event.name} · 完成` :
    `${event.name} · ${event.total ? Math.min(99, Math.round(event.bytes / event.total * 100)) : 0}%`;
});
let lastBusy = new Map();
api.onChanged(session => {
  const wasBusy = lastBusy.get(session.id);
  const busy = busyStates.has(session.status);
  lastBusy.set(session.id, busy);
  if (wasBusy && !busy && session.id === activeId && window.workspaceState === 'connected') browse($('#file-path').value, true);
});

$('#edit-preview').onclick = () => {
  if (!previewFile || previewFile.kind !== 'text' || previewFile.truncated) return;
  const editor = document.createElement('textarea'); editor.id = 'remote-editor'; editor.value = previewFile.text;
  editor.oninput = () => { void api.setEditorDirty(editor.value !== previewFile?.text); };
  editor.spellcheck = false; editor.setAttribute('aria-label', '远端文件内容');
  $('#preview-content').replaceChildren(editor); $('#edit-preview').hidden = true; $('#save-preview').hidden = false;
};
$('#save-preview').onclick = async () => {
  const file = previewFile;
  const editor = $('#remote-editor');
  if (!file || !editor) return;
  $('#save-preview').disabled = true;
  try {
    const saved = await api.saveFile(file.sessionId, file.path, editor.value, file.revision);
    if (previewFile === file) { previewFile = { ...saved, sessionId: file.sessionId }; $('#preview-info').textContent = '已保存到远端'; void api.setEditorDirty(editor.value !== saved.text); }
  } catch (error) { $('#preview-info').textContent = error.message; }
  finally { $('#save-preview').disabled = false; }
};

document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && $('#remote-editor')) {
    event.preventDefault(); if (!$('#save-preview').disabled) $('#save-preview').click();
  }
});

api.onRecoveryError(message => showError(new Error(message)));
