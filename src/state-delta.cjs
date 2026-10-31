// A subscriber starts with a full snapshot; subsequent patches require its exact version.
function applyStateDelta(previous, packet) {
  if (!packet.delta) return packet;
  if (!previous || previous.version !== packet.base) throw new Error('远端状态版本不连续，请重新连接');
  const state = structuredClone(previous);
  for (const patch of packet.patches) {
    if (!Array.isArray(patch.path) || !patch.path.length || patch.path.some(key => ['__proto__', 'prototype', 'constructor'].includes(key)))
      throw new Error('无效状态增量');
    let parent = state;
    for (const key of patch.path.slice(0, -1)) parent = parent[key];
    const key = patch.path.at(-1);
    if (patch.remove) delete parent[key];
    else if ('append' in patch) {
      if (typeof parent[key] !== 'string' || typeof patch.append !== 'string') throw new Error('无效文本增量');
      parent[key] += patch.append;
    } else parent[key] = patch.value;
  }
  if (state.version !== packet.version) throw new Error('无效状态版本');
  return state;
}
module.exports = { applyStateDelta };
