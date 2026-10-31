const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSession, remoteCommand, shellQuote } = require('../src/remote.cjs');

test('shell quoting preserves untrusted strings literally', () => {
  for (const input of ["project's name", '$(echo BAD)', '`whoami`', 'a; echo BAD', 'a\nb', '']) {
    const output = spawnSync('/bin/bash', ['-c', 'printf %s ' + shellQuote(input)], { encoding: 'utf8' });
    assert.equal(output.stdout, input);
    assert.equal(output.status, 0);
  }
});
test('rejects SSH option injection and invalid directories', () => {
  for (const host of ['-oProxyCommand=bad', 'pas;ls', 'pas\nother', ''])
    assert.throws(() => createSession({ host, directory: '~' }));
  assert.throws(() => createSession({ host: 'pas', directory: '/foo\0bar' }));
  assert.equal(createSession({ host: 'user@host', directory: '~/a b' }).host, 'user@host');
});
test('remote command preserves literal paths and CLI arguments across both shells', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remotecc-quote-'));
  try {
    const directory = path.join(root, "project's $(echo BAD)");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(root, 'claude'), '#!/bin/sh\nprintf "%s\\n" "$PWD" "$@"\n', { mode: 0o700 });
    const args = ['--resume', "a' $(echo BAD); `whoami`", '--permission-mode=default'];
    const command = remoteCommand(createSession({ host: 'pas', directory }), args);
    const extracted = spawnSync('bash', ['-c', 'bash() { printf "%s" "$2"; }; ' + command], { encoding: 'utf8' });
    assert.equal(extracted.status, 0);
    const result = spawnSync('bash', ['-c', extracted.stdout], { encoding: 'utf8', env: { ...process.env, PATH: root + ':' + process.env.PATH } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trimEnd().split('\n'), [directory, ...args]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
