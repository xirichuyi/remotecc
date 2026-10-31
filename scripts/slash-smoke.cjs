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
    await page.waitForFunction(() => !document.querySelector('#connection-dialog').open && activeSession()?.capabilities?.commands?.length, null, { timeout: 60000 });
    await page.locator('#prompt').fill('/');
    await page.locator('#prompt').dispatchEvent('input');
    const expected = await page.evaluate(() => [...new Set(activeSession().capabilities.commands.flatMap(command => [command.name, ...(command.aliases || [])]))].sort());
    const actual = (await page.locator('#command-menu .command-item strong').allTextContents()).map(name => name.slice(1)).sort();
    assert.deepEqual(actual, expected);
    await page.locator('#prompt').fill('/context');
    await page.locator('#prompt').dispatchEvent('input');
    await page.locator('#prompt').press('Enter');
    await page.waitForFunction(() => activeSession()?.messages.length >= 2 && ['idle', 'error'].includes(activeSession().status), null, { timeout: 60000 });
    const session = await page.evaluate(() => activeSession());
    assert.equal(session.host, process.env.REMOTECC_TEST_HOST || 'axi');
    assert.ok(session.remoteSessionId, 'Remote Claude must initialize the SDK session');
    assert.equal(session.messages.length, 2);
    assert.equal(session.messages[0].text, '/context');
    assert.equal(session.status, 'idle', session.messages.at(-1).error);
    assert.ok(session.messages.at(-1).blocks.some(block => block.type === 'text' && block.text.length));
    assert.equal(await page.locator('#control-dialog').evaluate(element => element.open), false);
    assert.equal(session.permissions.length, 0);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.resolve('dist/slash-axi.png') });
    console.log(JSON.stringify({ transport: 'SSH + remote Claude SDK protocol OK',
      outcome: session.status, reply: session.messages.at(-1).blocks.filter(b => b.type === 'text').map(b => b.text).join('\n'),
      error: session.messages.at(-1).error || null }, null, 2));
  } catch (error) {
    if (application) console.error(await (await application.firstWindow()).evaluate(() => ({status: activeSession()?.status, messages: activeSession()?.messages, prompt: document.querySelector('#prompt').value, toast: document.querySelector('#toast').textContent})));
    throw error;
  } finally {
    if (application) await application.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
