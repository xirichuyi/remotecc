const historyRequests = new Map();
const historyLoadErrors = new Map();
let discoveryRequest = null;
let discoveryHost = null;

window.refreshRemoteHistory = config => {
  const hostKey = config.host + ':' + (config.port || '');
  if (discoveryRequest) return discoveryHost === hostKey ? discoveryRequest : discoveryRequest.then(() => window.refreshRemoteHistory(config));
  discoveryHost = hostKey;
  const target = { ...config };
  const status = $('#history-status');
  status.textContent = '读取远端会话…';
  $('#refresh-history').disabled = true;
  discoveryRequest = (async () => {
    let offset = 0;
    let count = 0;
    let unreadable = 0;
    do {
      const result = await api.discoverHistory(target, offset);
      for (const item of result.sessions) {
        const index = sessions.findIndex(session => session.id === item.id);
        if (index < 0) sessions.push(item); else sessions[index] = item;
      }
      count += result.sessions.length;
      unreadable += result.unreadable;
      renderList();
      status.textContent = `${target.host} · ${count} / ${result.total} 条`;
      offset = result.nextOffset;
    } while (offset !== null);
    status.textContent = `${target.host} · ${count} 条远端会话` + (unreadable ? ` · ${unreadable} 条不可读` : '');
  })().catch(error => { status.textContent = '历史读取失败'; showError(error); })
    .finally(() => { discoveryRequest = null; $('#refresh-history').disabled = false; });
  return discoveryRequest;
};
$('#refresh-history').onclick = () => {
  if (window.workspaceState !== 'connected') return showError(new Error('请先连接 SSH'));
  void window.refreshRemoteHistory(connectionConfig());
};
window.renderHistoryNotice = session => {
  const notice = $('#history-notice'); notice.replaceChildren();
  notice.hidden = !session?.remoteHistoryRef;
  if (notice.hidden) return;
  if (session.historyLoaded === false) {
    notice.append(document.createTextNode(historyLoadErrors.get(session.id) || (historyRequests.has(session.id) ? '正在加载远端消息…' : '消息尚未加载')));
    const retry = document.createElement('button'); retry.textContent = '加载消息'; retry.disabled = historyRequests.has(session.id);
    retry.onclick = () => window.openHistory(session.id); notice.append(retry);
  } else {
    const label = document.createElement('span'); label.textContent = '远端历史 · 图片原始数据和超长内容未下载'; notice.append(label);
    if (session.historyBefore) {
      const older = document.createElement('button'); older.textContent = historyRequests.has(session.id) ? '读取中…' : '加载更早消息'; older.disabled = historyRequests.has(session.id) || busyStates.has(session.status);
      older.onclick = () => window.openHistory(session.id, true); notice.append(older);
    }
    if (historyLoadErrors.has(session.id)) notice.append(document.createTextNode(historyLoadErrors.get(session.id)));
  }
};
window.openHistory = async (id, older = false) => {
  if (historyRequests.has(id)) return historyRequests.get(id);
  historyLoadErrors.delete(id);
  const scroll = $('#scroll-area');
  const previousHeight = scroll.scrollHeight, previousTop = scroll.scrollTop;
  const task = api.loadHistory(id, older).then(session => {
    const index = sessions.findIndex(item => item.id === id);
    if (index >= 0) sessions[index] = session;
    if (activeId !== id) return;
    updateUI();
    if (!older) { window.workspaceChanged(); window.controlsChanged(); }
    requestAnimationFrame(() => { scroll.scrollTop = older ? previousTop + scroll.scrollHeight - previousHeight : scroll.scrollHeight; });
  }).catch(error => { historyLoadErrors.set(id, error.message); })
    .finally(() => { historyRequests.delete(id); if (activeId === id) window.renderHistoryNotice(activeSession()); });
  historyRequests.set(id, task);
  if (activeId === id) window.renderHistoryNotice(activeSession());
  return task;
};
