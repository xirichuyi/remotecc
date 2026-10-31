const { _electron: electron } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'remotecc-chat-ui-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let application;
  const errors = [];
  const launch = async () => {
    application = await electron.launch({ args: [path.resolve('scripts/fixture-app.cjs'), '--user-data-dir=' + profile], env });
    const page = await application.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => typeof activeSession === 'function');
    return page;
  };
  try {
    fs.mkdirSync('dist', { recursive: true });
    let page = await launch();
    await page.locator('#prompt').waitFor();
    await page.screenshot({ path: 'dist/chat-welcome.png' });
    assert.equal(await page.locator('.xterm').count(), 0);
    await page.evaluate(() => {
      const fields = questionFields({input:{questions:[{question:'Choose',multiSelect:true,options:[{label:'A'},{label:'B'}]}]}});
      fields.id='test-question';document.body.append(fields);
    });
    await page.locator('#test-question button').nth(0).click();
    await page.locator('#test-question button').nth(1).click();
    assert.equal(await page.locator('#test-question input').inputValue(),'A, B');
    await page.locator('#test-question button').nth(0).click();
    assert.equal(await page.locator('#test-question input').inputValue(),'B');
    assert.equal(await page.locator('#test-question button[aria-pressed=true]').count(),1);
    await page.locator('#test-question input').fill('Custom answer');
    assert.equal(await page.locator('#test-question button[aria-pressed=true]').count(),0);
    await page.evaluate(()=>document.querySelector('#test-question').remove());
    await page.locator('#connect-server').click();
    await page.waitForFunction(() => window.workspaceState === 'connected' && activeSession());
    await page.locator('#model-label').click();
    await page.locator('[name=agent]').selectOption('fixture-agent');
    await page.locator('#preferences-form button[type=submit]').click();
    await page.waitForFunction(()=>activeSession()?.preferences?.agent==='fixture-agent');
    await page.locator('#prompt').fill('请帮我了解这个项目的结构。');
    await page.locator('#prompt').press('Enter');
    await page.getByRole('button', { name: '允许这一次' }).waitFor();
    await page.screenshot({ path: 'dist/chat-permission.png' });
    assert.equal(await page.locator('.message.user').count(), 1);
    assert.equal(await page.locator('.permission-suggestions').isChecked(),false);
    await page.locator('.permission-suggestions').check();
    await page.getByRole('button', { name: '应用规则并允许' }).click();
    await page.waitForFunction(() => activeSession()?.status === 'idle');
    assert.equal(await page.locator('pre code').count(), 1);
    assert.equal(await page.locator('.tool-card').count(), 1);
    assert.equal(await page.locator('.permission-card').count(), 0);
    await page.screenshot({ path: 'dist/chat-conversation.png' });
    await page.locator('#prompt').fill('stop-test');
    await page.locator('#prompt').press('Enter');
    await page.getByText('这是一条尚未完成的回复。').waitFor();
    await page.getByRole('button', { name: '停止生成' }).click();
    await page.waitForFunction(() => activeSession()?.status === 'stopped');
    await page.getByRole('button', { name: '重命名对话' }).click();
    await page.locator('#rename-input').fill('项目讨论');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.waitForFunction(() => activeSession()?.name === '项目讨论');
    const safe = await page.evaluate(() => markdown('<img src=x onerror=alert(1)><script>alert(1)</script><a href="javascript:alert(1)">bad</a>'));
    assert.ok(!safe.includes('<img') && !safe.includes('<script') && !safe.includes('javascript:'));
    const links = await page.evaluate(() => markdown('[report](file:///project/report.pdf) ![plot](/project/plot.png)'));
    assert.ok(links.includes('href="/project/report.pdf"'));
    assert.ok(links.includes('href="/project/plot.png"'));
    assert.ok(!links.includes('<img'));
    await application.close();
    application = null;
    page = await launch();
    await page.waitForFunction(() => activeSession()?.messages.length === 4);
    assert.equal(await page.locator('#chat-title').textContent(), '项目讨论');
    await page.locator('#search').fill('不存在');
    assert.equal(await page.locator('.chat-item').count(), 0);
    await page.locator('#search').fill('');
    await page.evaluate(async () => {
      for (const config of [
        { host: 'axi', directory: '/projects/blog', name: '博客一' },
        { host: 'axi', directory: '/projects/blog', name: '博客二' },
        { host: 'pas', directory: '/projects/blog', name: '另一台服务器' },
        { host: 'axi', directory: '/other/blog', name: '同名目录' },
      ]) {
        const session = await api.create(config);
        if (!sessions.some(item => item.id === session.id)) sessions.push(session);
      }
      renderList();
    });
    await page.locator('#search').fill('/projects/blog');
    assert.equal(await page.locator('.project-group').count(), 2);
    assert.equal(await page.locator('.chat-item:visible').count(), 3);
    await page.locator('#search').fill('博客二');
    assert.equal(await page.locator('.project-group').count(), 1);
    assert.equal(await page.locator('.chat-item:visible').count(), 1);
    await page.locator('#search').fill('');
    const group = page.locator('.project-group').filter({ has: page.locator('.project-location', { hasText: 'axi · /projects/blog' }) });
    await group.locator('summary').click();
    await group.locator('.chat-item').first().waitFor({ state: 'visible' });
    assert.equal(await group.locator('.chat-item:visible').count(), 2);
    await page.evaluate(() => renderList());
    assert.equal(await group.locator('.chat-item:visible').count(), 2);
    await group.locator('.project-new').click();
    await page.waitForFunction(() => activeSession()?.directory === '/projects/blog' && activeSession()?.name === '新对话');
    assert.equal(await page.evaluate(() => activeSession().host), 'axi');
    await page.screenshot({ path: 'dist/project-groups.png' });
    assert.deepEqual(errors, []);
    console.log('PASS: chat UI, streaming, permission approval, Markdown/code, stop, rename, search, persistence, HTML sanitization');
  } finally {
    if (application) await application.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
