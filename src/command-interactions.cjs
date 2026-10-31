function resolveCommand(catalogue, text) {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const named = catalogue.filter(command => command.name === match[1]);
  const command = named.find(command => command.builtin) || named[0] || catalogue.find(command => command.aliases?.includes(match[1]));
  return command ? { command, argument: (match[2] || '').trim(), typedName: match[1] } : null;
}

function interaction(caps, text, preferences = {}) {
  const resolved = resolveCommand(caps.commands || [], text);
  if (!resolved?.command.builtin) return null;
  const { command, argument, typedName } = resolved;
  if (command.name === 'clear' && !argument) return { kind: 'newConversation', command: typedName };
  if (command.name === 'model') return { kind: 'model', command: typedName, argument,
    selected: preferences.selectedModel || 'default', options: caps.models.map(model => ({ value: model.value, label: model.displayName, description: model.description })) };
  // A finite argument menu comes from the remote command's own grammar.
  // Never invent arguments for arbitrary hints such as <file> or key=value.
  const enumeration = /^<([a-zA-Z0-9_-]+(?:\|[a-zA-Z0-9_-]+)+)>$/.exec(command.argumentHint || '');
  if (command.name === 'effort') {
    const model = caps.models.find(model => model.value === (preferences.selectedModel || 'default'));
    const values = enumeration ? enumeration[1].split('|').filter(value => value === 'auto' || !model || model.supportedEffortLevels?.includes(value)) : [...(model?.supportedEffortLevels || []), 'auto'];
    return { kind: 'effort', command: typedName, argument, selected: preferences.effort || 'auto', options: values.map(value => ({value,label:value})), description: command.description };
  }
  if (!argument && enumeration) return { kind: 'argument', command: typedName,
    options: enumeration[1].split('|').map(value => ({value,label:value})), description: command.description };
  return null;
}
module.exports = { resolveCommand, interaction };
