const $ = id => document.getElementById(id);
let state = { views: [], approvals: [], connected: false }, threads = [], current = null, stream, cursor = null;
let approvalSignature = '', updating = false, stateTimer, toastTimer, pending = false, accessing = false, reading = false;
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const labels = { idle: '等待输入', inProgress: '正在进行', completed: '已完成', interrupted: '已停止', failed: '执行失败', disconnected: '后端断开' };
const currentView = () => state.views.find(v => v.threadId === current);
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4000); }
async function api(url, data) {
  const response = await fetch(url, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (response.status === 401 && url !== '/api/login') unpair();
  if (!response.ok) throw new Error(result.error || `请求失败 (${response.status})`);
  return result;
}
function unpair() { stream?.close(); $('pairing').hidden = false; $('workspace').hidden = true; }
async function connect() {
  state = await api('/api/state'); $('pairing').hidden = true; $('workspace').hidden = false;
  $('cwd').value = state.workspace; $('demo-banner').hidden = !state.demo;
  stream?.close(); stream = new EventSource('/api/events');
  stream.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === 'snapshot') { state = message.params; render(); return; }
    if (!stateTimer) stateTimer = setTimeout(async () => { stateTimer = null; try { state = await api('/api/state'); render(); } catch (error) { toast(error.message); } }, 120);
  };
  stream.onopen = () => { $('connection').textContent = state.connected ? '已连接 · 实时同步' : 'Codex 后端断开'; $('connection').classList.toggle('offline', !state.connected); };
  stream.onerror = () => { $('connection').textContent = '连接中断 · 正在重连'; $('connection').classList.add('offline'); $('send').disabled = true; $('interrupt').disabled = true; };
  render(); await loadThreads();
}
async function loadThreads(more = false) {
  try {
    const result = await api('/api/threads' + (more && cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''));
    threads = more ? [...threads, ...result.data] : result.data; cursor = result.nextCursor; renderTasks();
  } catch (error) { toast(error.message); }
}
function renderTasks() {
  $('tasks').replaceChildren();
  if (!threads.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = '还没有任务。开始你的第一项工作。'; $('tasks').append(empty); }
  for (const thread of threads) {
    const button = document.createElement('button'); button.className = `task-link${thread.id === current ? ' active' : ''}`;
    button.innerHTML = `<strong>${escape(thread.name || thread.preview || '新任务')}</strong><small>${escape(thread.cwd || thread.id)}</small>`;
    button.onclick = () => selectThread(thread); $('tasks').append(button);
  }
  $('more-tasks').hidden = !cursor;
}
async function selectThread(thread) {
  if (updating) return; updating = true;
  try {
    if (!state.views.some(v => v.threadId === thread.id && !v.readOnly)) {
      const result = await api('/api/open', { threadId: thread.id }); state = await api('/api/state');
      if (result.historyCursor) toast('已载入最近 30 轮历史；更早记录保留在 Codex 中。');
    }
    current = thread.id; approvalSignature = ''; $('access-error').textContent = ''; $('welcome').hidden = true; $('task-view').hidden = false;
    $('sidebar').classList.remove('open'); $('scrim').hidden = true; render();
  } catch (error) { toast(error.message); } finally { updating = false; }
}
function itemText(item) {
  if (item.type === 'userMessage') return (item.content || []).map(c => c.text || (c.type === 'image' ? '[图片]' : '')).join('\n');
  if (['agentMessage', 'plan'].includes(item.type)) return item.text || '';
  return '';
}
function renderTimeline(view) {
  const nearBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 240;
  const open = new Set([...$('timeline').querySelectorAll('details[open]')].map(e => e.dataset.id));
  const fragment = document.createDocumentFragment();
  for (const item of view.items) {
    if (item.type === 'reasoning') continue;
    if (['userMessage', 'agentMessage', 'plan'].includes(item.type)) {
      const article = document.createElement('article'); article.className = `message${item.type === 'userMessage' ? ' user' : ''}`;
      article.innerHTML = `<div class="message-label">${item.type === 'userMessage' ? 'YOU' : item.type === 'plan' ? 'PLAN' : 'CODEX'}</div><div class="message-body"></div>`;
      article.lastChild.textContent = itemText(item); fragment.append(article);
    } else {
      const details = document.createElement('details'); details.className = 'tool'; details.dataset.id = item.id; details.open = open.has(item.id);
      const summary = document.createElement('summary');
      const status = { inProgress: '进行中', completed: '已完成', failed: '失败', declined: '已拒绝' }[item.status] || item.status || '';
      summary.textContent = `${item.type === 'commandExecution' ? item.command || '运行命令' : item.type === 'fileChange' ? '文件改动' : item.type === 'mcpToolCall' ? `${item.server || ''} / ${item.tool || '工具调用'}` : item.type} ${status ? ` · ${status}` : ''}`;
      const pre = document.createElement('pre'); pre.textContent = item.aggregatedOutput || (item.changes ? item.changes.map(c => `${c.path}\n${c.diff || ''}`).join('\n\n') : JSON.stringify(item, null, 2));
      details.append(summary, pre); fragment.append(details);
    }
  }
  if (!fragment.childNodes.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = '任务已就绪。在下方告诉 Codex 你想完成什么。'; fragment.append(p); }
  const before = $('timeline').innerText;
  // Don't replace identical content: preserve selection and expanded outputs while idle.
  const wrapper = document.createElement('div'); wrapper.append(fragment);
  const changed = wrapper.innerHTML !== $('timeline').innerHTML;
  if (changed) $('timeline').replaceChildren(...wrapper.childNodes);
  if (changed && before) {
    if (nearBottom && document.activeElement.tagName !== 'TEXTAREA' && document.activeElement.tagName !== 'INPUT') window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
    else $('jump').hidden = false;
  }
}
function renderApprovals() {
  const requests = state.approvals.filter(r => r.params.threadId === current || !r.params.threadId);
  const signature = JSON.stringify(requests); if (signature === approvalSignature) return; approvalSignature = signature;
  $('approvals').replaceChildren();
  for (const request of requests) {
    const article = document.createElement('article'); article.className = 'approval'; const p = request.params;
    const userInput = request.method.endsWith('/requestUserInput');
    const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'].includes(request.method);
    const title = userInput ? 'Codex 需要你的回答' : request.method === 'item/fileChange/requestApproval' ? '确认文件修改' : request.method === 'item/permissions/requestApproval' ? '确认权限请求' : supported ? '等待你的批准' : '待处理的工具请求';
    article.innerHTML = `<h2>${title}</h2><p>${escape(p.reason || '请检查以下请求，再决定是否继续。')}</p>`;
    const pre = document.createElement('pre');
    const pendingItem = currentView()?.items.find(i => i.id === p.itemId);
    pre.textContent = p.command || (pendingItem?.changes ? pendingItem.changes.map(c => `${c.path}\n${c.diff || ''}`).join('\n\n') : JSON.stringify(p.permissions || p.networkApprovalContext || p, null, 2));
    if (!userInput) article.append(pre);
    const answers = {};
    if (userInput) for (const q of p.questions || []) {
      const section = document.createElement('div'); section.className = 'question'; const label = document.createElement('label'); label.textContent = q.question;
      const input = document.createElement('input'); input.id = `question-${request.id}-${q.id}`; input.type = q.isSecret ? 'password' : 'text'; input.autocomplete = 'off'; label.htmlFor = input.id;
      input.placeholder = '输入你的回答'; input.oninput = () => answers[q.id] = input.value;
      section.append(label);
      for (const option of q.options || []) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'question-option'; button.textContent = `${option.label}${option.description ? ` · ${option.description}` : ''}`;
        button.onclick = () => { section.querySelectorAll('button').forEach(b => b.classList.remove('selected')); button.classList.add('selected'); input.value = option.label; answers[q.id] = option.label; }; section.append(button);
      }
      section.append(input); article.append(section);
    }
    const actions = document.createElement('div'); actions.className = 'approval-actions';
    const addAction = (label, decision, primary) => {
      const button = document.createElement('button'); button.textContent = label; if (primary) button.className = 'approve';
      button.onclick = async () => {
        const buttons = article.querySelectorAll('button'); buttons.forEach(b => b.disabled = true);
        try { await api('/api/respond', { id: request.id, decision, answers }); toast(userInput ? '回答已发送' : decision === 'accept' ? '已批准本次操作' : '已拒绝'); state = await api('/api/state'); render(); }
        catch (error) { toast(error.message); buttons.forEach(b => b.disabled = false); }
      }; actions.append(button);
    };
    if (userInput) addAction('提交回答', undefined, true);
    else if (supported) { addAction('批准本次', 'accept', true); addAction('拒绝', 'decline'); }
    else if (request.method === 'mcpServer/elicitation/request') addAction('拒绝此请求', 'decline');
    else { const message = document.createElement('p'); message.textContent = '此请求类型暂不支持网页操作。可以停止当前任务。'; article.append(message); }
    article.append(actions); $('approvals').append(article);
  }
}
function render() {
  const follow = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 240;
  const previousContent = $('timeline').textContent + $('approvals').textContent;
  $('connection').textContent = state.connected ? '已连接 · 实时同步' : 'Codex 后端断开'; $('connection').classList.toggle('offline', !state.connected);
  $('backend-error').hidden = !state.error; $('backend-error').textContent = state.error || '';
  $('new-task').disabled = !state.connected; $('welcome-new').disabled = !state.connected;
  renderTasks(); const v = currentView(); if (!v) return;
  const thread = threads.find(t => t.id === current); const title = thread?.name || thread?.preview || '新任务';
  $('task-title').textContent = title.length > 70 ? title.slice(0, 70) + '…' : title; $('breadcrumb').textContent = title;
  $('task-path').textContent = thread?.cwd || ''; $('task-error').textContent = v.error || '';
  const waiting = state.approvals.some(r => r.params.threadId === current);
  $('task-status').textContent = v.readOnly ? '只读历史' : waiting ? '等待你处理' : labels[v.status] || v.status;
  $('task-status').className = `status${waiting ? ' waiting' : v.activeTurnId ? ' busy' : ''}`;
  $('readonly-banner').hidden = !v.readOnly;
  $('readonly-title').textContent = v.occupied ? '原客户端正在使用此会话' : '只读查看历史';
  $('readonly-description').textContent = v.occupied ? '你仍可查看已保存的历史。退出原客户端的会话后重试，或复制历史到新会话继续；副本仍使用同一项目文件夹。' : '不会占用原会话。历史每 8 秒刷新，可能落后于原客户端的实时输出。复制会话会保留历史，仍使用同一项目文件夹。';
  $('resume-task').textContent = v.occupied ? '重试接管' : '接管并继续';
  $('resume-task').disabled = $('fork-task').disabled = accessing || !state.connected;
  $('interrupt').hidden = v.readOnly || !v.activeTurnId; $('interrupt').disabled = !state.connected;
  $('message').disabled = !!v.readOnly;
  $('send').disabled = v.readOnly || pending || !state.connected;
  $('message').placeholder = v.readOnly ? '当前为只读。接管或复制为新会话后即可发送消息。' : v.activeTurnId ? '任务正在进行，可以继续补充要求…' : '描述任务，或补充一个想法…';
  $('plan').hidden = !v.plan?.length;
  $('plan').innerHTML = `<div class="plan-title">当前计划</div>${(v.plan || []).map(p => `<div class="plan-step"><span>${p.status === 'completed' ? '✓' : p.status === 'inProgress' ? '◉' : '○'}</span>${escape(p.step)}</div>`).join('')}`;
  $('diff').textContent = v.diff || '暂无代码改动。'; $('diff-count').textContent = String((v.diff.match(/^diff --git /gm) || []).length);
  renderTimeline(v); renderApprovals();
  if (follow && previousContent !== $('timeline').textContent + $('approvals').textContent && !['TEXTAREA', 'INPUT'].includes(document.activeElement.tagName)) requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
}
function openNew() { $('create-error').textContent = ''; $('new-dialog').showModal(); }
$('login-form').onsubmit = async event => { event.preventDefault(); const button = event.submitter; button.disabled = true; $('login-error').textContent = ''; try { await api('/api/login', { token: $('token').value.trim() }); $('token').value = ''; await connect(); } catch (error) { $('login-error').textContent = error.message; } finally { button.disabled = false; } };
$('new-task').onclick = openNew; $('welcome-new').onclick = openNew; $('close-dialog').onclick = () => $('new-dialog').close();
$('create-form').onsubmit = async event => { event.preventDefault(); const button = event.submitter; button.disabled = true; $('create-error').textContent = ''; try { const result = await api('/api/threads', { cwd: $('cwd').value }); threads.unshift(result.thread); state = await api('/api/state'); $('new-dialog').close(); await selectThread(result.thread); $('message').focus(); } catch (error) { $('create-error').textContent = error.message; } finally { button.disabled = false; } };
$('message-form').onsubmit = async event => {
  event.preventDefault(); const message = $('message').value.trim(); if (!message || pending || !current || currentView()?.readOnly || !state.connected) return;
  pending = true; $('send').disabled = true;
  try { await api('/api/turn', { threadId: current, text: message }); $('message').value = ''; toast('消息已发送'); state = await api('/api/state'); render(); await loadThreads(); }
  catch (error) { toast(error.message); } finally { pending = false; $('send').disabled = currentView()?.readOnly || !state.connected; }
};
async function accessTask(action) {
  if (accessing || !current) return;
  accessing = true; const id = current; $('access-error').textContent = ''; render();
  try {
    const result = await api(`/api/${action}`, { threadId: id });
    state = await api('/api/state');
    if (action === 'fork') { threads.unshift(result.thread); await selectThread(result.thread); toast('已复制历史到新会话；仍使用原项目文件夹。'); }
    else toast('已接管，可以继续发送消息。');
  } catch (error) {
    if (current === id) $('access-error').textContent = error.message;
    try { state = await api('/api/state'); } catch { /* Preserve the visible error. */ }
  } finally { accessing = false; render(); }
}
$('resume-task').onclick = () => accessTask('resume'); $('fork-task').onclick = () => accessTask('fork');
setInterval(async () => {
  if (document.hidden || reading || updating || accessing || !currentView()?.readOnly || !state.connected) return;
  reading = true; const id = current;
  try { await api('/api/open', { threadId: id }); const next = await api('/api/state'); if (current === id) { state = next; render(); } }
  catch (error) { if (current === id) $('access-error').textContent = `历史刷新失败：${error.message}`; }
  finally { reading = false; }
}, 8000);
$('message').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !matchMedia('(max-width:700px)').matches) { event.preventDefault(); $('message-form').requestSubmit(); } };
$('interrupt').onclick = async () => { $('interrupt').disabled = true; try { await api('/api/interrupt', { threadId: current }); toast('已请求停止'); } catch (error) { toast(error.message); } finally { $('interrupt').disabled = false; } };
$('refresh').onclick = () => loadThreads(); $('more-tasks').onclick = () => loadThreads(true);
$('logout').onclick = async () => { try { await api('/api/logout', {}); } finally { current = null; state = { views: [], approvals: [] }; unpair(); } };
$('menu').onclick = () => { $('sidebar').classList.add('open'); $('scrim').hidden = false; };
$('scrim').onclick = () => { $('sidebar').classList.remove('open'); $('scrim').hidden = true; };
for (const name of ['chat', 'diff']) $(`tab-${name}`).onclick = () => { for (const tab of ['chat', 'diff']) { $(`tab-${tab}`).classList.toggle('active', tab === name); $(`tab-${tab}`).setAttribute('aria-selected', String(tab === name)); $(`${tab}-panel`).hidden = tab !== name; } };
$('jump').onclick = () => { window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' }); $('jump').hidden = true; };
document.addEventListener('keydown', event => { if (event.key === 'Escape') { $('sidebar').classList.remove('open'); $('scrim').hidden = true; } });
api('/api/state').then(connect).catch(() => {});
