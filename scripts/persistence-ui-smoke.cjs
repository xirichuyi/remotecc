const { _electron: electron } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'remotecc-persistent-ui-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let application, id, page;
  const errors = [];
  const launch = async () => {
    const executablePath = process.env.REMOTECC_EXECUTABLE;
    application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : [path.resolve('.')]), '--user-data-dir=' + profile], env });
    page = await application.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => !!window.remoteCC);
  };
  try {
    await launch();
    const token = 'UI-PERSIST-' + randomUUID();
    id = await page.evaluate(async token => {
      const config = { host: 'axi', directory: '/tmp' };
      await api.connect(config);
      const session = await api.create(config);
      if (!sessions.some(item => item.id === session.id)) sessions.unshift(session);
      selectSession(session.id);
      await api.configure(session.id, { selectedModel: 'sonnet', effort: 'low' });
      await api.send(session.id, `Use AskUserQuestion to ask whether to continue with options Continue and Cancel. Wait for the answer. Then run Bash exactly: sleep 12; printf '${token}'. Finally reply with this token.`);
      return session.id;
    }, token);
    await page.waitForFunction(id => sessions.find(s => s.id === id)?.status === 'permission', id, { timeout: 120000 });
    const approval = await page.evaluate(() => activeSession().permissions[0]);
    assert.equal(approval.name, 'AskUserQuestion');
    const ownerId = await page.evaluate(() => activeSession().remoteOwner.id);
    await page.locator('#prompt').fill('/model'); await page.locator('#prompt').press('Enter');
    await page.locator('#command-interaction-form select').selectOption('haiku');
    await page.locator('#command-interaction-form button[type=submit]').click();
    await page.waitForFunction(() => !document.querySelector('#control-dialog').open && activeSession()?.preferences?.selectedModel === 'haiku', null, {timeout:60000});
    assert.equal(await page.evaluate(() => activeSession().status), 'permission');
    assert.equal(await page.evaluate(() => activeSession().permissions[0].id), approval.id);
    for (const mode of ['plan', 'default']) {
      await page.locator('#model-label').click();
      await page.locator('#preferences-form').waitFor();
      assert.equal(await page.locator('#preferences-form button[type=submit]').isDisabled(),false);
      await page.locator('#preferences-form [name=permissionMode]').selectOption(mode);
      await page.locator('#preferences-form button[type=submit]').click();
      await page.waitForFunction(mode => !document.querySelector('#control-dialog').open && activeSession()?.preferences?.permissionMode === mode, mode, {timeout:60000});
    }


    await application.close(); application = null;
    await launch();
    await page.waitForFunction(id => sessions.some(s => s.id === id), id);
    assert.equal(await page.evaluate(id => sessions.find(s => s.id === id).status, id), 'detached');
    await page.locator('#connect-server').click();
    await page.waitForFunction(() => activeSession()?.status === 'permission', null, { timeout: 60000 });
    assert.equal(await page.evaluate(() => activeSession().permissions[0].id), approval.id);
    await page.evaluate(async ({ id, approval }) => {
      await api.respond(id, approval.id, { allow: true, answers: Object.fromEntries(approval.input.questions.map(q => [q.question, 'Continue'])) });
    }, { id, approval });
    await page.waitForFunction(() => activeSession()?.status === 'working');
    await page.locator('#disconnect-server').click();
    await page.waitForFunction(() => window.workspaceState === 'disconnected');
    assert.equal(await page.evaluate(() => activeSession().status), 'detached');
    await page.locator('#connect-server').click();
    await page.waitForFunction(() => activeSession()?.status === 'idle' && !activeSession()?.remoteTask, null, { timeout: 120000 });
    assert.ok((await page.locator('#messages').innerText()).includes(token));
    assert.equal(await page.evaluate(() => activeSession().remoteOwner.id),ownerId);
    assert.ok(await page.evaluate(() => Object.keys(activeSession().usage.models).some(name => /haiku/i.test(name))));
    assert.match(await page.evaluate(() => activeSession().model),/haiku/i);
    // Stop is explicit and remains distinct from disconnect/quit.
    await page.evaluate(id => api.send(id, 'Use AskUserQuestion to ask which option I prefer: One or Two. Wait for my answer.'), id);
    await page.waitForFunction(() => activeSession()?.status === 'permission', null, { timeout: 120000 });
    await page.locator('#stop-message').click();
    await page.waitForFunction(() => activeSession()?.status === 'stopped' && !activeSession()?.remoteTask, null, { timeout: 60000 });
    assert.equal(await page.locator('.permission-card').count(), 0);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: 'dist/persistence-axi.png' });
    console.log('PASS: Electron quit/relaunch restores approval; SSH disconnect/reconnect preserves execution; live /model switches to Haiku during approval; same resident session survives Stop');
  } finally {
    if (application) await application.close();
    if (id) {
      const { SSHConnections } = require('../src/ssh.cjs');
      const { shellQuote } = require('../src/remote.cjs');
      const { ChatService } = require('../src/chat-service.cjs');
      const { ChatStore } = require('../src/store.cjs');
      const { PersistentTasks } = require('../src/persistent-tasks.cjs');
      const ssh = new SSHConnections();
      const config = { host: 'axi', directory: '/tmp' };
      try {
        await ssh.connect(config);
        const service = new ChatService(new ChatStore(path.join(profile, 'chats.json')));
        service.persistent = new PersistentTasks(ssh, service);
        const session = service.get(id);
        if (session.remoteTask) {
          await service.persistent.restore(config); await service.stop(id);
          for (let i = 0; i < 50 && session.remoteTask; i++) await new Promise(resolve => setTimeout(resolve, 200));
        }
        if (session.remoteOwner && !session.remoteTask) await service.persistent.release(session);
        if (!session.remoteTask) {
          const source = 'import os,glob,json,shutil\nfor p in glob.glob(os.path.expanduser("~/.local/state/remotecc/tasks/*")):\n try:\n  r=json.load(open(p+"/request.json")); s=json.load(open(p+"/state.json"))\n  if r["session"]["id"]==' + JSON.stringify(id) + ' and s.get("done"): shutil.rmtree(p)\n except (OSError,ValueError): pass\n' + (session.remoteSessionId ? 'for p in glob.glob(os.path.expanduser("~/.claude/projects/*/' + session.remoteSessionId + '.jsonl")): os.unlink(p)' : '');
          const child = ssh.spawn(config, 'python3 -c ' + shellQuote(source)); child.stdin.end();
          await new Promise(resolve => child.on('close', resolve));
        }
        await service.close();
      } finally { await ssh.close(); }
    }
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
