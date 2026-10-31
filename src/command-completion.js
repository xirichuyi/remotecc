// Pure presentation helpers: all command names and aliases come from the remote catalogue.
(function (root) {
  function candidates(catalogue = []) {
    const commands = new Map();
    for (const command of catalogue) {
      if (!commands.has(command.name) || command.builtin) commands.set(command.name, command);
    }
    for (const command of catalogue) {
      for (const alias of command.aliases || []) {
        if (!commands.has(alias)) commands.set(alias, { ...command, name: alias });
      }
    }
    return [...commands.values()];
  }
  function match(commands, query) {
    query = query.toLowerCase();
    if (!query) return commands;
    const rank = command => {
      const name = command.name.toLowerCase();
      if (name === query) return 0;
      if (name.startsWith(query)) return 1;
      if (name.includes(query)) return 2;
      if ((command.description || '').toLowerCase().includes(query)) return 3;
      return 4;
    };
    return commands.map((command, index) => ({ command, index, rank: rank(command) }))
      .filter(item => item.rank < 4)
      .sort((a, b) => a.rank - b.rank || (a.rank === 1 ? a.command.name.length - b.command.name.length : 0) || a.index - b.index)
      .map(item => item.command);
  }
  // Like AgentBox's composer, replace only the command token, never its arguments.
  function token(value, start = value.length, end = start) {
    if (!value.startsWith('/') || start !== end) return null;
    const space = value.search(/\s/);
    const stop = space < 0 ? value.length : space;
    return start >= 1 && start <= stop ? { query: value.slice(1, stop), stop } : null;
  }
  function complete(value, selection, command) {
    const rest = value.slice(selection.stop);
    const prefix = '/' + command.name;
    return { value: prefix + (rest || ' '), caret: prefix.length + (rest ? 0 : 1) };
  }
  const api = { candidates, match, token, complete };
  if (typeof module !== 'undefined') module.exports = api;
  else root.commandCompletion = api;
})(globalThis);
