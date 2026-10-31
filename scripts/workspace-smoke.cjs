const { _electron: electron } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { SSHConnections } = require('../src/ssh.cjs');
const { shellQuote } = require('../src/remote.cjs');

async function remote(connections, script) {
  const child = connections.spawn({ host: (process.env.REMOTECC_TEST_HOST || 'axi'), directory: '~' }, 'python3 -c ' + shellQuote(script));
  child.stdin.end();
  let output = '', error = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { error += data; });
  await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => code ? reject(new Error(error)) : resolve()); });
  return output.trim();
}
function pdfFixture() {
  const content = 'BT /F1 20 Tf 50 150 Td (RemoteCC preview test) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 230] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let data = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(data)); data += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(data);
  data += 'xref\n0 6\n0000000000 65535 f \n';
  data += offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  data += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return data;
}
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remotecc-workspace-ui-'));
  const connections = new SSHConnections();
  const config = { host: (process.env.REMOTECC_TEST_HOST || 'axi'), directory: '~' };
  let remoteDirectory, application;
  try {
    await connections.connect(config);
    remoteDirectory = await remote(connections, "import tempfile; print(tempfile.mkdtemp(prefix='remotecc-ui-test-'))");
    assert.match(remoteDirectory, /^\/tmp\/remotecc-ui-test-/);
    const textFile = path.join(root, '需求说明.txt');
    const imageFile = path.join(root, 'image.png');
    const pdfFile = path.join(root, 'report.pdf');
    fs.writeFileSync(textFile, 'RemoteCC workspace\n中文内容 <script>not executable</script>\n');
    fs.writeFileSync(imageFile, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6YV8AAAAASUVORK5CYII=', 'base64'));
    fs.writeFileSync(pdfFile, pdfFixture());
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const executablePath = process.env.REMOTECC_EXECUTABLE;
    application = await electron.launch({ ...(executablePath ? { executablePath } : {}),
      args: [...(executablePath ? [] : [path.resolve('.')]), '--user-data-dir=' + path.join(root, 'profile')], env });
    const page = await application.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await application.evaluate(({ dialog, shell }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: selected });
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: selected[0] + '.download' });
      shell.openPath = async file => { globalThis.testOpenedFile = file; return ''; };
    }, [textFile, imageFile, pdfFile]);
    await page.getByRole('button', { name: 'SSH 设置', exact: true }).click();
    await page.locator('[name=host]').fill('ssh ' + (process.env.REMOTECC_TEST_HOST || 'axi'));
    await page.locator('[name=directory]').fill(remoteDirectory);
    await page.locator('#connection-form button[type=submit]').click();
    await page.waitForFunction(() => window.workspaceState === 'connected' && currentListing, null, { timeout: 45000 });
    assert.equal(await page.locator('#file-path').inputValue(), remoteDirectory);
    await page.locator('#upload-files').click();
    await page.waitForFunction(() => !uploading && window.workspaceAttachments().length === 3, null, { timeout: 60000 });
    assert.equal(await page.locator('.file-entry').count(), 3);
    assert.equal(await page.locator('#attachments .attachment-chip').count(), 3);
    await page.screenshot({ path: 'dist/workspace-files.png' });
    await page.locator('.file-entry').filter({ hasText: '需求说明.txt' }).click();
    await page.locator('#preview-content pre').waitFor();
    assert.ok((await page.locator('#preview-content pre').textContent()).includes('<script>not executable</script>'));
    assert.equal(await page.locator('#preview-content script').count(), 0);
    await page.locator('#download-preview').click();
    await page.waitForFunction(() => !document.querySelector('#download-preview').disabled);
    assert.deepEqual(fs.readFileSync(textFile + '.download'), fs.readFileSync(textFile));
    await page.locator('#open-preview').click();
    await page.waitForFunction(() => !document.querySelector('#open-preview').disabled);
    const cached = await application.evaluate(() => globalThis.testOpenedFile);
    assert.deepEqual(fs.readFileSync(cached), fs.readFileSync(textFile));
    fs.rmSync(path.dirname(cached), { recursive: true, force: true });
    await page.locator('#edit-preview').click();
    await page.locator('#remote-editor').fill('Edited from RemoteCC UI');
    await application.evaluate(({ dialog }) => { globalThis.originalMessageBox = dialog.showMessageBoxSync; globalThis.unsavedPromptCount = 0; dialog.showMessageBoxSync = () => { globalThis.unsavedPromptCount++; return 0; }; });
    await application.evaluate(({ app }) => app.quit());
    assert.equal(await application.evaluate(() => globalThis.unsavedPromptCount), 1);
    assert.equal(await page.locator('#remote-editor').inputValue(), 'Edited from RemoteCC UI');
    await application.evaluate(({ dialog }) => { dialog.showMessageBoxSync = globalThis.originalMessageBox; });
    await page.locator('#save-preview').click();
    await page.waitForFunction(() => document.querySelector('#preview-info').textContent === '已保存到远端');
    assert.equal(await remote(connections, 'print(open(' + JSON.stringify(remoteDirectory + '/需求说明.txt') + ').read())'), 'Edited from RemoteCC UI');
    await page.locator('#close-preview').click();
    await page.locator('.file-entry').filter({ hasText: 'image.png' }).click();
    await page.locator('#preview-content img').waitFor();
    await page.waitForFunction(() => document.querySelector('#preview-content img')?.naturalWidth > 0);
    await page.locator('#close-preview').click();
    await page.locator('.file-entry').filter({ hasText: 'report.pdf' }).click();
    await page.locator('#preview-content iframe').waitFor();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'dist/workspace-pdf.png' });
    await page.locator('#close-preview').click();
    await page.locator('#use-folder').click();
    await page.waitForFunction(expected => activeSession()?.directory === expected, remoteDirectory);
    await page.locator('#disconnect-server').click();
    await page.waitForFunction(() => window.workspaceState === 'disconnected');
    await page.locator('#connect-server').click();
    await page.waitForFunction(() => window.workspaceState === 'connected' && currentListing, null, { timeout: 30000 });
    assert.deepEqual(errors, []);
    console.log('PASS: real SSH UI, browse, native upload selection, attachments, text/image/PDF preview, verified download/local cache, workspace selection, reconnect');
  } finally {
    if (application) await application.close();
    if (remoteDirectory) await remote(connections, 'import shutil; shutil.rmtree(' + JSON.stringify(remoteDirectory) + ')').catch(() => {});
    await connections.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
