const { _electron: electron } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { SSHConnections } = require('../src/ssh.cjs');
const { RemoteFiles } = require('../src/files.cjs');
const { shellQuote } = require('../src/remote.cjs');

async function remote(connections, session, script) {
  const child = connections.spawn(session, 'python3 -c ' + shellQuote(script));
  child.stdin.end();
  let output = '', error = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { error += data; });
  await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => code ? reject(new Error(error)) : resolve()); });
  return output.trim();
}
async function awaitReply(page, folder) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const session = await page.evaluate(() => activeSession());
    if (['idle', 'error', 'stopped'].includes(session.status)) {
      assert.equal(session.status, 'idle', session.messages.at(-1).error || 'Claude stopped');
      return session;
    }
    for (const permission of session.permissions) {
      const file = permission.input.file_path || '';
      const allow = ['Read', 'Write', 'Edit'].includes(permission.name) && file.startsWith(folder + '/');
      console.log('PERMISSION', permission.name, allow ? 'allow test directory only' : 'deny');
      await page.evaluate(({ id, requestId, allow }) => window.remoteCC.respond(id, requestId, { allow }),
        { id: session.id, requestId: permission.id, allow });
    }
    await page.waitForTimeout(300);
  }
  throw new Error('Claude response timeout');
}
(async () => {
  const host = process.env.REMOTECC_TEST_HOST || 'axi';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remotecc-claude-test-'));
  const connections = new SSHConnections();
  const files = new RemoteFiles(connections);
  const config = { id: 'integration', host, directory: '~' };
  let folder, application;
  try {
    await connections.connect(config);
    folder = await remote(connections, config, "import tempfile; print(tempfile.mkdtemp(prefix='remotecc-claude-test-'))");
    assert.match(folder, /^\/tmp\/remotecc-claude-test-/);
    config.directory = folder;
    const nonce = randomUUID();
    const content = `RemoteCC file test\nCode: ${nonce}\n`;
    const localFile = path.join(root, 'input.txt');
    fs.writeFileSync(localFile, content);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const executablePath = process.env.REMOTECC_EXECUTABLE;
    application = await electron.launch({ ...(executablePath ? { executablePath } : {}),
      args: [...(executablePath ? [] : [path.resolve('.')]), '--user-data-dir=' + path.join(root, 'profile')], env });
    const page = await application.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await application.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file + '.result' });
    }, localFile);
    await page.locator('#connection-settings').click();
    await page.locator('[name=host]').fill('ssh ' + host);
    await page.locator('[name=directory]').fill(folder);
    await page.locator('#connection-form button[type=submit]').click();
    await page.waitForFunction(() => window.workspaceState === 'connected' && currentListing, null, { timeout: 30000 });
    await page.locator('#upload-attachment').click();
    await page.waitForFunction(() => !uploading && window.workspaceAttachments().length === 1, null, { timeout: 30000 });
    console.log('UPLOADED: remote file attached through actual client');
    await page.locator('#prompt').fill('这是客户端文件链路测试。请使用 Read 读取附件 input.txt，然后使用 Write 在当前工作目录创建 result.txt，内容与 input.txt 完全相同。不要使用 Bash，不要访问其他目录。最后回复文件中的 Code，并给出 result.txt 的 Markdown 链接。');
    await page.locator('#prompt').press('Enter');
    await page.waitForFunction(() => activeSession()?.messages.length === 2);
    const first = await awaitReply(page, folder);
    const text = first.messages.at(-1).blocks.filter(block => block.type === 'text').map(block => block.text).join('\n');
    assert.ok(text.includes(nonce), 'Claude must read the unique code from the uploaded file');
    const result = await files.preview(config, folder + '/result.txt');
    assert.equal(result.text, content);
    console.log('CLAUDE: read uploaded bytes and generated matching result.txt');
    await page.waitForFunction(() => [...document.querySelectorAll('.file-entry')].some(item => item.textContent.includes('result.txt')));
    await page.locator('.file-entry').filter({ hasText: 'result.txt' }).click();
    await page.locator('#preview-content pre').waitFor();
    assert.equal(await page.locator('#preview-content pre').textContent(), content);
    await page.locator('#download-preview').click();
    await page.waitForFunction(() => !document.querySelector('#download-preview').disabled);
    assert.equal(fs.readFileSync(localFile + '.result', 'utf8'), content);
    await page.screenshot({ path: 'dist/claude-generated-file.png' });
    await page.locator('#close-preview').click();
    await page.locator('#prompt').fill('不要调用工具，只根据刚才的对话回复那个 Code。');
    await page.locator('#prompt').press('Enter');
    await page.waitForFunction(() => activeSession()?.messages.length === 4);
    const second = await awaitReply(page, folder);
    assert.equal(second.remoteSessionId, first.remoteSessionId);
    assert.ok(second.messages.at(-1).blocks.some(block => block.type === 'text' && block.text.includes(nonce)));
    await page.screenshot({ path: 'dist/claude-workspace.png' });
    assert.deepEqual(errors, []);
    console.log('PASS: actual Claude upload/read/write, scoped permission approval, generated-file preview/download, and resumed conversation on ' + host);
  } finally {
    if (application) await application.close();
    if (folder) await remote(connections, config, 'import shutil; shutil.rmtree(' + JSON.stringify(folder) + ')').catch(() => {});
    await connections.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
