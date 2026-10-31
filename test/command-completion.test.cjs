const test = require('node:test');
const assert = require('node:assert/strict');
const { candidates, match } = require('../src/command-completion.js');
const remote = [
  { name: 'unrelated-skill', description: 'Use when creating a project' },
  { name: 'usage-credits', description: 'Configure credits' },
  { name: 'extra-usage', description: 'Credits' },
  { name: 'usage', description: 'Remote usage', aliases: ['cost', 'stats'] },
  { name: 'model', description: 'Model selector' },
];
test('partial command names rank ahead of description matches and longer prefixes', () => {
  const commands = candidates(remote);
  assert.equal(match(commands, 'us')[0].name, 'usage');
  assert.deepEqual(match(commands, 'us').slice(0, 3).map(item => item.name), ['usage', 'usage-credits', 'extra-usage']);
  assert.equal(match(commands, 'usage-')[0].name, 'usage-credits');
  assert.equal(match(commands, 'MOD')[0].name, 'model');
});
test('aliases use remote metadata and no unrelated local commands are added', () => {
  assert.equal(match(candidates(remote), 'co')[0].name, 'cost');
  assert.equal(match(candidates(remote), 'ports').length, 0);
  assert.equal(candidates([]).length, 0);
});
test('remote builtin precedence and explicit command names take priority over aliases', () => {
  const commands = candidates([
    { name: 'usage', description: 'builtin', builtin: true, aliases: ['cost'] },
    { name: 'usage', description: 'project skill' },
    { name: 'cost', description: 'explicit name' },
  ]);
  assert.equal(commands.find(command => command.name === 'usage').description, 'builtin');
  assert.equal(commands.find(command => command.name === 'cost').description, 'explicit name');
});

test('completion edits only the command under the caret and preserves arguments', () => {
  const {token, complete} = require('../src/command-completion.js');
  const input = '/mod sonnet';
  assert.equal(token(input), null);
  assert.equal(token(input, 1, 4), null);
  assert.equal(token('explain /mod', 12), null);
  const selection = token(input, 4);
  assert.equal(selection.query, 'mod');
  assert.deepEqual(complete(input, selection, {name:'model'}), {value:'/model sonnet', caret:6});
  assert.deepEqual(complete('/us', token('/us'), {name:'usage'}), {value:'/usage ', caret:7});
});
