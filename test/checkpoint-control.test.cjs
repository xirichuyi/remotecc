const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { checkpointControl } = require('../src/checkpoint-control.cjs');

test('rewind requires a fresh matching preview and rejects changed files or running tasks', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-rewind-'));
  const file = path.join(directory, 'file.txt');
  fs.writeFileSync(file, 'before');
  let writes = 0, busy = false;
  const rewind = checkpointControl(() => ({ rewindFiles: async (_, options) => {
    if (!options?.dryRun) writes++;
    return { canRewind: true, filesChanged: [file] };
  } }), () => busy);
  const checkpoint = randomUUID();
  try {
    await assert.rejects(rewind({ checkpoint }), /预览/);
    let preview = await rewind({ checkpoint, preview: true });
    assert.equal(writes, 0);
    await assert.rejects(rewind({ checkpoint: randomUUID(), token: preview.token }), /预览/);
    fs.writeFileSync(file, 'changed');
    await assert.rejects(rewind({ checkpoint, token: preview.token }), /变化/);
    preview = await rewind({ checkpoint, preview: true });
    busy = true;
    await assert.rejects(rewind({ checkpoint, token: preview.token }), /停止/);
    busy = false;
    await rewind({ checkpoint, token: preview.token });
    assert.equal(writes, 1);
    await assert.rejects(rewind({ checkpoint, token: preview.token }), /预览/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('expired/replaced previews, replacement files, and old SDK cannot perform a rewind', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-rewind-edge-'));
  const file = path.join(directory, 'file.txt');
  const checkpoint = randomUUID();
  let now = 1000, writes = 0, failPreview = false;
  t.mock.method(Date, 'now', () => now);
  const rewind = checkpointControl(() => ({ rewindFiles: async (_, options) => {
    if (options?.dryRun && failPreview) throw new Error('transport closed');
    if (!options?.dryRun) writes++;
    return { canRewind: true, filesChanged: [file] };
  } }), () => false);
  try {
    let preview = await rewind({ checkpoint, preview: true });
    now += 120001;
    await assert.rejects(rewind({ checkpoint, token: preview.token }), /预览/);
    preview = await rewind({ checkpoint, preview: true });
    fs.writeFileSync(file, 'new concurrent file');
    await assert.rejects(rewind({ checkpoint, token: preview.token }), /变化/);
    preview = await rewind({ checkpoint, preview: true });
    fs.renameSync(file, file + '.old'); fs.writeFileSync(file, 'new concurrent file');
    await assert.rejects(rewind({ checkpoint, token: preview.token }), /变化/);
    preview = await rewind({ checkpoint, preview: true });
    failPreview = true;
    await assert.rejects(rewind({ checkpoint, preview: true }), /transport closed/);
    await assert.rejects(rewind({ checkpoint, token: preview.token }), /预览/);
    const oldSDK = checkpointControl(() => ({}), () => false);
    await assert.rejects(oldSDK({ checkpoint, preview: true }), /版本不支持/);
    assert.equal(writes, 0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
