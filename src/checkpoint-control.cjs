const fs = require('node:fs');
function fileStamp(files) {
  return JSON.stringify(files.map(file => {
    try { const stat = fs.lstatSync(file, { bigint: true }); return [file, String(stat.ino), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)]; }
    catch (error) { if (error.code === 'ENOENT') return [file, null]; throw error; }
  }));
}

function checkpointControl(query, busy) {
  let rewindPreview;
  return async (value = {}) => {
        if (busy()) throw new Error('请先停止正在运行的任务');
        if (typeof value.checkpoint !== 'string' || !/^[a-f0-9-]{36}$/i.test(value.checkpoint)) throw new Error('无效检查点');
        if (typeof query()?.rewindFiles !== 'function') throw new Error('当前远端版本不支持文件回退');
        if (value.preview === true) {
          rewindPreview = null; // A failed replacement preview must invalidate the old confirmation.
          const result = await query().rewindFiles(value.checkpoint, { dryRun: true });
          const token = require('node:crypto').randomUUID();
          rewindPreview = { checkpoint: value.checkpoint, token, files: result.filesChanged || [], stamp: fileStamp(result.filesChanged || []), at: Date.now(), canRewind: result.canRewind };
          return { ...result, token };
        }
        if (!rewindPreview || !rewindPreview.canRewind || value.token !== rewindPreview.token || value.checkpoint !== rewindPreview.checkpoint || Date.now() - rewindPreview.at > 120000) throw new Error('请重新预览文件回退');
        if (fileStamp(rewindPreview.files) !== rewindPreview.stamp) { rewindPreview = null; throw new Error('文件在预览后发生变化，请重新预览'); }
        rewindPreview = null;
        return query().rewindFiles(value.checkpoint);

  };
}
module.exports = { checkpointControl };
