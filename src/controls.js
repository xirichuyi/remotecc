const controlRequests = new Map();
const commandErrors = new Map();
const commandRetryAt = new Map();
let commandSelection = 0;
let filteredCommands = [];
let suppressedInput = null;

function hideCommandMenu() {
  $('#command-menu').hidden = true;
  $('#prompt').setAttribute('aria-expanded', 'false');
  $('#prompt').removeAttribute('aria-activedescendant');
}

function commandsForSession() {
  return window.commandCompletion.candidates(activeSession()?.capabilities?.commands || []);
}

window.controlsChanged = () => {
  renderCommandMenu();
  const session = activeSession();
  if (!session || session.historyLoaded === false || window.workspaceState !== 'connected') return;
  if (session.capabilities && Date.now() - session.capabilities.fetchedAt < 300000) return;
  if (controlRequests.has(session.id) || Date.now() < (commandRetryAt.get(session.id) || 0)) return;
  const id = session.id;
  commandErrors.delete(id);
  const request = api.capabilities(id)
    .then(() => { commandRetryAt.delete(id); })
    .catch(error => { commandErrors.set(id, error.message); commandRetryAt.set(id, Date.now() + 10000); })
    .finally(() => { controlRequests.delete(id); if (id === activeId) renderCommandMenu(); });
  controlRequests.set(id, request);
};

function renderCommandMenu() {
  const value = $('#prompt').value;
  const input = $('#prompt');
  const token = window.commandCompletion.token(value, input.selectionStart, input.selectionEnd);
  if (!token || document.activeElement !== input || value === suppressedInput) { hideCommandMenu(); return; }
  const query = token.query.toLowerCase();
  filteredCommands = window.commandCompletion.match(commandsForSession(), query);
  commandSelection = Math.min(commandSelection, Math.max(0, filteredCommands.length - 1));
  $('#command-menu').replaceChildren();
  const label = document.createElement('div');
  label.className = 'command-label';
  label.textContent = commandErrors.has(activeId) ? '读取失败：' + commandErrors.get(activeId) :
    window.workspaceState !== 'connected' ? '命令 · 请连接 SSH 以刷新列表' :
    activeSession()?.capabilities ? '命令' : '命令 · 正在读取远端能力';
  $('#command-menu').append(label);
  filteredCommands.forEach((command, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'remote-command-' + index;
    button.className = 'command-item' + (index === commandSelection ? ' selected' : '');
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', index === commandSelection);
    button.title = command.description;
    const name = document.createElement('strong'); name.textContent = '/' + command.name;
    const description = document.createElement('span'); description.textContent = (command.description || '').split('\n')[0];
    const hint = document.createElement('small'); hint.textContent = command.argumentHint || '';
    button.append(name, description, hint);
    button.onpointerdown = event => { if (event.pointerType === 'mouse') event.preventDefault(); };
    button.onclick = () => chooseCommand(command, 'click');
    $('#command-menu').append(button);
  });
  if (!filteredCommands.length) { const note = document.createElement('div'); note.className = 'command-label'; note.textContent = '无匹配命令'; $('#command-menu').append(note); }
  $('#command-menu').hidden = false;
  $('#prompt').setAttribute('aria-expanded', 'true');
  if (filteredCommands.length) $('#prompt').setAttribute('aria-activedescendant', 'remote-command-' + commandSelection);
  else $('#prompt').removeAttribute('aria-activedescendant');
  $('#command-menu .selected')?.scrollIntoView({ block: 'nearest' });
}

async function chooseCommand(command, mode) {
  if (!command) return;
  const input = $('#prompt');
  const token = window.commandCompletion.token(input.value, input.selectionStart, input.selectionEnd);
  if (!token) return;
  const completed = window.commandCompletion.complete(input.value, token, command);
  hideCommandMenu();
  input.value = completed.value;
  input.setSelectionRange(completed.caret, completed.caret);
  suppressedInput = completed.value;
  if (activeId) drafts.set(activeId, input.value);
  resizePrompt();
  updateUI();
  input.focus();
  // Enter uses the same submit path as a typed command, including native controls.
  if (mode === 'execute') { $('#composer').requestSubmit(); return; }
  if (mode === 'click' && activeId && window.workspaceState === 'connected') {
    try { await window.openCommandInteraction(activeId, input.value.trim()); }
    catch (error) { showError(error); }
  }
}
$('#prompt').addEventListener('input', () => { suppressedInput = null; commandSelection = 0; renderCommandMenu(); });
$('#prompt').addEventListener('keydown', event => {
  if (event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey || (['Enter', 'Tab'].includes(event.key) && event.shiftKey)) return;
  if ($('#command-menu').hidden) {
    if (!$('#mention-menu').hidden) return;
    if (event.key === 'Escape' && busyStates.has(activeSession()?.status)) { event.preventDefault(); api.stop(activeId).catch(showError); }
    return;
  }
  if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
    if (!filteredCommands.length && event.key === 'Enter' && activeSession()?.capabilities) { hideCommandMenu(); return; }
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.key === 'Escape') { suppressedInput = $('#prompt').value; hideCommandMenu(); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      commandSelection = (commandSelection + (event.key === 'ArrowDown' ? 1 : -1) + filteredCommands.length) % (filteredCommands.length || 1);
      renderCommandMenu();
    } else void chooseCommand(filteredCommands[commandSelection], event.key === 'Tab' ? 'complete' : 'execute');
  }
}, true);

$('#prompt').addEventListener('focus', () => { window.controlsChanged(); });
$('#prompt').addEventListener('click', renderCommandMenu);
$('#prompt').addEventListener('keyup', event => {
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) renderCommandMenu();
});
$('#prompt').addEventListener('blur', () => {
  setTimeout(() => { if (document.activeElement !== $('#prompt')) hideCommandMenu(); }, 150);
});

function openControl(title) {
  $('#control-title').textContent = title;
  $('#control-content').replaceChildren();
  if (!$('#control-dialog').open) $('#control-dialog').showModal();
  return $('#control-content');
}
$('#close-control').onclick = () => $('#control-dialog').close();

function selectField(labelText, name, values, selected) {
  const label = document.createElement('label'); label.textContent = labelText;
  const select = document.createElement('select'); select.name = name;
  for (const [value, title] of values) { const option = document.createElement('option'); option.value = value; option.textContent = title; select.append(option); }
  select.value = selected;
  label.append(select);
  return label;
}

async function showPreferences() {
  const session = activeSession();
  if (!session) return window.showSSHSettings();
  const container = openControl('模型与会话设置');
  container.textContent = '读取远端能力…';
  try {
    const caps = await api.capabilities(session.id);
    if (!$('#control-dialog').open || session.id !== activeId) return;
    container.replaceChildren();
    const form = document.createElement('form'); form.id = 'preferences-form';
    const preferences = session.preferences || {};
    const agents = [['', '远端默认'], ...(caps.agents || []).map(agent => [agent.name, agent.name])];
    if (preferences.agent && !agents.some(([name]) => name === preferences.agent)) agents.push([preferences.agent, preferences.agent + '（远端已不可用）']);
    form.append(selectField('Agent', 'agent', agents, preferences.agent || ''));
    const agentDescription = document.createElement('div'); agentDescription.className = 'form-note';
    const describeAgent = () => { agentDescription.textContent = caps.agents?.find(agent => agent.name === form.elements.agent.value)?.description || ''; };
    form.elements.agent.disabled = session.messages.length > 0;
    form.elements.agent.title = session.messages.length ? '请在新对话中选择 Agent' : '';
    form.elements.agent.onchange = describeAgent; describeAgent(); form.append(agentDescription);
    const modelRows = [['', '远端默认'], ...caps.models.filter(model => model.value !== 'default').map(model => [model.value, model.displayName]), ['custom', '自定义模型 ID']];
    const known = modelRows.some(([value]) => value === (preferences.selectedModel || ''));
    form.append(selectField('模型', 'selectedModel', modelRows, known ? preferences.selectedModel || '' : 'custom'));
    const custom = document.createElement('input'); custom.name = 'customModel'; custom.placeholder = '模型 ID'; custom.value = known ? '' : preferences.selectedModel; custom.hidden = known; form.append(custom);
    form.append(selectField('思考强度', 'effort', [['', '自动'], ...['low', 'medium', 'high', 'xhigh', 'max'].map(value => [value, value])], preferences.effort || ''));
    form.append(selectField('权限', 'permissionMode', [['default', '默认 · 请求时确认'], ['plan', '计划 · 不执行修改'], ['acceptEdits', '自动接受文件编辑'], ['dontAsk', '拒绝未授权操作'], ['auto', '自动判断权限']], preferences.permissionMode || 'default'));
    const fastLabel = document.createElement('label'); fastLabel.className = 'inline-label';
    const fast = document.createElement('input'); fast.type = 'checkbox'; fast.name = 'fastMode'; fast.checked = preferences.fastMode === true;
    fastLabel.append(fast, document.createTextNode('快速模式（由模型与账户支持情况决定）')); form.append(fastLabel);
    form.append(selectField('输出样式', 'outputStyle', [['', '远端默认'], ...caps.outputStyles.map(style => [style, style])], preferences.outputStyle || ''));
    const directories = document.createElement('label'); directories.textContent = '额外工作目录（每行一个远端绝对路径）';
    const directoryInput = document.createElement('textarea'); directoryInput.name = 'additionalDirectories'; directoryInput.rows = 3; directoryInput.disabled = busyStates.has(session.status); directoryInput.value = (preferences.additionalDirectories || []).join('\n'); directories.append(directoryInput); form.append(directories);
    const notice = document.createElement('div'); notice.className = 'form-note'; notice.textContent = '设置由远端确认。上一轮实际模型：' + (session.model || '尚未调用'); form.append(notice);
    const errorBox = document.createElement('div'); errorBox.className = 'form-error'; form.append(errorBox);
    const actions = document.createElement('div'); actions.className = 'dialog-actions';
    const reload = document.createElement('button'); reload.type = 'button'; reload.textContent = '刷新模型列表';
    reload.onclick = async () => { try { await api.capabilities(session.id, true); await showPreferences(); } catch (error) { errorBox.textContent = error.message; } };
    const save = document.createElement('button'); save.type = 'submit'; save.className = 'accent-button'; save.textContent = '应用'; save.disabled = busyStates.has(session.status) && !session.remoteOwner;
    actions.append(reload, save); form.append(actions);
    const modelSelect = form.elements.selectedModel;
    const adjust = () => {
      custom.hidden = modelSelect.value !== 'custom';
      const model = caps.models.find(item => item.value === (modelSelect.value || 'default'));
      for (const option of form.elements.effort.options) option.disabled = Boolean(option.value && model && !model.supportedEffortLevels?.includes(option.value));
      if (form.elements.effort.selectedOptions[0]?.disabled) form.elements.effort.value = '';
      fast.disabled = Boolean(model && !model.supportsFastMode);
      if (fast.disabled) fast.checked = false;
      form.elements.permissionMode.querySelector('[value=auto]').disabled = Boolean(model && !model.supportsAutoMode);
      if (form.elements.permissionMode.selectedOptions[0]?.disabled) form.elements.permissionMode.value = 'default';
    };
    modelSelect.onchange = adjust; adjust();
    form.onsubmit = async event => {
      event.preventDefault(); save.disabled = true;
      try {
        const patch = { agent: form.elements.agent.value, selectedModel: modelSelect.value === 'custom' ? custom.value.trim() : modelSelect.value,
          effort: form.elements.effort.value, permissionMode: form.elements.permissionMode.value, fastMode: fast.checked,
          outputStyle: form.elements.outputStyle.value, additionalDirectories: directoryInput.value.split('\n').map(value => value.trim()).filter(Boolean) };
        await api.configure(session.id, patch); $('#control-dialog').close();
      } catch (error) { errorBox.textContent = error.message; } finally { save.disabled = false; }
    };
    container.append(form);
  } catch (error) { container.textContent = error.message; }
}

function dataRows(container, values) {
  for (const value of values) {
    const row = document.createElement('details'); row.className = 'capability-row';
    const heading = document.createElement('summary'); heading.textContent = value.name || value.description || value.id || '详情';
    if (value.status) heading.textContent += ' · ' + value.status;
    const body = document.createElement('pre'); body.textContent = JSON.stringify(value, null, 2);
    row.append(heading, body); container.append(row);
  }
  if (!values.length) container.textContent = '无项目';
}
async function showDetails(section) {
  const titles = { status: '状态', cost: '用量 / 费用估计', context: '上下文', skills: '技能', agents: 'Agents', mcp: 'MCP', plugins: '插件', tasks: '任务' };
  const container = openControl(titles[section] || section); container.textContent = '读取中…';
  try {
    const data = await api.details(activeId, section);
    if (!$('#control-dialog').open) return;
    container.replaceChildren();
    if (section === 'context') {
      const summary = document.createElement('p'); summary.textContent = `${data.totalTokens?.toLocaleString()} / ${data.maxTokens?.toLocaleString()} tokens · ${data.percentage?.toFixed(1)}%`; container.append(summary);
      dataRows(container, data.categories || []);
    } else if (Array.isArray(data)) dataRows(container, data);
    else { const pre = document.createElement('pre'); pre.className = 'control-data'; pre.textContent = JSON.stringify(data, null, 2); container.append(pre); }
  } catch (error) { container.textContent = error.message; }
}

async function newEmptyChat() {
  const source = activeSession();
  const session = await api.create({ ...(source || defaults), name: '新对话' });
  if (source?.preferences) await api.configure(session.id, source.preferences);
  if (!sessions.some(item => item.id === session.id)) sessions.unshift(session);
  selectSession(session.id);
}
function chooseSession(session) {
  if (!sessions.some(item => item.id === session.id)) sessions.unshift(session);
  selectSession(session.id); $('#control-dialog').close();
}
async function showSessions() {
  const container = openControl('会话');
  const actions = document.createElement('div'); actions.className = 'session-action-row';
  for (const [label, action] of [['新对话', newEmptyChat], ['分支当前对话', async () => chooseSession(await api.fork(activeId))], ['导出当前对话', async () => { const file = await api.exportChat(activeId); if (file) showError({ message: '已导出 ' + file }); }]]) {
    const button = document.createElement('button'); button.textContent = label; button.onclick = () => Promise.resolve(action()).catch(showError); actions.append(button);
  }
  for (const [key, label] of [['pinned', activeSession()?.pinned ? '取消固定' : '固定当前对话'], ['archived', activeSession()?.archived ? '恢复当前对话' : '归档当前对话']]) {
    const button = document.createElement('button'); button.textContent = label;
    button.onclick = async () => { try { await api.organize(activeId, { [key]: !activeSession()[key] }); await showSessions(); } catch (error) { showError(error); } };
    actions.append(button);
  }
  container.append(actions);
  const tools = document.createElement('div'); tools.className = 'session-action-row';
  const entries = [['模型与权限', showPreferences], ['Git 差异', showGitDiff], ['SSH 端口转发', showPorts],
    ['刷新远端命令', async () => { await api.capabilities(activeId, true); $('#control-dialog').close(); }],
    ...Object.entries({ status: '状态', cost: '用量', context: '上下文', skills: '技能', agents: 'Agents', mcp: 'MCP', plugins: '插件', tasks: '任务' })
      .map(([section, label]) => [label, () => showDetails(section)])];
  for (const [label, action] of entries) {
    const button = document.createElement('button'); button.textContent = label;
    button.onclick = () => Promise.resolve(action()).catch(showError); tools.append(button);
  }
  container.append(tools);
  for (const session of [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const button = document.createElement('button'); button.className = 'session-choice'; button.textContent = `${session.name} · ${session.host} · ${session.directory}`; button.onclick = () => chooseSession(session); container.append(button);
  }
}

async function showGitDiff() {
  const container = openControl('远端 Git 差异'); container.textContent = '读取中…';
  try {
    const result = await api.gitDiff(activeId);
    const pre = document.createElement('pre'); pre.className = 'control-data'; pre.textContent = result.text || '无修改'; container.replaceChildren(pre);
  } catch (error) { container.textContent = error.message; }
}

$('#model-label').onclick = showPreferences;
$('#mode-label').onclick = showPreferences;
$('#session-tools').onclick = showSessions;
api.onChanged(() => { if (!$('#command-menu').hidden) renderCommandMenu(); });

async function showPorts() {
  const id = activeId;
  const container = openControl('SSH 端口转发');
  const form = document.createElement('form');
  const local = document.createElement('input'); local.type = 'number'; local.min = 1; local.max = 65535; local.required = true; local.placeholder = '本地端口，例如 3000'; local.setAttribute('aria-label', '本地端口');
  const remote = document.createElement('input'); remote.type = 'number'; remote.min = 1; remote.max = 65535; remote.required = true; remote.placeholder = '远端端口，例如 3000'; remote.setAttribute('aria-label', '远端端口');
  const add = document.createElement('button'); add.type = 'submit'; add.textContent = '转发';
  const errorBox = document.createElement('div'); errorBox.className = 'form-error';
  const list = document.createElement('div');
  const render = rows => {
    list.replaceChildren();
    for (const row of rows) {
      const line = document.createElement('div'); line.className = 'session-action-row';
      const open = document.createElement('button'); open.textContent = `localhost:${row.localPort} → 远端 ${row.remotePort}`;
      open.onclick = () => api.openLink(`http://127.0.0.1:${row.localPort}`).catch(showError);
      const remove = document.createElement('button'); remove.textContent = '关闭';
      remove.onclick = async () => { try { render(await api.forward(id, row.localPort, row.remotePort, true)); } catch (error) { errorBox.textContent = error.message; } };
      line.append(open, remove); list.append(line);
    }
  };
  form.append(local, remote, add); container.append(form, errorBox, list);
  form.onsubmit = async event => {
    event.preventDefault(); add.disabled = true; errorBox.textContent = '';
    try { render(await api.forward(id, Number(local.value), Number(remote.value))); }
    catch (error) { errorBox.textContent = error.message; } finally { add.disabled = false; }
  };
  try { render(await api.tunnels(id)); } catch (error) { errorBox.textContent = error.message; }
}

window.openCommandInteraction = async (id, text) => {
  const descriptor = await api.commandInteraction(id, text);
  if (!descriptor || id !== activeId) return false;
  if (descriptor.kind === 'newConversation') {
    await newEmptyChat();
    drafts.delete(id);
    return true;
  }
  const clearCommand = () => {
    if (activeId === id && $('#prompt').value.trim() === text) { $('#prompt').value = ''; drafts.delete(id); resizePrompt(); }
  };
  const selectValue = value => descriptor.kind === 'model' ? api.selectModel(id, value) : api.selectEffort(id, value);
  if (['model', 'effort'].includes(descriptor.kind) && descriptor.argument) {
    await selectValue(descriptor.argument);
    clearCommand();
    return true;
  }
  const container = openControl('/' + descriptor.command);
  const form = document.createElement('form'); form.id = 'command-interaction-form';
  const selected = descriptor.selected || descriptor.options[0]?.value;
  if (descriptor.kind === 'model' && selected && !descriptor.options.some(option => option.value === selected))
    descriptor.options.push({ value: selected, label: selected });
  const fields = window.createSchemaFields({ type: 'object', properties: { value: {
    type: 'string', title: descriptor.kind === 'model' ? '选择模型' : '选择参数',
    oneOf: descriptor.options.map(option => ({const:option.value, title:option.label})), default: selected,
  } }, required: ['value'] });
  form.append(fields.element);
  const customModel = descriptor.kind === 'model' ? document.createElement('input') : null;
  if (customModel) {
    customModel.name = 'customModel'; customModel.placeholder = '或输入自定义模型 ID';
    customModel.setAttribute('aria-label', '自定义模型 ID'); form.append(customModel);
  }
  const description = document.createElement('p'); description.className = 'form-note';
  const updateDescription = () => { description.textContent = descriptor.options.find(option => option.value === form.elements.value.value)?.description || descriptor.description || ''; };
  form.elements.value.required = true;
  form.elements.value.onchange = updateDescription; updateDescription(); form.append(description);
  const errorBox = document.createElement('div'); errorBox.className = 'form-error'; form.append(errorBox);
  const actions = document.createElement('div'); actions.className = 'dialog-actions';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消';
  cancel.onclick = () => { $('#control-dialog').close(); $('#prompt').focus(); };
  const apply = document.createElement('button'); apply.type = 'submit'; apply.textContent = descriptor.kind === 'model' ? '切换模型' : '执行'; apply.className = 'accent-button';
  form.onsubmit = async event => {
    event.preventDefault(); apply.disabled = true; errorBox.textContent = '';
    try {
      const value = customModel?.value.trim() || fields.read().value;
      if (['model', 'effort'].includes(descriptor.kind)) await selectValue(value);
      else await api.send(id, '/' + descriptor.command + ' ' + value, []);
      clearCommand(); $('#control-dialog').close(); $('#prompt').focus();
    } catch (error) { errorBox.textContent = error.message; }
    finally { apply.disabled = false; }
  };
  actions.append(cancel, apply); form.append(actions); container.append(form); form.elements.value.focus();
  return true;
};
