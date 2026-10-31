const { _electron: electron } = require('playwright');
const { SSHConnections } = require('../src/ssh.cjs');
const { ChatService } = require('../src/chat-service.cjs');
const { remoteCommand, shellQuote } = require('../src/remote.cjs');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
async function python(ssh, config, source) {
  const child = ssh.spawn(config, 'python3 -c ' + shellQuote(source)); child.stdin.end();
  let output = '', error = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { error += data; });
  const [code] = await once(child, 'close'); if (code) throw new Error(error); return output.trim();
}
(async () => {
  const ssh = new SSHConnections();
  const config = { host: 'axi', directory: '~' };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'remotecc-history-ui-'));
  let application, directory, remoteId;
  const service = new ChatService({ load: () => [], save() {} });
  service.spawn = (session, options, onError) => {
    const child = ssh.spawn(session, remoteCommand(session, options.args), { signal: options.signal });
    child.stderr.setEncoding('utf8'); child.stderr.on('data', onError); return child;
  };
  try {
    await ssh.connect(config);
    directory = await python(ssh, config, "import tempfile; print(tempfile.mkdtemp(prefix='remotecc-history-test-'))");
    const token = 'HISTORY-' + randomUUID();
    const session = service.create({ ...config, directory });
    service.configure(session.id, { selectedModel: 'sonnet', effort: 'low' });
    service.send(session.id, `Remember the exact token ${token}. Reply OK only. Do not use tools.`);
    while (service.runs.size) await once(service, 'changed');
    assert.equal(session.status, 'idle', session.messages.at(-1).error);
    remoteId = session.remoteSessionId;
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const executablePath = process.env.REMOTECC_EXECUTABLE;
    application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : [path.resolve('.')]), '--user-data-dir=' + profile], env });
    const page = await application.firstWindow(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.locator('#connection-settings').click(); await page.locator('[name=host]').fill('axi');
    await page.locator('#connection-form button[type=submit]').click();
    await page.waitForFunction(() => !document.querySelector('#connection-dialog').open && document.querySelector('#history-status').textContent.includes('条远端会话'), null, { timeout: 90000 });
    const before = await page.evaluate(remoteId => {
      const target = sessions.find(session => session.remoteSessionId === remoteId);
      return { id: target?.id, loaded: target?.historyLoaded, messages: target?.messages.length, discovered: sessions.filter(s => s.remoteHistoryRef).length, othersEmpty: sessions.filter(s => s.remoteHistoryRef).every(s => s.messages.length === 0) };
    }, remoteId);
    assert.ok(before.id); assert.ok(before.discovered > 1); assert.equal(before.loaded, false); assert.equal(before.messages, 0); assert.equal(before.othersEmpty, true);
    await page.locator('#search').fill(directory);
    assert.equal(await page.locator('#chat-list .chat-item').count(), 1);
    await page.locator('#chat-list .chat-item').click();
    await page.waitForFunction(() => activeSession()?.historyLoaded === true && window.workspaceState === 'connected', null, { timeout: 60000 });
    assert.ok((await page.locator('#messages').innerText()).includes(token));
    assert.equal(await page.evaluate(() => activeSession().directory), directory);
    await page.evaluate(() => api.configure(activeId, { selectedModel: 'sonnet', effort: 'low' }));
    await page.locator('#prompt').fill('What exact token did I ask you to remember? Reply with the token only. Do not use tools.');
    await page.locator('#prompt').press('Enter');
    await page.waitForFunction(() => activeSession()?.messages.length >= 4 && activeSession().status === 'idle', null, { timeout: 90000 });
    const resumed = await page.evaluate(() => activeSession());
    assert.equal(resumed.remoteSessionId, remoteId);
    assert.ok(resumed.messages.at(-1).blocks.some(block => block.text?.includes(token)));
    const count = await page.evaluate(() => sessions.length);
    await page.locator('#refresh-history').click();
    await page.waitForFunction(() => !document.querySelector('#refresh-history').disabled);
    assert.equal(await page.evaluate(() => sessions.length), count);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: 'dist/history-axi.png' });
    console.log('PASS: axi automatic metadata-only discovery, search by project, lazy messages, exact remote-session continuation, deduplication');
  } finally {
    if (application) await application.close(); await service.close();
    if (directory) await python(ssh, config, 'import shutil; shutil.rmtree(' + JSON.stringify(directory) + ')').catch(() => {});
    if (remoteId) await python(ssh, config, 'import os,glob\nfor file in glob.glob(os.path.expanduser("~/.claude/projects/*/' + remoteId + '.jsonl")):\n os.unlink(file)\n try: os.rmdir(os.path.dirname(file))\n except OSError: pass').catch(() => {});
    await ssh.close(); fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
