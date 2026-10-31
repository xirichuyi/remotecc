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
    await page.locator('#prompt').fill('');
    await page.locator('#prompt').pressSequentially('/us');
    const names = await page.locator('#command-menu .command-item strong').allTextContents();

    assert.equal(names[0], '/usage');
    const bounds = await page.locator('#command-menu .command-item').first().boundingBox();
    assert.ok(bounds && bounds.y >= 0 && bounds.height > 0);
    await page.locator('#prompt').press('ArrowDown');
    assert.equal(await page.locator('#command-menu .selected strong').textContent(), '/usage-credits');
    await page.locator('#prompt').press('ArrowUp');
    assert.equal(await page.locator('#command-menu .selected strong').textContent(), '/usage');
    await page.locator('#prompt').press('Tab');
    assert.equal(await page.locator('#prompt').inputValue(), '/usage ');
    assert.equal((await page.evaluate(() => activeSession().messages)).length, 0);
    await page.locator('#prompt').fill('');
    await page.locator('#prompt').pressSequentially('/us');
    await page.locator('#prompt').press('Escape');
    assert.equal(await page.locator('#command-menu').isVisible(), false);
    await page.locator('#prompt').press('Backspace');
    assert.equal(await page.locator('#command-menu').isVisible(), true);
    await page.locator('#prompt').press('s');
    await page.locator('#command-menu .command-item').first().click();
    assert.equal(await page.locator('#prompt').inputValue(), '/usage ');
    assert.equal((await page.evaluate(() => activeSession().messages)).length, 0);
    for (const [prefix, candidate] of [['/mod', '/model'], ['/co', '/cost']]) {
      await page.locator('#prompt').fill('');
      await page.locator('#prompt').pressSequentially(prefix);
      assert.equal(await page.locator('#command-menu .selected strong').textContent(), candidate);
    }
    await page.locator('#prompt').fill('');
    await page.locator('#prompt').pressSequentially('/us');
    await page.screenshot({ path: path.resolve('dist/autocomplete-axi.png') });
    assert.deepEqual(errors, []);
    console.log('PASS: remote catalogue, /us prefix, Tab completion, Escape and reopen');
  } catch (error) {
    if (application) console.error(await (await application.firstWindow()).evaluate(() => ({status: activeSession()?.status, messages: activeSession()?.messages, prompt: document.querySelector('#prompt').value, toast: document.querySelector('#toast').textContent})));
    throw error;
  } finally {
    if (application) await application.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
