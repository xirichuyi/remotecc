// Real SSH + Electron coverage of the command interactions learned from AgentBox.
const { _electron: electron } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'remotecc-commands-'));
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
  let app;
  const owned = [];
  try {
    const executablePath = process.env.REMOTECC_EXECUTABLE;
    app = await electron.launch({...(executablePath ? {executablePath} : {}),
      args: [...(executablePath ? [] : [path.resolve('.')]), '--user-data-dir=' + profile], env});
    const page = await app.firstWindow();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => typeof activeSession === 'function');
    owned.push(await page.evaluate(async () => {
      const config = {host:'axi', directory:'/tmp'};
      await api.connect(config);
      const session = await api.create(config);
      if (!sessions.some(item => item.id === session.id)) sessions.unshift(session);
      selectSession(session.id); return session.id;
    }));
    await page.waitForFunction(() => activeSession()?.capabilities?.commands?.length, null, {timeout:60000});
    const prompt = page.locator('#prompt');
    // Editing an existing command keeps its argument; Enter applies in one action.
    await prompt.fill('/mod sonnet');
    await prompt.evaluate(input => {input.setSelectionRange(4,4); input.dispatchEvent(new Event('click'));});
    await page.locator('#command-menu .selected').waitFor();
    await prompt.press('Tab');
    assert.equal(await prompt.inputValue(), '/model sonnet');
    await prompt.press('Enter');
    await page.waitForFunction(() => activeSession()?.preferences?.selectedModel === 'sonnet' && !document.querySelector('#prompt').value, null, {timeout:60000});
    // Composition and reverse-tab navigation must never execute a command.
    await prompt.fill('/us');
    await prompt.dispatchEvent('keydown', {key:'Enter', code:'Enter', keyCode:229, isComposing:true});
    assert.equal(await prompt.inputValue(), '/us');
    await prompt.press('Shift+Tab');
    assert.equal(await prompt.inputValue(), '/us');
    assert.equal(await page.evaluate(() => activeSession().messages.length), 0);
    // Native local command executes from a partial match with one Enter.
    await prompt.fill('/conte'); await prompt.press('Enter');
    await page.waitForFunction(() => activeSession()?.messages.length === 2 && ['idle','error'].includes(activeSession().status), null, {timeout:60000});
    const previous = await page.evaluate(() => activeSession());
    assert.equal(previous.messages[0].text, '/context');
    assert.equal(previous.status, 'idle', previous.messages.at(-1).error);
    assert.ok(previous.messages.at(-1).blocks.some(block => block.text?.length));
    // Native clear is represented as a new conversation without deleting history.
    await prompt.fill('/clear'); await prompt.press('Enter');
    await page.waitForFunction(id => activeId !== id, previous.id, {timeout:60000});
    owned.push(await page.evaluate(() => activeId));
    assert.equal(await page.evaluate(() => activeSession().messages.length), 0);
    assert.equal(await page.evaluate(() => activeSession().preferences.selectedModel), 'sonnet');
    assert.equal(await page.evaluate(id => sessions.find(item => item.id === id).messages.length, previous.id), 2);
    assert.deepEqual(errors, []);
    console.log('PASS axi: suffix-preserving completion, one-Enter native command, IME, Shift+Tab, clear preserves history/model');
  } finally {
    if (app) {
      const page = await app.firstWindow();
      for (const id of owned) await page.evaluate(id => api.remove(id), id).catch(error => console.error('Test cleanup:', error.message));
      await app.close();
    }
    fs.rmSync(profile, {recursive:true, force:true});
  }
})().catch(error => {console.error(error); process.exitCode=1;});
