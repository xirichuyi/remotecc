// Shared by the renderer and the remote worker. Only the supported MCP flat
// schema subset is accepted; unknown constraints never silently disappear.
(function (root) {
  const unsafe = new Set(['__proto__', 'constructor', 'prototype']);
  const annotations = ['title', 'description', 'default'];
  function choices(schema) {
    if (['enum', 'oneOf', 'anyOf'].filter(key => Object.hasOwn(schema, key)).length > 1) throw new Error('远端枚举结构不受支持');
    if (schema.enum !== undefined && !Array.isArray(schema.enum)) throw new Error('远端枚举无效');
    if (Array.isArray(schema.enum)) return schema.enum.map((value, i) => ({ value, label: schema.enumNames?.[i] || value }));
    const alternatives = schema.oneOf || schema.anyOf;
    if (alternatives !== undefined) {
      if (!Array.isArray(alternatives) || alternatives.some(item => !item || Object.keys(item).some(key => !['const', 'title'].includes(key)))) throw new Error('远端枚举约束不受支持');
      return alternatives.map(item => ({ value: item.const, label: item.title || item.const }));
    }
    return null;
  }
  function fields(schema) {
    if (!schema || schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) throw new Error('远端表单结构不受支持');
    if (Object.keys(schema).some(key => !['type', 'properties', 'required', '$schema', 'title', 'description', 'additionalProperties'].includes(key))) throw new Error('远端表单约束不受支持');
    const entries = Object.entries(schema.properties);
    if (entries.length > 100 || (schema.required && (!Array.isArray(schema.required) || schema.required.some(key => !Object.hasOwn(schema.properties, key))))) throw new Error('远端表单字段无效');
    return entries.map(([name, value]) => {
      if (unsafe.has(name) || !value || typeof value !== 'object') throw new Error('远端表单字段无效');
      const allowed = ['type', ...annotations];
      let options;
      if (value.type === 'string') { allowed.push('enum', 'enumNames', 'oneOf', 'minLength', 'maxLength', 'format'); options = choices(value); }
      else if (value.type === 'array') {
        allowed.push('items', 'minItems', 'maxItems');
        if (!value.items || Object.keys(value.items).some(key => !['type', 'enum', 'anyOf'].includes(key))) throw new Error('远端多选结构不受支持');
        options = choices(value.items);
        if (!options) throw new Error('远端数组字段需要枚举选项');
      } else if (['number', 'integer'].includes(value.type)) allowed.push('minimum', 'maximum');
      else if (value.type !== 'boolean') throw new Error('远端字段类型不受支持：' + value.type);
      if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('字段约束不受支持：' + name);
      for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) {
        if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || (!['minimum','maximum'].includes(key) && (!Number.isInteger(value[key]) || value[key] < 0)))) throw new Error('字段约束无效：' + name);
      }
      if (value.format && !['email', 'uri', 'date', 'date-time'].includes(value.format)) throw new Error('字段格式不受支持：' + name);
      if (options && (!options.length || options.length > 1000 || new Set(options.map(option => option.value)).size !== options.length || options.some(option => typeof option.value !== 'string'))) throw new Error('远端选项无效');
      return { name, label: value.title || name, required: schema.required?.includes(name) || false, schema: value, options };
    });
  }
  function validate(schema, content) {
    if (!content || typeof content !== 'object' || Array.isArray(content)) throw new Error('表单答案无效');
    const definitions = fields(schema);
    if (Object.keys(content).some(key => !definitions.some(field => field.name === key))) throw new Error('答案包含未知字段');
    const output = Object.create(null);
    for (const field of definitions) {
      if (!Object.hasOwn(content, field.name)) { if (field.required) throw new Error('请填写：' + field.label); continue; }
      const value = content[field.name], rule = field.schema;
      let valid = true;
      if (rule.type === 'string') {
        valid = typeof value === 'string' && value.length <= 10000;
        if (valid) {
          const length = [...value].length;
          valid = (rule.minLength === undefined || length >= rule.minLength) && (rule.maxLength === undefined || length <= rule.maxLength);
          if (rule.format === 'email') valid &&= /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
          if (rule.format === 'uri') { try { new URL(value); } catch { valid = false; } }
          if (rule.format === 'date') valid &&= /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
          if (rule.format === 'date-time') valid &&= /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value));
        }
        if (field.options) valid &&= field.options.some(option => option.value === value);
      } else if (rule.type === 'boolean') valid = typeof value === 'boolean';
      else if (rule.type === 'array') valid = Array.isArray(value) && value.every(item => field.options.some(option => option.value === item)) && new Set(value).size === value.length && (rule.minItems === undefined || value.length >= rule.minItems) && (rule.maxItems === undefined || value.length <= rule.maxItems);
      else valid = typeof value === 'number' && Number.isFinite(value) && (rule.type !== 'integer' || Number.isInteger(value)) && (rule.minimum === undefined || value >= rule.minimum) && (rule.maximum === undefined || value <= rule.maximum);
      if (!valid) throw new Error('请检查：' + field.label);
      output[field.name] = value;
    }
    return output;
  }
  function answer(request, value) {
    const action = value?.action;
    if (!['accept', 'decline', 'cancel'].includes(action)) throw new Error('无效交互操作');
    if (action !== 'accept') return { action };
    if (request.mode === 'url') {
      const url = new URL(request.url);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('不支持的授权链接');
      return { action };
    }
    if (request.mode && request.mode !== 'form') throw new Error('不支持的交互类型');
    return { action, content: validate(request.requestedSchema, value.content) };
  }
  const api = { fields, validate, answer };
  if (typeof module !== 'undefined') module.exports = api; else root.interactionSchema = api;
})(globalThis);
