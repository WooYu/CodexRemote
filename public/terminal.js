import { Terminal } from '/vendor/xterm.mjs';
import { FitAddon } from '/vendor/fit.mjs';
const $ = id => document.getElementById(id);
const terminal = new Terminal({ cursorBlink: true, scrollback: 3000, fontSize: matchMedia('(max-width:700px)').matches ? 12 : 14, fontFamily: 'Consolas, "Cascadia Mono", monospace', theme: { background: '#152019', foreground: '#d9e5d1', cursor: '#d8edb7', selectionBackground: '#52664a99', black: '#152019', green: '#abd087', brightGreen: '#d4eeaf' }, allowProposedApi: true, screenReaderMode: true });
const fit = new FitAddon(); terminal.loadAddon(fit);
let current, sessions = [], stream, opened = false, online = false, sending = false, inputQueue = Promise.resolve(), resizeTimer, toastTimer, sequence = 0;
let historyThreads = [], historyCursor = null, historyVersion = 0, selectedHistory = null, historyTurns = [], olderCursor = null, previewVersion = 0;
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4000); }
let occupied = false, unreadOutput = false, listing = false;
function scrollFeedback() {
  const buffer = terminal.buffer.active;
  const reading = buffer.viewportY < buffer.baseY;
  if (!reading) unreadOutput = false;
  $('scroll-bottom').textContent = reading ? (unreadOutput ? '有新输出 · 回到底部 ↓' : '正在查看历史 · 回到底部 ↓') : '回到底部 ↓';
}
terminal.onScroll(scrollFeedback);
function storageGet(key) { try { return localStorage.getItem(key) || ''; } catch { return ''; } }
function saveDraft(id = current, text = $('message').value) {
  if (!id) return;
  try { if (text) localStorage.setItem(`codex-draft:${id}`, text); else localStorage.removeItem(`codex-draft:${id}`); } catch { /* Storage may be unavailable. */ }
}
function inspectScreen() {
  const buffer = terminal.buffer.active;
  const lines = [];
  for (let i = buffer.baseY; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) || '');
  const screen = lines.join(' ').replace(/\s+/g, ' ');
  occupied = /This conversation is open in another app/i.test(screen) && /retry/i.test(screen);
  $('session-notice').hidden = !occupied;
  $('session-notice-text').textContent = occupied ? '这段对话仍在其他客户端中打开。先退出电脑端该会话，再点击重试。草稿会保留。' : '';
  controls();
}
function unpair() { saveDraft(); online = false; stream?.close(); $('workspace').hidden = true; $('pairing').hidden = false; }
async function api(url, data) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(20000), ...(data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }) });
  } catch (error) { throw new Error(error.name === 'TimeoutError' ? '请求超时，请检查网络' : '网络连接失败，请检查网络'); }
  if (response.status === 401 && url !== '/api/login') unpair();
  let result;
  try { result = await response.json(); } catch { throw new Error(`服务暂时不可用（HTTP ${response.status}），请稍后重试`); }
  if (!response.ok) throw new Error(result.error || '请求失败'); return result;
}
async function list() {
  if (listing) return;
  listing = true;
  try {
    const result = await api('/api/terminals');
    sessions = result.sessions.map(info => { const previous = sessions.find(s => s.id === info.id); return previous ? Object.assign(previous, info) : info; });
    $('cwd').value ||= result.workspace; renderList();
    if (current && !sessions.some(s => s.id === current)) {
      online = false; stream?.close();
      $('terminal-error').textContent = '这个终端已在其他设备关闭。草稿仍保留，请选择其他会话。';
    }
    if (current) controls();
  } finally { listing = false; }
}
function renderList() {
  $('connect-running').hidden = !sessions.some(s => s.status === 'running');
  $('sessions').replaceChildren();
  for (const session of sessions) {
    const button = document.createElement('button'); button.className = `task-link${session.id === current ? ' active' : ''}`;
    button.innerHTML = `<strong>${escape(session.name)} · ${session.status === 'running' ? '连接此终端' : '已退出'}</strong><small>${escape(session.cwd)}</small>`; button.onclick = () => attach(session); $('sessions').append(button);
  }
  if (!sessions.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = '还没有终端会话。'; $('sessions').append(empty); }
}
async function loadHistory(more = false) {
  const version = ++historyVersion; $('history-error').textContent = ''; $('history-more').disabled = true;
  try {
    const query = new URLSearchParams(); const search = $('history-search').value.trim(); if (search) query.set('search', search);
    if (more && historyCursor) query.set('cursor', historyCursor);
    const result = await api(`/api/history?${query}`); if (version !== historyVersion) return;
    historyThreads = more ? [...new Map([...historyThreads, ...result.data].map(t => [t.id, t])).values()] : result.data;
    historyCursor = result.nextCursor; renderHistory();
  } catch (error) { if (version === historyVersion) $('history-error').textContent = `历史任务加载失败：${error.message}`; }
  finally { if (version === historyVersion) $('history-more').disabled = false; }
}
function renderHistory() {
  $('history-list').replaceChildren();
  for (const thread of historyThreads) {
    const button = document.createElement('button'); button.className = 'task-link history-link';
    button.innerHTML = `<strong>${escape(thread.name || thread.preview || '未命名任务')}</strong><small>${escape(thread.cwd || '')}</small>`;
    button.onclick = () => previewHistory(thread); $('history-list').append(button);
  }
  if (!historyThreads.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = $('history-search').value.trim() ? '没有匹配的历史任务。' : '暂无保存的历史任务。'; $('history-list').append(empty); }
  $('history-more').hidden = !historyCursor;
}
function renderHistoryContent() {
  $('history-content').replaceChildren();
  for (const turn of historyTurns) for (const item of turn.items || []) {
    if (item.type === 'reasoning') continue;
    const article = document.createElement('article'); article.className = 'history-message';
    if (['agentMessage', 'userMessage', 'plan'].includes(item.type)) {
      const label = document.createElement('strong'); label.textContent = item.type === 'userMessage' ? 'YOU' : 'CODEX';
      const content = document.createElement('div'); content.className = 'message-body';
      content.textContent = item.type === 'userMessage' ? (item.content || []).map(c => c.text || (c.type === 'image' || c.type === 'localImage' ? '[图片]' : '')).join('\n') : item.text || '';
      article.append(label, content);
    } else {
      const details = document.createElement('details'); details.className = 'tool'; const summary = document.createElement('summary');
      summary.textContent = item.type === 'commandExecution' ? item.command || '命令执行' : item.type === 'fileChange' ? '文件修改' : item.tool || item.type;
      const pre = document.createElement('pre'); pre.textContent = item.aggregatedOutput || (item.changes ? item.changes.map(c => `${c.path}\n${c.diff || ''}`).join('\n\n') : JSON.stringify(item, null, 2));
      details.append(summary, pre); article.append(details);
    }
    $('history-content').append(article);
  }
  if (!$('history-content').childNodes.length) $('history-content').textContent = '此会话暂无保存的对话内容。';
  $('history-older').hidden = !olderCursor;
}
async function previewHistory(thread) {
  const version = ++previewVersion; selectedHistory = thread; historyTurns = []; olderCursor = null;
  $('history-title').textContent = thread.name || thread.preview || '历史任务'; $('history-path').textContent = thread.cwd || '';
  $('history-content').textContent = '正在读取保存的对话…'; $('history-read-error').textContent = '';
  $('resume-history').disabled = true; $('history-older').hidden = true;
  if (!$('history-dialog').open) $('history-dialog').showModal();
  try {
    const result = await api('/api/history/read', { threadId: thread.id }); if (version !== previewVersion) return;
    selectedHistory = result.thread; historyTurns = result.turns; olderCursor = result.nextCursor;
    $('history-path').textContent = selectedHistory.cwd || ''; renderHistoryContent(); $('resume-history').disabled = false;
  } catch (error) { if (version === previewVersion) { $('history-read-error').textContent = error.message; $('history-content').textContent = ''; } }
}
function controls() {
  const running = sessions.find(s => s.id === current)?.status === 'running';
  $('send').disabled = !online || !running || sending || occupied; $('message').disabled = !running;
  $('send').textContent = sending ? '正在发送…' : '发送 ↑';
  $('retry-session').disabled = !online || !running;
  $('message').placeholder = occupied ? '先退出电脑端会话，再点击重试；草稿会保留' : !online ? '连接恢复后可发送，草稿会保留…' : '输入需求；审批请使用上方快捷键…';
  document.querySelectorAll('[data-key]').forEach(button => button.disabled = !online || !running);
  $('session-status').textContent = !online ? '连接中断' : occupied ? '会话被占用' : running ? 'CLI 已连接' : '终端已退出';
}
function dimensions() {
  const size = fit.proposeDimensions();
  return { cols: Math.min(300, Math.max(20, size?.cols || 100)), rows: Math.min(100, Math.max(8, size?.rows || 30)) };
}
async function resize() {
  if (!opened || !online || !current) return;
  const size = dimensions(); terminal.resize(size.cols, size.rows);
  try { await api(`/api/terminals/${current}/resize`, size); } catch (error) { $('terminal-error').textContent = error.message; }
}
async function connect() {
  await list(); $('pairing').hidden = true; $('workspace').hidden = false;
  $('connection').textContent = '服务已连接'; $('connection').classList.remove('offline');
  const remembered = localStorage.getItem('codex-terminal-session'); const session = sessions.find(s => s.id === remembered);
  if (session) attach(session);

  loadHistory();
}
function attach(session) {
  if (sending) { toast('正在发送，请稍后切换会话'); return; }
  saveDraft(); occupied = false; $('session-notice').hidden = true;
  const version = ++sequence; stream?.close(); current = session.id; online = false; unreadOutput = false;
  localStorage.setItem('codex-terminal-session', current); $('message').value = storageGet(`codex-draft:${current}`); $('send-feedback').textContent = '电脑和手机共享同一终端；草稿仅保存在当前浏览器。'; $('empty').hidden = true; $('terminal-panel').hidden = false;
  $('session-title').textContent = session.name; $('session-path').textContent = session.cwd; $('terminal-error').textContent = '';
  $('sidebar').classList.remove('open'); $('scrim').hidden = true;
  if (!opened) { terminal.open($('terminal')); opened = true; }
  terminal.reset(); terminal.resize(session.cols, session.rows); renderList(); controls();
  stream = new EventSource(`/api/terminals/${current}/events`);
  stream.onmessage = event => {
    if (sequence !== version) return;
    const message = JSON.parse(event.data);
    if (message.type === 'snapshot') {
      Object.assign(session, message); online = true; terminal.reset(); terminal.resize(message.cols, message.rows);
      terminal.write(message.data, () => { if (sequence === version) { inspectScreen(); scrollFeedback(); resize(); } });
      $('connection').textContent = '已连接 · 终端同步'; $('connection').classList.remove('offline'); $('send-feedback').textContent = '终端已同步；可继续输入，审批请使用快捷键。'; controls();
    } else if (message.type === 'output') {
      if (terminal.buffer.active.viewportY < terminal.buffer.active.baseY) unreadOutput = true;
      terminal.write(message.data, () => { if (sequence === version) { inspectScreen(); scrollFeedback(); } });
    }
    else if (message.type === 'resize') { session.cols = message.cols; session.rows = message.rows; terminal.resize(message.cols, message.rows); }
    else if (message.type === 'exit') { session.status = 'exited'; $('terminal-error').textContent = `CLI 已退出${message.exitCode === null ? '' : `（退出码 ${message.exitCode}）`}。可以新建会话或恢复保存的历史。`; controls(); renderList(); }
  };
  stream.onerror = async () => {
    if (sequence !== version) return; online = false; saveDraft(); controls(); $('send-feedback').textContent = '连接中断，正在重连。草稿已保留，任务仍在服务端运行。'; $('connection').textContent = '正在重连 · 任务仍在服务端'; $('connection').classList.add('offline');
    try { await api('/api/state'); } catch { /* Authentication failure closes EventSource via unpair. */ }
  };
}
function input(action, data) {
  if (!online || !current) return Promise.reject(new Error('终端未连接'));
  const id = current;
  inputQueue = inputQueue.catch(() => {}).then(() => api(`/api/terminals/${id}/${action}`, data));
  return inputQueue;
}
terminal.onData(data => { if (online) input('input', { data }).catch(error => $('terminal-error').textContent = error.message); });
terminal.attachCustomKeyEventHandler(event => {
  if (event.type === 'keydown' && event.ctrlKey && event.key.toLowerCase() === 'c' && terminal.hasSelection()) { navigator.clipboard?.writeText(terminal.getSelection()).catch(() => {}); return false; }
  return true;
});
new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(resize, 180); }).observe($('terminal'));
if (window.visualViewport) window.visualViewport.addEventListener('resize', () => { $('workspace').style.height = `${window.visualViewport.height}px`; clearTimeout(resizeTimer); resizeTimer = setTimeout(resize, 180); });
$('login-form').onsubmit = async event => { event.preventDefault(); const button = event.submitter; button.disabled = true; $('login-error').textContent = ''; try { await api('/api/login', { token: $('token').value.trim() }); $('token').value = ''; await connect(); } catch (error) { $('login-error').textContent = error.message; } finally { button.disabled = false; } };
$('connect-running').onclick = () => {
  const running = sessions.filter(s => s.status === 'running');
  if (running.length === 1) attach(running[0]);
  else { $('sidebar').classList.add('open'); $('scrim').hidden = false; toast('请选择要连接的终端'); }
};
function openNew() { $('create-error').textContent = ''; $('new-dialog').showModal(); }
$('new-session').onclick = openNew; $('start-session').onclick = openNew; $('close-dialog').onclick = () => $('new-dialog').close();
$('create-form').onsubmit = async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true; $('create-error').textContent = '';
  try { const result = await api('/api/terminals', { cwd: $('cwd').value, resumeId: $('resume-id').value.trim() || undefined }); await list(); $('new-dialog').close(); attach(sessions.find(s => s.id === result.session.id)); }
  catch (error) { $('create-error').textContent = error.message; } finally { button.disabled = false; }
};
$('message').addEventListener('input', () => saveDraft());
window.addEventListener('pagehide', () => saveDraft());
$('retry-session').onclick = async () => {
  try { await input('input', { data: 'r' }); $('send-feedback').textContent = '已发送重试，请等待终端恢复。'; }
  catch (error) { $('terminal-error').textContent = error.message; }
};
$('message-form').onsubmit = async event => {
  event.preventDefault(); if (sending || occupied || !online || !$('message').value.trim()) return;
  const id = current, text = $('message').value; saveDraft(id, text); sending = true; controls(); $('terminal-error').textContent = '';
  $('send-feedback').textContent = '正在送入终端…';
  try {
    await input('message', { text });
    if (current === id) {
      if ($('message').value === text) { $('message').value = ''; saveDraft(id, ''); }
      $('send-feedback').textContent = '已送入终端并按 Enter，请查看上方输出确认响应。';
    }
  } catch (error) {
    $('terminal-error').textContent = `${error.message}。消息可能已送达，请先检查终端，避免重复发送。`;
    $('send-feedback').textContent = '发送结果未确认，草稿已保留。';
  } finally { sending = false; controls(); }
};
document.querySelectorAll('[data-key]').forEach(button => button.onclick = () => input('key', { key: button.dataset.key }).catch(error => $('terminal-error').textContent = error.message));
// Scroll locally: swipes never become CLI mouse/key input or approvals.
let touchScroll = null;
const terminalHost = $('terminal');
terminalHost.addEventListener('touchstart', event => {
  if (event.touches.length !== 1) { touchScroll = null; return; }
  const touch = event.touches[0];
  touchScroll = { x: touch.clientX, y: touch.clientY, lastY: touch.clientY, remainder: 0, active: false };
}, { passive: true, capture: true });
terminalHost.addEventListener('touchmove', event => {
  if (!touchScroll || event.touches.length !== 1) return;
  const touch = event.touches[0];
  if (!touchScroll.active) {
    const dy = touch.clientY - touchScroll.y, dx = touch.clientX - touchScroll.x;
    if (Math.abs(dy) < 8 || Math.abs(dy) <= Math.abs(dx)) return;
    touchScroll.active = true;
  }
  event.preventDefault(); event.stopImmediatePropagation();
  const screen = terminalHost.querySelector('.xterm-screen');
  const lineHeight = (screen?.getBoundingClientRect().height || terminalHost.clientHeight) / terminal.rows;
  touchScroll.remainder += (touchScroll.lastY - touch.clientY) / Math.max(1, lineHeight);
  const lines = Math.trunc(touchScroll.remainder);
  if (lines) { terminal.scrollLines(lines); touchScroll.remainder -= lines; }
  touchScroll.lastY = touch.clientY;
}, { passive: false, capture: true });
for (const type of ['touchend', 'touchcancel']) terminalHost.addEventListener(type, () => { touchScroll = null; }, { passive: true, capture: true });
$('scroll-up').onclick = () => terminal.scrollPages(-1);
$('scroll-down').onclick = () => terminal.scrollPages(1);
$('focus-terminal').onclick = () => terminal.focus(); $('scroll-bottom').onclick = () => terminal.scrollToBottom();
$('close-session').onclick = () => $('close-confirm').showModal();
$('close-confirm').onclose = async () => {
  if ($('close-confirm').returnValue !== 'close' || !current) return;
  saveDraft();
  try { await api(`/api/terminals/${current}/close`, {}); ++sequence; stream?.close(); current = null; online = false; localStorage.removeItem('codex-terminal-session'); $('terminal-panel').hidden = true; $('empty').hidden = false; await list(); }
  catch (error) { toast(error.message); }
};
$('refresh').onclick = () => list().catch(error => toast(error.message));
$('refresh-history').onclick = () => loadHistory();
$('history-search-form').onsubmit = event => { event.preventDefault(); loadHistory(); };
$('history-more').onclick = () => loadHistory(true);
$('close-history').onclick = () => $('history-dialog').close();
$('history-dialog').addEventListener('close', () => { ++previewVersion; });
$('history-older').onclick = async () => {
  if (!selectedHistory || !olderCursor) return;
  const version = previewVersion; $('history-older').disabled = true;
  try { const result = await api('/api/history/read', { threadId: selectedHistory.id, cursor: olderCursor }); if (version !== previewVersion) return; historyTurns = [...result.turns, ...historyTurns]; olderCursor = result.nextCursor; renderHistoryContent(); }
  catch (error) { if (version === previewVersion) $('history-read-error').textContent = error.message; }
  finally { $('history-older').disabled = false; }
};
$('resume-history').onclick = async () => {
  if (!selectedHistory) return; $('resume-history').disabled = true; $('history-read-error').textContent = '';
  try {
    const id = selectedHistory.id; const existing = sessions.find(s => s.id === localStorage.getItem(`codex-history-terminal:${id}`) && s.status === 'running');
    let session = existing;
    if (!session) { const result = await api('/api/terminals', { cwd: selectedHistory.cwd || $('cwd').value, resumeId: id }); localStorage.setItem(`codex-history-terminal:${id}`, result.session.id); await list(); session = sessions.find(s => s.id === result.session.id); }
    $('history-dialog').close(); attach(session); toast('已打开官方 CLI；会话被占用时会显示原生提示。');
  } catch (error) { $('history-read-error').textContent = error.message; }
  finally { $('resume-history').disabled = false; }
};
$('logout').onclick = async () => { try { await api('/api/logout', {}); } finally { unpair(); } };
$('menu').onclick = () => { list().catch(error => toast(error.message)); $('sidebar').classList.add('open'); $('scrim').hidden = false; };
$('scrim').onclick = () => { $('sidebar').classList.remove('open'); $('scrim').hidden = true; };
document.addEventListener('keydown', event => { if (event.key === 'Escape') { $('sidebar').classList.remove('open'); $('scrim').hidden = true; } });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !$('workspace').hidden) list().catch(() => {});
});
setInterval(() => { if (!document.hidden && !$('workspace').hidden) list().catch(() => {}); }, 15000);
api('/api/state').then(connect).catch(() => {});
