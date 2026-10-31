let mentionTimer;
let mentionSequence = 0;
let mentionSelection = 0;
let mentionResults = [];
let mentionMatch = null;
function currentMention() {
  const input = $('#prompt');
  if (input.selectionStart !== input.selectionEnd) return null;
  const match = /(?:^|\s)@([^\s@]*)$/.exec(input.value.slice(0, input.selectionStart));
  return match ? { query: match[1], start: input.selectionStart - match[1].length - 1, end: input.selectionStart } : null;
}
function closeMentions() { ++mentionSequence; $('#mention-menu').hidden = true; mentionMatch = null; }
function renderMentions() {
  const menu = $('#mention-menu'); menu.replaceChildren();
  mentionResults.forEach((file, index) => {
    const button = document.createElement('button'); button.type = 'button';
    button.className = 'command-item' + (index === mentionSelection ? ' selected' : '');
    button.setAttribute('role', 'option'); button.setAttribute('aria-selected', index === mentionSelection);
    button.textContent = file.relative; button.title = file.path;
    button.onclick = () => selectMention(file).catch(showError); menu.append(button);
  });
  if (!mentionResults.length) menu.textContent = '没有匹配文件';
  menu.hidden = false;
  menu.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
}
async function selectMention(file) {
  const id = activeId;
  const match = mentionMatch;
  const before = $('#prompt').value;
  closeMentions();
  const attachment = await api.attach(id, file.path);
  addAttachments(id, [attachment]);
  if (activeId === id && $('#prompt').value === before && match) {
    $('#prompt').setRangeText('', match.start, match.end, 'end');
    resizePrompt(); updateUI(); $('#prompt').focus();
  }
}
$('#prompt').addEventListener('input', () => {
  clearTimeout(mentionTimer);
  const match = currentMention();
  if (!match || !activeId || window.workspaceState !== 'connected') return closeMentions();
  const sequence = ++mentionSequence;
  const id = activeId;
  $('#mention-menu').hidden = true;
  mentionTimer = setTimeout(async () => {
    try {
      const result = await api.suggestFiles(id, match.query);
      if (sequence !== mentionSequence || activeId !== id) return;
      mentionMatch = match; mentionResults = result.files; mentionSelection = 0; renderMentions();
    } catch (error) { if (sequence === mentionSequence) { closeMentions(); showError(error); } }
  }, 250);
});
$('#prompt').addEventListener('keydown', event => {
  if ($('#mention-menu').hidden || event.isComposing) return;
  if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (event.key === 'Escape') return closeMentions();
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    mentionSelection = (mentionSelection + (event.key === 'ArrowDown' ? 1 : -1) + mentionResults.length) % (mentionResults.length || 1);
    renderMentions();
  } else if (mentionResults[mentionSelection]) selectMention(mentionResults[mentionSelection]).catch(showError);
}, true);

async function inputUpload(action) {
  if (!activeId || window.workspaceState !== 'connected') return showError(new Error('请先连接 SSH'));
  if (uploading) return showError(new Error('请等待当前上传完成'));
  const id = activeId;
  uploading = true;
  try {
    const result = await action(id);
    addAttachments(id, result.files);
    if (result.errors?.length) showError(new Error(result.errors.join('\n')));
    if (id === activeId) await browse($('#file-path').value);
  } catch (error) { showError(error); }
  finally { uploading = false; connectionUI({ status: window.workspaceState }); }
}
// Files are converted to native paths in preload, never from renderer-provided strings.
$('#composer').addEventListener('dragover', event => {
  if (!event.dataTransfer.types.includes('Files')) return;
  event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; $('#composer').classList.add('drop-target');
});
$('#composer').addEventListener('dragleave', () => $('#composer').classList.remove('drop-target'));
$('#composer').addEventListener('drop', event => {
  event.preventDefault(); $('#composer').classList.remove('drop-target');
  const files = [...event.dataTransfer.files];
  if (files.length) void inputUpload(id => api.uploadDropped(id, files));
});
$('#prompt').addEventListener('paste', event => {
  const item = [...event.clipboardData.items].find(item => item.kind === 'file' && item.type.startsWith('image/'));
  const file = item?.getAsFile();
  if (!file) return;
  event.preventDefault();
  if (file.size > 20 * 1024 * 1024) return showError(new Error('图片不能超过 20 MB'));
  void inputUpload(async id => ({ files: [await api.pasteImage(id, await file.arrayBuffer())] }));
});

window.closeFileMentions = closeMentions;
