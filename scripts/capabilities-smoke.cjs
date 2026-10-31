const { _electron: electron } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'remotecc-real-chat-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.REMOTECC_EXECUTABLE;
  let application;
  try {
    application = await electron.launch({ ...(executablePath ? { executablePath } : {}),
      args: [...(executablePath ? [] : [path.resolve('.')]), '--user-data-dir=' + profile], env });
    const page = await application.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.locator('#connection-settings').click();
    await page.locator('[name=host]').fill(process.env.REMOTECC_TEST_HOST || 'axi');
    await page.locator('#connection-form button[type=submit]').click();
    await page.waitForFunction(() => window.workspaceState === 'connected' && activeSession(), null, { timeout: 30000 });
    await page.waitForFunction(() => activeSession()?.capabilities?.models?.length > 0, null, { timeout: 60000 });
    await page.locator('#prompt').fill('/');
    await page.locator('#prompt').dispatchEvent('input');
    await page.waitForFunction(() => !document.querySelector('#command-menu').hidden);
    const catalogue = await page.evaluate(() => activeSession().capabilities.commands);
    const expected = [...new Set(catalogue.flatMap(command => [command.name, ...(command.aliases || [])]))].sort();
    const displayed = await page.locator('.command-item strong').allTextContents();
    assert.deepEqual(displayed.map(name => name.slice(1)).sort(), expected);
    await page.locator('#prompt').press('Escape');
    await page.locator('#model-label').click();
    await page.locator('[name=selectedModel]').selectOption('sonnet');
    await page.locator('[name=effort]').selectOption('low');
    await page.locator('#preferences-form button[type=submit]').click();
    await page.waitForFunction(() => activeSession()?.preferences?.selectedModel === 'sonnet');
    await page.locator('#prompt').fill('Reply with OK only. Do not use tools.');
    await page.locator('#prompt').press('Enter');
    await page.waitForFunction(() => activeSession()?.messages.length >= 2 && ['idle', 'error'].includes(activeSession().status), null, { timeout: 60000 });
    const session = await page.evaluate(() => activeSession());
    assert.equal(session.host, process.env.REMOTECC_TEST_HOST || 'axi');
    assert.ok(session.remoteSessionId, 'Remote Claude must initialize the SDK session');
    assert.equal(session.messages.length, 2);
    assert.equal(session.status, 'idle', session.messages.at(-1).error);
    assert.match(session.model, /sonnet/i);
    assert.equal(session.preferences.effort, 'low');
    assert.equal(session.permissions.length, 0);
    assert.deepEqual(errors, []);
    await page.evaluate(() => showDetails('context'));
    assert.doesNotMatch(await page.locator('#control-content').innerText(), /undefined|NaN|超时|Error/);
    await page.locator('#close-control').click();
    await page.evaluate(() => api.fork(activeId).then(chooseSession));
    await page.locator('#prompt').fill('Reply with BRANCH only. Do not use tools.');
    await page.locator('#prompt').press('Enter');
    await page.waitForFunction(() => activeSession()?.messages.length === 4 && ['idle', 'error'].includes(activeSession().status), null, { timeout: 90000 });
    const branch = await page.evaluate(() => activeSession());
    assert.equal(branch.status, 'idle', branch.messages.at(-1).error);
    assert.notEqual(branch.remoteSessionId, session.remoteSessionId);
    assert.equal(branch.preferences.selectedModel, 'sonnet');
    await page.screenshot({ path: path.resolve('dist/capabilities-axi.png') });
    console.log(JSON.stringify({ transport: 'SSH + remote Claude SDK protocol OK',
      outcome: session.status, model: session.model, commands: session.capabilities.commands.length, models: session.capabilities.models.length, reply: session.messages.at(-1).blocks.filter(b => b.type === 'text').map(b => b.text).join('\n'),
      error: session.messages.at(-1).error || null }, null, 2));
  } finally {
    if (application) await application.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
