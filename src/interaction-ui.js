// One field renderer for remote elicitation and command argument selection.
window.createSchemaFields = schema => {
  const element = document.createElement('div'); element.className = 'schema-fields';
  const readers = [];
  for (const field of window.interactionSchema.fields(schema)) {
    const rule = field.schema;
    const label = document.createElement('label'); label.textContent = field.label + (field.required ? ' *' : '');
    let input;
    if (field.options || rule.type === 'boolean') {
      input = document.createElement('select'); input.multiple = rule.type === 'array';
      const options = rule.type === 'boolean' ? [{value:'true',label:'是'},{value:'false',label:'否'}] : field.options;
      if (!input.multiple) { const blank = document.createElement('option'); blank.value = ''; blank.textContent = '请选择'; input.append(blank); }
      for (const item of options) { const option = document.createElement('option'); option.value = item.value; option.textContent = item.label; input.append(option); }
      if (rule.default !== undefined) for (const option of input.options) option.selected = Array.isArray(rule.default) ? rule.default.includes(option.value) : option.value === String(rule.default);
    } else {
      input = document.createElement('input');
      input.type = ['number', 'integer'].includes(rule.type) ? 'number' : rule.format === 'date' ? 'date' : rule.format === 'email' ? 'email' : 'text';
      if (input.type === 'number') input.step = rule.type === 'integer' ? '1' : 'any';
      if (rule.minimum !== undefined) input.min = rule.minimum;
      if (rule.maximum !== undefined) input.max = rule.maximum;
      if (rule.minLength !== undefined) input.minLength = rule.minLength;
      input.maxLength = Math.min(rule.maxLength ?? 10000, 10000);
      if (rule.default !== undefined) input.value = rule.default;
    }
    input.name = field.name; input.required = field.required;
    input.setAttribute('aria-label', field.label); label.append(input);
    if (rule.description) { const note = document.createElement('small'); note.textContent = rule.description; label.append(note); }
    element.append(label);
    readers.push(() => {
      if (rule.type === 'array') return [field.name, [...input.selectedOptions].map(option => option.value)];
      if (input.value === '' && !field.required) return null;
      return [field.name, rule.type === 'boolean' ? (input.value === '' ? null : input.value === 'true') : ['number','integer'].includes(rule.type) ? (input.value === '' ? null : Number(input.value)) : input.value];
    });
  }
  return { element, read: () => window.interactionSchema.validate(schema, Object.fromEntries(readers.map(read => read()).filter(Boolean))) };
};

window.renderStructuredRequest = (session, permission) => {
  const request = permission.request;
  const card = document.createElement('section'); card.className = 'permission-card structured-request'; card.dataset.requestId = permission.id;
  const title = document.createElement('h3'); title.textContent = request.title || '需要你的输入';
  const origin = document.createElement('small'); origin.textContent = request.serverName;
  const message = document.createElement('p'); message.textContent = request.message;
  const form = document.createElement('form');
  card.append(title, origin, message, form);
  const errorBox = document.createElement('div'); errorBox.className = 'form-error';
  let fields, supported = true;
  try {
    if (request.mode === 'url') {
      const url = new URL(request.url);
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error('不支持的授权链接');
      const open = document.createElement('button'); open.type = 'button'; open.textContent = '打开 ' + url.host; open.title = url.href;
      open.onclick = () => api.openLink(url.href).catch(error => { errorBox.textContent = error.message; });
      const destination = document.createElement('p'); destination.textContent = url.href;
      form.append(destination, open);
    } else {
      if (request.mode && request.mode !== 'form') throw new Error('不支持的交互类型');
      fields = window.createSchemaFields(request.requestedSchema); form.append(fields.element);
    }
  } catch (error) { supported = false; errorBox.textContent = error.message + '，可以拒绝或取消。'; }
  form.append(errorBox);
  const actions = document.createElement('div'); actions.className = 'permission-actions';
  let submitting = false;
  const submit = async action => {
    if (submitting) return;
    try {
      const response = window.interactionSchema.answer(request, {action, ...(action === 'accept' && fields ? {content:fields.read()} : {})});
      submitting = true;
      for (const button of actions.children) button.disabled = true;
      await api.respond(session.id, permission.id, {interaction:response});
    } catch (error) {
      submitting = false;
      errorBox.textContent = error.message;
      for (const button of actions.children) button.disabled = button.dataset.action === 'accept' && !supported;
    }
  };
  for (const [action, text] of [['cancel','取消'],['decline','拒绝'],['accept',request.mode === 'url' ? '已完成，继续' : '提交']]) {
    const button = document.createElement('button'); button.dataset.action = action; button.type = action === 'accept' ? 'submit' : 'button'; button.textContent = text;
    if (action === 'accept') { button.className = 'accent-button'; button.disabled = !supported; }
    else button.onclick = () => submit(action);
    actions.append(button);
  }
  form.onsubmit = event => { event.preventDefault(); void submit('accept'); };
  form.append(actions); return card;
};
