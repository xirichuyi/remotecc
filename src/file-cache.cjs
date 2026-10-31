const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
class FileCache {
  constructor(directory) { this.directory = directory; this.limit = 256 * 1024 * 1024; this.pins = new Map(); }
  file(key) { return path.join(this.directory, createHash('sha256').update(key).digest('hex')); }
  async get(key) {
    const file = this.file(key);
    try { await fs.access(file); await fs.utimes(file, new Date(), new Date()); return file; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async put(key, data) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.directory, randomUUID() + '.tmp');
    try { await fs.writeFile(temporary, data, { mode: 0o600 }); await fs.rename(temporary, this.file(key)); }
    finally { await fs.rm(temporary, { force: true }); }
    await this.prune(this.file(key));
    return this.file(key);
  }
  async withLease(key, operation) {
    if (this.pruning) await this.pruning;
    const file = this.file(key);
    this.pins.set(file, (this.pins.get(file) || 0) + 1);
    try { return await operation(); }
    finally {
      const count = this.pins.get(file) - 1;
      if (count) this.pins.set(file, count); else this.pins.delete(file);
    }
  }
  async readJSON(key) {
    return this.withLease(key, async () => {
      const file = await this.get(key);
      if (!file) return null;
      try { return JSON.parse(await fs.readFile(file, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
    });
  }
  prune() {
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pruning = this.sweep().catch(() => {}).finally(() => { this.pruning = null; });
      }, 1000);
      this.timer.unref();
    }
  }
  async sweep() {
    const entries = await Promise.all((await fs.readdir(this.directory)).filter(name => /^[a-f0-9]{64}$/.test(name)).map(async name => {
      const file = path.join(this.directory, name);
      try { return { file, ...await fs.stat(file) }; } catch { return null; }
    }));
    const files = entries.filter(Boolean).sort((a,b) => a.mtimeMs - b.mtimeMs);
    let size = files.reduce((sum,item) => sum + item.size, 0);
    for (const item of files) {
      if (size <= this.limit) break;
      if (this.pins.has(item.file)) continue;
      await fs.rm(item.file, { force: true }); size -= item.size;
    }
  }
}
module.exports = { FileCache };
