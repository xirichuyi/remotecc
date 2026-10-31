// Renders each Claude tool the way its result reads best, instead of as raw JSON.
(() => {
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const statusText = { history: '', running: '执行中', done: '', error: '失败', stopped: '已停止' };

  function pathButton(file, line) {
    const button = element('button', 'tool-path', file);
    button.type = 'button'; button.title = '打开 ' + file;
    button.onclick = event => { event.preventDefault(); event.stopPropagation(); window.openRemotePreview(file, line); };
    return button;
  }

  // Longest-common-subsequence over lines; large inputs fall back to remove-all/add-all.
  function lineDiff(before, after) {
    const a = before.split('\n'), b = after.split('\n');
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length, endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    const middleA = a.slice(start, endA), middleB = b.slice(start, endB);
    const rows = a.slice(Math.max(0, start - 2), start).map(text => [' ', text]);
    if (middleA.length * middleB.length > 250000) {
      rows.push(...middleA.map(text => ['-', text]), ...middleB.map(text => ['+', text]));
    } else {
      const table = Array.from({ length: middleA.length + 1 }, () => new Uint32Array(middleB.length + 1));
      for (let i = middleA.length - 1; i >= 0; i--) for (let j = middleB.length - 1; j >= 0; j--)
        table[i][j] = middleA[i] === middleB[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
      let i = 0, j = 0;
      while (i < middleA.length || j < middleB.length) {
        if (i < middleA.length && j < middleB.length && middleA[i] === middleB[j]) { rows.push([' ', middleA[i]]); i++; j++; }
        else if (j < middleB.length && (i === middleA.length || table[i][j + 1] >= table[i + 1][j])) rows.push(['+', middleB[j++]]);
        else rows.push(['-', middleA[i++]]);
      }
    }
    rows.push(...a.slice(endA, endA + 2).map(text => [' ', text]));
    return rows;
  }

  function diffView(rows) {
    const view = element('div', 'diff-view');
    for (const [kind, text] of rows) {
      const row = element('div', 'diff-line ' + (kind === '+' ? 'added' : kind === '-' ? 'removed' : kind === '@' ? 'hunk' : ''));
      row.textContent = (kind === '@' ? '' : kind + ' ') + text;
      view.append(row);
    }
    return view;
  }

  function unifiedDiff(text) {
    const rows = [];
    for (const line of text.split('\n')) {
      if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)) continue;
      if (line.startsWith('@@')) rows.push(['@', line]);
      else if (line) rows.push([line[0] === '+' || line[0] === '-' ? line[0] : ' ', line.slice(1)]);
    }
    return rows.length ? diffView(rows) : element('div', 'preview-note', '没有差异');
  }

  const codeBlock = (text, className = '') => element('pre', 'tool-code ' + className, text);
  const countLines = text => (text ? text.split('\n').length : 0);
  const firstLine = (text, limit = 90) => { const line = String(text ?? '').split('\n')[0]; return line.length > limit ? line.slice(0, limit) + '…' : line; };

  function todoList(todos) {
    const list = element('ul', 'todo-list');
    for (const todo of todos || []) {
      const item = element('li', 'todo-' + todo.status);
      item.append(element('span', 'todo-mark', { completed: '✓', in_progress: '◐', pending: '○' }[todo.status] || '○'),
        element('span', '', todo.status === 'in_progress' ? todo.activeForm || todo.content : todo.content));
      list.append(item);
    }
    return list;
  }

  function childList(block) {
    const list = element('div', 'agent-steps');
    for (const child of block.children) {
      const row = element('div', 'agent-step ' + child.status);
      row.append(element('strong', '', child.name), element('span', '', firstLine(describe(child).text, 70)));
      list.append(row);
    }
    return list;
  }

  function editRows(input) {
    if (Array.isArray(input.edits)) return input.edits.flatMap(edit => lineDiff(edit.old_string || '', edit.new_string || ''));
    return lineDiff(input.old_string || '', input.new_string || '');
  }

  // title: verb; text: one-line subject; file: makes the subject clickable; body: expanded content.
  const renderers = {
    Bash: input => ({ title: 'Bash', text: input.description || firstLine(input.command), body: () => [codeBlock(input.command || '', 'command')], outputFirst: false }),
    Read: input => ({ title: 'Read', file: input.file_path, line: input.offset, text: input.offset ? `第 ${input.offset} 行起` : '', hideOutput: true }),
    Write: input => ({ title: 'Write', file: input.file_path, text: `${countLines(input.content)} 行`, body: () => [codeBlock(input.content || '')], hideOutput: true }),
    Edit: input => ({ title: 'Edit', file: input.file_path, body: () => [diffView(editRows(input))], open: true, hideOutput: true }),
    MultiEdit: input => ({ title: 'Edit', file: input.file_path, text: `${input.edits?.length || 0} 处`, body: () => [diffView(editRows(input))], open: true, hideOutput: true }),
    NotebookEdit: input => ({ title: 'NotebookEdit', file: input.notebook_path, body: () => [codeBlock(input.new_source || '')] }),
    Grep: input => ({ title: 'Grep', text: input.pattern + (input.path ? ' · ' + input.path : '') }),
    Glob: input => ({ title: 'Glob', text: input.pattern + (input.path ? ' · ' + input.path : '') }),
    LS: input => ({ title: 'LS', file: input.path }),
    WebFetch: input => ({ title: 'WebFetch', text: input.url, body: () => input.prompt ? [codeBlock(input.prompt)] : [] }),
    WebSearch: input => ({ title: 'WebSearch', text: input.query }),
    TodoWrite: input => ({ title: '任务清单', text: `${input.todos?.filter(todo => todo.status === 'completed').length || 0}/${input.todos?.length || 0}`, body: () => [todoList(input.todos)], open: true, hideOutput: true }),
    ExitPlanMode: input => ({ title: '计划', body: () => input.plan ? [window.renderMarkdownBlock(input.plan)] : [], open: true, hideOutput: true }),
    AskUserQuestion: input => ({ title: '提问', text: input.questions?.map(item => item.question).join(' · ') }),
    Skill: input => ({ title: 'Skill', text: input.skill || input.command }),
  };
  const agent = input => ({ title: input.subagent_type ? `Agent · ${input.subagent_type}` : 'Agent', text: input.description, body: () => input.prompt ? [codeBlock(input.prompt)] : [] });
  renderers.Task = agent; renderers.Agent = agent;

  function generic(block) {
    const input = block.input || {};
    const mcp = /^mcp__(.+?)__(.+)$/.exec(block.name || '');
    const firstValue = Object.values(input).find(value => typeof value === 'string');
    return { title: mcp ? `${mcp[1]} · ${mcp[2]}` : block.name, text: firstValue ? firstLine(firstValue) : '',
      body: () => Object.keys(input).length ? [codeBlock(JSON.stringify(input, null, 2))] : [] };
  }
  function describe(block) {
    const renderer = Object.hasOwn(renderers, block.name) ? renderers[block.name] : null;
    return renderer ? renderer(block.input || {}) : generic(block);
  }

  window.renderToolBlock = (block, openTools) => {
    const view = describe(block);
    const details = element('details', 'tool-card status-' + (block.status || 'done'));
    details.dataset.toolId = block.id;
    details.open = openTools.has(block.id) || (!openTools.has('closed:' + block.id) && view.open === true) || block.status === 'error';
    const summary = element('summary');
    summary.append(element('span', 'tool-dot'), element('strong', 'tool-name', view.title));
    if (view.file) summary.append(pathButton(view.file, view.line));
    if (view.text) summary.append(element('span', 'tool-subject', view.text));
    const label = block.status === 'running' && block.elapsed ? `${Math.round(block.elapsed)}s` : statusText[block.status] || '';
    if (label) summary.append(element('span', 'tool-status', label));
    details.append(summary);
    if (block.summary) details.append(element('div', 'tool-summary', block.summary));
    const content = element('div', 'tool-content');
    for (const part of view.body?.() || []) content.append(part);
    if (block.children?.length) content.append(childList(block));
    if (block.agentText) content.append(element('div', 'tool-summary', block.agentText));
    if (block.output && (!view.hideOutput || block.status === 'error')) content.append(codeBlock(block.output, block.status === 'error' ? 'error' : 'output'));
    if (content.children.length) details.append(content);
    return details;
  };

  // What is about to happen, shown on the approval card in place of raw JSON.
  window.renderToolRequest = (name, input) => {
    const box = element('div', 'permission-preview');
    const view = describe({ name, input });
    if (view.file) box.append(pathButton(view.file, view.line));
    if (name !== 'Bash' && view.text) box.append(element('div', 'tool-subject', view.text));
    const parts = view.body?.() || [];
    if (parts.length) box.append(...parts);
    else if (!view.file && !view.text) box.append(codeBlock(JSON.stringify(input, null, 2)));
    return box;
  };

  window.renderTodoStrip = session => {
    const strip = document.querySelector('#todo-strip');
    let todos = null;
    if (['working', 'permission', 'connecting', 'detached'].includes(session?.status)) {
      const blocks = session.messages.at(-1)?.blocks || [];
      for (let index = blocks.length - 1; index >= 0 && !todos; index--) if (blocks[index].name === 'TodoWrite') todos = blocks[index].input?.todos;
    }
    strip.hidden = !todos?.length;
    if (strip.hidden) { strip.replaceChildren(); strip.dataset.signature = ''; return; }
    const signature = JSON.stringify(todos);
    if (strip.dataset.signature === signature) return;
    strip.dataset.signature = signature;
    strip.replaceChildren(todoList(todos));
  };

  window.currentActivity = session => {
    const message = session?.messages.at(-1);
    if (message?.activity) return message.activity;
    const running = (message?.blocks || []).filter(block => block.type === 'tool' && block.status === 'running').at(-1);
    if (!running) return '';
    const view = describe(running);
    return `${view.title}${view.file ? ' ' + view.file.split('/').at(-1) : view.text ? ' ' + firstLine(view.text, 40) : ''}${running.elapsed ? ' · ' + Math.round(running.elapsed) + 's' : ''}`;
  };

  window.renderUnifiedDiff = unifiedDiff;
})();
