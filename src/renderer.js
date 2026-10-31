const api = window.remoteCC;
const $ = selector => document.querySelector(selector);
const busyStates = new Set(['connecting', 'working', 'permission', 'stopping', 'detached']);
const statusLabels = { detached: '远端任务待同步', idle: '就绪', connecting: '连接中', working: '正在回复', permission: '等待你的确认', stopping: '正在停止', stopped: '已停止', error: '调用未完成' };
let sessions = [];
let activeId = null;
let defaults = { host: '', directory: '~' };
try { Object.assign(defaults, JSON.parse(localStorage.getItem('last-connection') || '{}')); } catch { /* Ignore a corrupt saved connection. */ }
let toastTimer;
let permissionSignature = '';
let submitting = false;
let showArchived = false;
const drafts = new Map();
const renderedMessages = new Map();

function showError(error) {
  $('#toast').textContent = error.message || String(error);
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 6500);
}
const activeSession = () => sessions.find(item => item.id === activeId);
const timeLabel = date => new Date(date).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

const escapeHTML = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const markdownRenderer = new marked.Renderer();
markdownRenderer.image = ({ href, text }) => `<a href="${escapeHTML(href.replace(/^file:\/\//, ''))}">${escapeHTML(text || href)}</a>`;
markdownRenderer.link = function ({ href, tokens }) {
  return `<a href="${escapeHTML(href.replace(/^file:\/\//, ''))}">${this.parser.parseInline(tokens)}</a>`;
};
function markdown(text) {
  return DOMPurify.sanitize(marked.parse(text || '', { breaks: true, gfm: true, renderer: markdownRenderer }), {
    FORBID_TAGS: ['img', 'style', 'form', 'input', 'button', 'iframe', 'video', 'audio'],
    FORBID_ATTR: ['style'],
  });
}

function copyText(text, button) {
  navigator.clipboard.writeText(text).then(() => {
    const label = button.textContent;
    button.textContent = '已复制';
    setTimeout(() => { if (button.isConnected) button.textContent = label; }, 1300);
  }).catch(showError);
}

const remotePathPattern = /^(\/|~\/|\.\.?\/)[^\n]+$|^[\w.@-]+(\/[\w.@-]+)+$|^[\w.@-]+\.(js|cjs|mjs|ts|tsx|jsx|py|go|rs|java|c|h|cpp|cs|rb|php|sh|md|txt|json|yaml|yml|toml|html|css|sql|csv|png|jpg|jpeg|gif|webp|pdf|log)$/i;
function highlightCode(code) {
  const language = /language-([\w-]+)/.exec(code.className)?.[1];
  if (window.hljs && language && hljs.getLanguage(language) && code.textContent.length < 100000) hljs.highlightElement(code);
}
function textBlock(text, highlight = true) {
  const element = document.createElement('div');
  element.className = 'markdown';
  element.innerHTML = markdown(text);
  for (const pre of element.querySelectorAll('pre')) {
    const code = pre.querySelector('code');
    if (highlight && code) highlightCode(code);
    const button = document.createElement('button');
    button.className = 'code-copy';
    button.textContent = '复制代码';
    button.onclick = () => copyText(code?.textContent || '', button);
    pre.append(button);
  }
  for (const code of element.querySelectorAll('p > code, li > code, td > code')) {
    const located = /^(.+?)(?::(\d+))?(?::\d+)?$/.exec(code.textContent);
    if (located && remotePathPattern.test(located[1])) {
      const button = document.createElement('button');
      button.className = 'remote-file-link';
      button.textContent = code.textContent;
      button.onclick = () => window.openRemotePreview(located[1], located[2] ? Number(located[2]) : undefined);
      code.replaceWith(button);
    }
  }
  return element;
}
window.renderMarkdownBlock = text => textBlock(text);

function contentBlock(block, message, index, openTools, streaming) {
  if (block.type === 'text' && block.text) return textBlock(block.text, !streaming);
  if (block.type === 'thinking' && block.text) {
    const details = document.createElement('details'); details.className = 'thinking-card';
    details.dataset.toolId = 'thinking-' + message.id + '-' + index;
    details.open = openTools.has(details.dataset.toolId);
    const summary = document.createElement('summary'); summary.textContent = '思考过程';
    const content = document.createElement('pre'); content.textContent = block.text;
    details.append(summary, content);
    return details;
  }
  if (block.type === 'tool') return window.renderToolBlock(block, openTools);
  if (block.type === 'notice') {
    const notice = document.createElement('div');
    notice.className = 'system-notice ' + (block.level || 'info');
    notice.textContent = block.text;
    return notice;
  }
  const empty = document.createElement('span'); empty.hidden = true;
  return empty;
}

function messageFooter(message, busy) {
  const footer = document.createElement('div');
  footer.className = 'message-footer';
  if (message.error) {
    const error = document.createElement('div');
    error.className = 'message-error';
    error.textContent = message.error;
    footer.append(error);
  }
  if (busy && !message.error) {
    const indicator = document.createElement('div');
    indicator.className = 'typing';
    indicator.setAttribute('aria-label', 'Claude 正在回复');
    indicator.innerHTML = '<span></span><span></span><span></span>';
    footer.append(indicator);
  }
  if (message.interrupted) {
    const note = document.createElement('div');
    note.className = 'interrupted';
    note.textContent = '已停止生成 · 可以发送下一条消息继续';
    footer.append(note);
  }
  const text = message.blocks.filter(block => block.type === 'text').map(block => block.text).join('\n\n');
  if (!busy && (text || message.durationMs)) {
    const row = document.createElement('div'); row.className = 'message-meta';
    if (text) {
      const copy = document.createElement('button');
      copy.className = 'copy-message';
      copy.textContent = '复制回复';
      copy.onclick = () => copyText(text, copy);
      row.append(copy);
    }
    const parts = [message.model, message.durationMs ? (message.durationMs / 1000).toFixed(1) + 's' : '', message.costUSD ? '$' + message.costUSD.toFixed(4) : ''].filter(Boolean);
    if (parts.length) { const info = document.createElement('span'); info.textContent = parts.join(' · '); row.append(info); }
    footer.append(row);
  }
  return footer;
}

// Only blocks whose content changed are rebuilt, so streaming never re-parses the whole reply.
function updateMessageBody(body, message, busy) {
  const openTools = new Set();
  for (const item of body.querySelectorAll(':scope > details')) {
    if (item.open) openTools.add(item.dataset.toolId);
    else openTools.add('closed:' + item.dataset.toolId);
  }
  const previous = body._blocks || [];
  const nodes = message.blocks.map((block, index) => {
    const streaming = busy && index === message.blocks.length - 1;
    const signature = JSON.stringify(block) + streaming;
    if (previous[index]?.signature === signature) return previous[index];
    const node = contentBlock(block, message, index, openTools, streaming);
    if (previous[index]) previous[index].node.replaceWith(node);
    return { signature, node };
  });
  for (const stale of previous.slice(nodes.length)) stale.node.remove();
  for (const entry of nodes) if (!entry.node.parentNode) body.append(entry.node);
  body._blocks = nodes;
  body._footer?.remove();
  body._footer = messageFooter(message, busy);
  body.append(body._footer);
}

function messageElement(message, busy) {
  const article = document.createElement('article');
  article.className = `message ${message.role}`;
  article.dataset.messageId = message.id;
  if (message.role === 'user') {
    const bubble = document.createElement('div');
    bubble.className = 'user-bubble';
    bubble.textContent = message.text;
    const time = document.createElement('div');
    time.className = 'message-time';
    time.textContent = timeLabel(message.createdAt);
    article.append(bubble);
    if (message.attachments?.length) article.append(window.messageAttachments(message.attachments));
    article.append(time);
    return article;
  }
  const heading = document.createElement('div');
  heading.className = 'message-heading';
  heading.innerHTML = '<span class="assistant-symbol">✳</span><span>Claude</span><small>REMOTE</small>';
  const body = document.createElement('div');
  body.className = 'message-body';
  updateMessageBody(body, message, busy);
  article.append(heading, body);
  return article;
}

function renderMessages(session) {
  const scroll = $('#scroll-area');
  const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
  const messages = session?.messages || [];
  $('#welcome').hidden = messages.length > 0;
  for (const [index, message] of messages.entries()) {
    const busy = index === messages.length - 1 && busyStates.has(session.status);
    const cached = renderedMessages.get(message.id);
    if (index < messages.length - 1 && cached?.message === message && cached.busy === busy) continue;
    const signature = JSON.stringify(message) + busy;
    if (renderedMessages.get(message.id)?.signature === signature) continue;
    const previous = renderedMessages.get(message.id)?.element;
    let element = previous;
    if (previous && message.role === 'assistant') updateMessageBody(previous.querySelector('.message-body'), message, busy);
    else {
      element = messageElement(message, busy);
      if (previous) previous.replaceWith(element);
      else $('#messages').insertBefore(element, $('#messages').children[index] || null);
    }
    renderedMessages.set(message.id, { signature, element, message, busy });
  }
  if (atBottom) requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
}

const projectExpansion = new Map(JSON.parse(localStorage.getItem('project-expansion') || '[]'));

function projectKey(session) {
  const directory = session.directory === '/' ? '/' : session.directory.replace(/\/+$/, '');
  return JSON.stringify([session.host, session.port || '', directory]);
}

function chatListItem(session) {
  const button = document.createElement('button');
  button.className = 'chat-item' + (session.id === activeId ? ' active' : '');
  const name = document.createElement('strong');
  name.textContent = (session.pinned ? '• ' : '') + session.name;
  const detail = document.createElement('small');
  detail.textContent = busyStates.has(session.status) ? statusLabels[session.status] : new Date(session.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  button.append(name, detail);
  button.onclick = () => selectSession(session.id);
  return button;
}

function projectListGroup(key, items, searching) {
  const session = items[0];
  const group = document.createElement('details');
  group.className = 'project-group';
  group.dataset.project = key;
  group.open = searching || (projectExpansion.get(key) ?? items.some(item => item.id === activeId));
  const heading = document.createElement('summary');
  const name = document.createElement('span'); name.className = 'project-name';
  name.textContent = session.directory.split('/').filter(Boolean).at(-1) || '/';
  heading.title = `${session.host}${session.port ? ':' + session.port : ''} · ${session.directory}`;
  const count = document.createElement('small'); count.textContent = items.length;
  const add = document.createElement('button'); add.className = 'project-new'; add.textContent = '+';
  add.setAttribute('aria-label', '在 ' + session.directory + ' 新建对话');
  add.onclick = async event => {
    event.preventDefault(); event.stopPropagation();
    try {
      const created = await api.create({ host: session.host, port: session.port, directory: session.directory, name: '新对话' });
      if (!sessions.some(item => item.id === created.id)) sessions.unshift(created);
      projectExpansion.set(key, true); selectSession(created.id);
    } catch (error) { showError(error); }
  };
  heading.append(name, count, add);
  const location = document.createElement('div'); location.className = 'project-location';
  location.textContent = heading.title; location.title = heading.title;
  const chats = document.createElement('div'); chats.className = 'project-chats';
  chats.append(location);
  let populated = false;
  const populate = () => {
    if (populated || !group.open) return;
    chats.append(...items.map(chatListItem)); populated = true;
  };
  populate();
  group.addEventListener('toggle', populate);
  group.append(heading, chats);
  heading.addEventListener('click', event => {
    if (event.target.closest('button') || searching) return;
    projectExpansion.set(key, !group.open);
    localStorage.setItem('project-expansion', JSON.stringify([...projectExpansion]));
  });
  return group;
}

let listSignature = '';
function renderList() {
  const signature = JSON.stringify([activeId, showArchived, $('#search').value, [...projectExpansion], sessions.map(s => [s.id, s.name, s.host, s.port, s.directory, s.updatedAt, s.status, s.archived, s.pinned, s.historySummary])]);
  if (signature === listSignature) return;
  listSignature = signature;
  const filter = $('#search').value.trim().toLowerCase();
  const visible = [...sessions].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt)
    .filter(session => Boolean(session.archived) === showArchived)
    .filter(session => `${session.name} ${session.host} ${session.directory} ${session.historySummary || ''}`.toLowerCase().includes(filter));
  const groups = new Map();
  for (const session of visible) {
    const key = projectKey(session);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(session);
  }
  $('#chat-count').textContent = `${groups.size} / ${visible.length}`;
  $('#chat-count').title = `${groups.size} 个项目，${visible.length} 条对话`;
  $('#chat-list').replaceChildren(...[...groups].map(([key, items]) => projectListGroup(key, items, Boolean(filter))));
  if (!visible.length) {
    const empty = document.createElement('div'); empty.className = 'chat-empty';
    empty.textContent = filter ? '没有找到相关对话' : '你的项目会显示在这里';
    $('#chat-list').append(empty);
  }
}

function questionFields(permission) {
  const fields = document.createElement('div');
  for (const question of permission.input.questions || []) {
    const label = document.createElement('label');
    label.append(document.createTextNode(question.question));
    const input = document.createElement('input');
    input.dataset.question = question.question;
    input.placeholder = '输入你的回答，也可选择下方建议';
    label.append(input);
    fields.append(label);
    const options = document.createElement('div');
    options.className = 'answer-options';
    const selected = new Set();
    const buttons = [];
    const sync = () => {
      for (const button of buttons) {
        const checked = selected.has(button.textContent);
        button.setAttribute('aria-pressed', String(checked));
        button.classList.toggle('selected', checked);
      }
    };
    input.oninput = () => { selected.clear(); sync(); };
    for (const option of question.options || []) {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = option.label;
      button.title = option.description || '';
      button.setAttribute('aria-pressed', 'false');
      button.onclick = () => {
        if (question.multiSelect && selected.has(option.label)) selected.delete(option.label);
        else { if (!question.multiSelect) selected.clear(); selected.add(option.label); }
        input.value = [...selected].join(', ');
        sync();
      };
      buttons.push(button); options.append(button);
    }
    fields.append(options);
  }
  return fields;
}

function renderPermissions(session) {
  const permissions = session?.permissions || [];
  const signature = JSON.stringify(permissions);
  if (permissionSignature === signature) return;
  permissionSignature = signature;
  $('#permissions').replaceChildren();
  for (const permission of permissions) {
    if (permission.kind === 'elicitation') { $('#permissions').append(window.renderStructuredRequest(session, permission)); continue; }
    const card = document.createElement('section');
    card.className = 'permission-card';
    const title = document.createElement('h3');
    title.textContent = permission.name === 'AskUserQuestion' ? 'Claude 想确认一下' : permission.name === 'ExitPlanMode' ? 'Claude 的计划，确认后开始执行' : permission.title;
    card.append(title);
    if (permission.description) {
      const description = document.createElement('p');
      description.textContent = permission.description;
      card.append(description);
    }
    if (permission.name === 'AskUserQuestion') card.append(questionFields(permission));
    else card.append(window.renderToolRequest(permission.name, permission.input));
    let suggested;
    if (permission.suggestions?.length) {
      const details = document.createElement('details');
      const heading = document.createElement('summary'); heading.textContent = '远端建议的权限规则';
      const rules = document.createElement('pre'); rules.textContent = JSON.stringify(permission.suggestions, null, 2);
      details.append(heading, rules); card.append(details);
      const label = document.createElement('label');
      suggested = document.createElement('input'); suggested.type = 'checkbox'; suggested.className = 'permission-suggestions';
      const destinations = { session: '本次运行', localSettings: '此项目的本地设置', projectSettings: '此项目的共享设置', userSettings: '远端用户的所有项目', cliArg: '本次启动参数' };
      const scope = [...new Set(permission.suggestions.map(rule => destinations[rule.destination] || rule.destination))].join('、');
      label.append(suggested, document.createTextNode('应用以上权限规则 · ' + scope));
      card.append(label);
    }
    const reason = document.createElement('textarea'); reason.placeholder = '拒绝时给 Claude 的说明（可选）';
    reason.setAttribute('aria-label', '拒绝说明'); card.append(reason);
    const actions = document.createElement('div');
    actions.className = 'permission-actions';
    for (const allow of [false, true]) {
      const button = document.createElement('button');
      button.textContent = allow ? (permission.name === 'AskUserQuestion' ? '提交回答' : '允许这一次') : '拒绝';
      if (allow) {
        button.className = 'accent-button';
        if (suggested) suggested.onchange = () => { button.textContent = suggested.checked ? '应用规则并允许' : '允许这一次'; };
      }
      button.onclick = async () => {
        const answers = Object.fromEntries([...card.querySelectorAll('input[data-question]')].map(input => [input.dataset.question, input.value]));
        if (allow && Object.values(answers).some(value => !value.trim())) return showError(new Error('请填写回答'));
        for (const action of actions.children) action.disabled = true;
        try { await api.respond(session.id, permission.id, { allow, answers, useSuggestedPermissions: allow && suggested?.checked === true, reason: reason.value }); }
        catch (error) { showError(error); for (const action of actions.children) action.disabled = false; }
      };
      actions.append(button);
    }
    card.append(actions);
    $('#permissions').append(card);
  }
}

function updateUI() {
  const session = activeSession();
  const connection = session || defaults;
  const busy = busyStates.has(session?.status);
  $('#chat-title').textContent = session?.name || '新对话';
  $('#header-host').textContent = connection.host;
  $('#sidebar-host').textContent = connection.host || '未配置服务器';
  $('#workspace-label').textContent = connection.host || '未连接';
  $('#workspace-directory').textContent = connection.directory;
  $('#workspace-directory').title = connection.directory;
  const selectedModel = session?.preferences?.selectedModel;
  const modelEntry = session?.capabilities?.models.find(model => model.value === (selectedModel || 'default'));
  $('#model-label').textContent = (modelEntry?.displayName || selectedModel || session?.model || '模型') + ' ▾';
  $('#model-label').title = session?.model ? '上一轮实际模型：' + session.model : '选择模型';
  $('#mode-label').textContent = { default: '默认权限', plan: '计划', acceptEdits: '自动编辑', dontAsk: '拒绝未授权', auto: '自动权限' }[session?.preferences?.permissionMode || 'default'];
  $('#connection-status').textContent = statusLabels[session?.status || 'idle'];
  $('#connection-status').title = session?.transportError || '';
  $('#activity-text').textContent = session?.status === 'detached' ? '重新连接 SSH 后同步远端任务' : busy ? (window.currentActivity(session) || statusLabels[session.status]) + ' · Enter 排队' : 'Enter 发送 · Shift + Enter 换行';
  $('#send-message').hidden = false;
  $('#send-message').title = busy ? '排队，当前回复完成后发送' : '发送消息';
  $('#send-message').setAttribute('aria-label', busy ? '加入队列' : '发送消息');
  $('#send-message').disabled = session?.historyLoaded === false || submitting || (!$('#prompt').value.trim() && !window.workspaceAttachments?.().length) || window.workspaceState !== 'connected';
  $('#stop-message').hidden = !busy;
  $('#stop-message').disabled = session?.status === 'stopping' || window.workspaceState !== 'connected';
  $('#delete-chat').hidden = !session;
  $('#delete-chat').disabled = busy;
  $('#rename-chat').hidden = !session;
  $('#welcome-path').textContent = connection.host ? connection.host + ' · ' + connection.directory : '点击左下角「连接 SSH」连接你的服务器';
  renderMessages(session);
  renderPermissions(session);
  window.renderTodoStrip(session);
  window.renderQueue?.(session);
  window.renderHistoryNotice?.(session);
}

function selectSession(id) {
  drafts.set(activeId, $('#prompt').value);
  activeId = id;
  window.closeFileMentions?.();
  if (activeSession()) setArchiveView(Boolean(activeSession().archived));
  $('#prompt').value = drafts.get(id) || '';
  $('#messages').replaceChildren();
  renderedMessages.clear();
  permissionSignature = '';
  updateUI();
  renderList();
  resizePrompt();
  requestAnimationFrame(() => { $('#scroll-area').scrollTop = $('#scroll-area').scrollHeight; });
  $('#prompt').focus();
  if (activeSession()?.localMessagesLoaded === false) {
    api.load(id).then(session => {
      const index = sessions.findIndex(item => item.id === id);
      if (index < 0) return;
      sessions[index] = session;
      if (activeId !== id) return;
      updateUI();
      if (session.historyLoaded === false) window.openHistory?.(id);
      else { window.workspaceChanged?.(); window.controlsChanged?.(); }
    }).catch(showError);
  } else if (activeSession()?.historyLoaded === false) window.openHistory?.(id);
  else { window.workspaceChanged?.(); window.controlsChanged?.(); }
}

function resizePrompt() {
  $('#prompt').style.height = 'auto';
  $('#prompt').style.height = Math.min(180, $('#prompt').scrollHeight) + 'px';
}

$('#composer').onsubmit = async event => {
  event.preventDefault();
  const text = $('#prompt').value.trim();
  if ((!text && !window.workspaceAttachments?.().length) || submitting) return;
  if (window.workspaceState !== 'connected') return showError(new Error('请先连接 SSH 服务器'));
  submitting = true;
  try {
    if (!activeId) {
      const session = await api.create({ ...defaults, name: '新对话' });
      if (!sessions.some(item => item.id === session.id)) sessions.unshift(session);
      selectSession(session.id);
    }
    const targetId = activeId;
    if (text.startsWith('/') && !window.workspaceAttachments().length && await window.openCommandInteraction?.(targetId, text)) return;
    await api.send(targetId, text, window.workspaceAttachments().map(file => file.id));
    window.clearWorkspaceAttachments(targetId);
    if (activeId === targetId) $('#prompt').value = '';
    drafts.delete(targetId);
    resizePrompt();
    requestAnimationFrame(() => { $('#scroll-area').scrollTop = $('#scroll-area').scrollHeight; });
  } catch (error) { $('#prompt').value = text; showError(error); }
  finally { submitting = false; updateUI(); if (!$('#control-dialog').open) $('#prompt').focus(); }
};
$('#prompt').addEventListener('input', () => { resizePrompt(); updateUI(); });
$('#prompt').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    $('#composer').requestSubmit();
  }
});
$('#stop-message').onclick = () => api.stop(activeId).catch(showError);
$('#search').oninput = renderList;
$('#rename-chat').onclick = () => {
  $('#rename-input').value = activeSession().name;
  $('#rename-dialog').showModal();
};
$('#cancel-rename').onclick = () => $('#rename-dialog').close();
$('#rename-form').onsubmit = async event => {
  event.preventDefault();
  try { await api.rename(activeId, $('#rename-input').value); $('#rename-dialog').close(); }
  catch (error) { showError(error); }
};
$('#delete-chat').onclick = async () => {
  const id = activeId;
  if (!window.confirm('删除这条本地聊天记录？远端 Claude 的历史不会被删除。')) return;
  try {
    await api.remove(id);
    sessions = sessions.filter(session => session.id !== id);
    drafts.delete(id);
    selectSession(sessions[0]?.id || null);
  } catch (error) { showError(error); }
};
document.addEventListener('click', event => {
  const link = event.target.closest('a');
  if (link) {
    event.preventDefault();
    const href = link.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href)) api.openLink(href).catch(showError);
    else if (href && !href.startsWith('#') && !/^(javascript|data):/i.test(href)) {
      try { window.openRemotePreview(decodeURIComponent(href.replace(/^file:\/\//, ''))); }
      catch (error) { showError(error); }
    }
  }
});
document.addEventListener('keydown', event => {
  if (event.metaKey && event.key.toLowerCase() === 'n') { event.preventDefault(); $('#new-chat').click(); }
});
api.onChanged(session => {
  const index = sessions.findIndex(item => item.id === session.id);
  if (session.messageIds) {
    const messages = new Map((sessions[index]?.messages || []).map(message => [message.id, message]));
    for (const message of session.changedMessages) messages.set(message.id, message);
    const ids = session.messageIds;
    delete session.changedMessages; delete session.messageIds;
    if (ids.some(id => !messages.has(id))) {
      api.load(session.id).then(full => {
        const current = sessions.findIndex(item => item.id === full.id);
        if (current >= 0) sessions[current] = full; else sessions.unshift(full);
        renderList(); if (activeId === full.id) updateUI();
      }).catch(showError);
      return;
    }
    session.messages = ids.map(id => messages.get(id));
  }
  if (index < 0) sessions.unshift(session);
  else {
    const previous = new Map(sessions[index].messages.map(message => [message.id, message]));
    session.messages = session.messages.map((message, i) => {
      const old = previous.get(message.id);
      return i < session.messages.length - 1 && old && old.revision === message.revision ? old : message;
    });
    sessions[index] = session;
  }
  scheduleRender(session.id === activeId);
});
// Several packets can arrive per frame while streaming; draw once.
let renderQueued = false, renderActive = false;
function scheduleRender(active) {
  renderActive ||= active;
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const update = renderActive; renderActive = false;
    renderList();
    if (update) updateUI();
  });
}
// Later scripts install the file panel and controls; wait for them before the first selection.
document.addEventListener('DOMContentLoaded', () => api.list().then(result => {
  sessions = result;
  if (sessions.length) defaults = { host: sessions[0].host, directory: sessions[0].directory, port: sessions[0].port };
  selectSession(sessions[0]?.id || null);
  window.autoConnect?.();
}).catch(showError));

function setArchiveView(value) {
  showArchived = value;
  $('#active-chats').classList.toggle('selected', !value);
  $('#archived-chats').classList.toggle('selected', value);
  renderList();
}
$('#active-chats').onclick = () => setArchiveView(false);
$('#archived-chats').onclick = () => setArchiveView(true);
window.renderQueue = session => {
  const container = $('#queued-messages'); container.replaceChildren();
  if (!session?.queue?.length) return;
  const label = document.createElement('div'); label.className = 'queue-label';
  label.textContent = session.queuePaused ? '队列已暂停' : '回复完成后依次发送';
  if (session.queuePaused) {
    const resume = document.createElement('button'); resume.textContent = '继续队列';
    resume.onclick = () => api.resumeQueue(session.id).catch(showError); label.append(resume);
  }
  container.append(label);
  for (const item of session.queue) {
    const row = document.createElement('div'); row.className = 'queued-row';
    const text = document.createElement('span'); text.textContent = item.text; text.title = item.text;
    const cancel = document.createElement('button'); cancel.textContent = '取消';
    cancel.onclick = () => api.cancelQueued(session.id, item.id).catch(showError);
    row.append(text, cancel); container.append(row);
  }
};
