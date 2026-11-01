const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { SSHConnections } = require('../src/ssh.cjs');
const { RemoteFiles } = require('../src/files.cjs');
const { shellQuote } = require('../src/remote.cjs');

async function command(connections, session, script) {
  const child = connections.spawn(session, 'python3 -c ' + shellQuote(script));
  child.stdin.end();
  let data = '', error = '';
  child.stdout.on('data', chunk => { data += chunk; });
  child.stderr.on('data', chunk => { error += chunk; });
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(error)));
  });
  return data.trim();
}
(async () => {
  const connections = new SSHConnections();
  const files = new RemoteFiles(connections);
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'remotecc-files-test-'));
  const session = { id: 'file-test-session', host: process.env.REMOTECC_TEST_HOST || 'axi', directory: '~' };
  let folder, worktree;
  try {
    await connections.connect(session);
    console.log('SSH connected');
    const failing = connections.spawn(session, 'exit 255'); failing.stdin.end();
    await new Promise(resolve => failing.on('close', resolve));
    await connections.checkMaster(connections.connections.values().next().value);
    assert.equal(connections.state(session).status, 'connected', 'Remote exit 255 must not disconnect a healthy master');
    const hello = await files.run(session, { operation: 'hello' });
    assert.ok(hello.home.startsWith('/'));
    folder = await command(connections, session, "import tempfile; print(tempfile.mkdtemp(prefix='remotecc-test-'))");
    assert.match(folder, /^\/tmp\/remotecc-test-/);
    session.directory = folder;
    const filename = "测试 'file' $(literal).txt";
    const contents = 'RemoteCC 文件传输测试\n第二行\n';
    fs.writeFileSync(path.join(local, filename), contents);
    const uploaded = await files.upload(session, path.join(local, filename), folder);
    assert.equal(uploaded.path, folder + '/' + filename);
    assert.equal(uploaded.size, Buffer.byteLength(contents));
    await assert.rejects(() => files.upload(session, path.join(local, filename), folder), /exist|已存在/i);
    const listing = await files.list(session, folder);
    assert.equal(listing.entries.length, 1);
    const preview = await files.preview(session, uploaded.path);
    assert.equal(preview.kind, 'text');
    assert.equal(preview.text, contents);
    assert.deepEqual(files.resolveAttachments(session, [uploaded.id]), [{ name: filename, path: uploaded.path, size: uploaded.size }]);
    assert.throws(() => files.resolveAttachments({ ...session, id: 'different' }, [uploaded.id]));
    const downloaded = path.join(local, 'download.txt');
    await files.download(session, uploaded.path, downloaded);
    assert.equal(fs.readFileSync(downloaded, 'utf8'), contents);
    const edited = await files.save(session, uploaded.path, 'updated\n', preview.revision);
    assert.equal(edited.text, 'updated\n');
    await assert.rejects(() => files.save(session, uploaded.path, 'stale', preview.revision), /已变化/);
    assert.equal((await files.preview(session, uploaded.path)).text, 'updated\n');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6YV8AAAAASUVORK5CYII=', 'base64');
    fs.writeFileSync(path.join(local, 'image.png'), png);
    const imageFile = await files.upload(session, path.join(local, 'image.png'), folder);
    const image = await files.preview(session, imageFile.path);
    assert.equal(image.kind, 'image');
    assert.deepEqual(Buffer.from(image.data, 'base64'), png);
    await assert.rejects(() => files.preview(session, '/dev/zero'), /普通文件/);
    await assert.rejects(() => files.list(session, folder + '/missing'));
    await assert.rejects(files.run(session, { operation: 'createWorktree', branch: 'remotecc/no-repo' }));
    await command(connections, session, 'import subprocess\np=' + JSON.stringify(folder) + '\nsubprocess.run(["git","init",p],check=True,capture_output=True)\nsubprocess.run(["git","-C",p,"add","."],check=True)\nsubprocess.run(["git","-C",p,"-c","user.name=Test","-c","user.email=test@example.invalid","commit","-m","fixture"],check=True,capture_output=True)');
    worktree = await files.run(session, { operation: 'createWorktree', branch: 'remotecc/test' });
    assert.equal((await files.preview(session, worktree.path + '/' + filename)).text, 'updated\n');
    await assert.rejects(files.run(session, { operation: 'createWorktree', branch: '--bad' }), /分支/);
    const history = await require('../src/agent-client.cjs').agentFor(connections).call(session, 'history', { operation: 'list' });
    assert.ok(Array.isArray(history.sessions));
    if (history.sessions.length) {
      const page = await require('../src/agent-client.cjs').agentFor(connections).call(session, 'history', { operation: 'messages', reference: history.sessions[0].reference });
      assert.ok(Array.isArray(page.records));
    }
    console.log('PASS remote worktree contents, invalid branch rejection, history discovery and message loading');
    await command(connections, session, 'import subprocess,os\nsubprocess.run(["git","-C",' + JSON.stringify(folder) + ',"worktree","remove",' + JSON.stringify(worktree.path) + '],check=True)\nos.rmdir(' + JSON.stringify(folder + '-worktrees') + ')');
    worktree = null;
    await command(connections, session, 'import shutil; shutil.rmtree(' + JSON.stringify(folder) + ')');
    folder = null;
    await connections.disconnect(session);
    assert.equal(connections.state(session).status, 'disconnected');
    assert.throws(() => connections.spawn(session, 'true'), /SSH/);
    await connections.connect(session);
    assert.equal(connections.state(session).status, 'connected');
    console.log('PASS: real SSH connect/reconnect, browse, upload, no overwrite, literal filenames, text/image preview, attachment binding, byte-identical download');
  } finally {
    if (folder && connections.state(session).status === 'connected')
      await command(connections, session, 'import shutil; shutil.rmtree(' + JSON.stringify(folder) + ')').catch(() => {});
    await connections.close();
    fs.rmSync(local, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
