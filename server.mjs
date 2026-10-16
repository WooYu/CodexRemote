import http from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { CodexBridge } from './bridge.mjs';
import { DemoBridge } from './demo.mjs';
import { TerminalManager, TERMINAL_KEYS } from './terminal-manager.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const assets = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']]]);
for (const [route, file, type] of [
  ['/terminal', 'terminal.html', 'text/html'], ['/terminal.js', 'terminal.js', 'text/javascript'], ['/terminal.css', 'terminal.css', 'text/css'],
  ['/vendor/xterm.mjs', '../node_modules/@xterm/xterm/lib/xterm.mjs', 'text/javascript'],
  ['/vendor/fit.mjs', '../node_modules/@xterm/addon-fit/lib/addon-fit.mjs', 'text/javascript'],
  ['/vendor/xterm.css', '../node_modules/@xterm/xterm/css/xterm.css', 'text/css'],
]) assets.set(route, [file, type]);
const secureEqual = (a, b) => { if (typeof a !== 'string') return false; const aa = Buffer.from(a); const bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); };
const text = (value, name, max = 20000) => { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name}无效`); return value; };

export async function createServer({ bridge = new CodexBridge(), token = randomBytes(24).toString('hex'), workspace = process.cwd(), demo = false, terminalMode = false, terminals = new TerminalManager(), terminalUpstream } = {}) {
  const upstream = terminalUpstream ? new URL(terminalUpstream) : null;
  if (upstream && (upstream.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(upstream.hostname))) throw new Error('现有终端服务必须是本机 HTTP 地址');
  const clients = new Set(); const sessions = new Map(); const views = new Map(); const managed = new Set(); const sending = new Set();
  let backendError = null;
  let historyStarting;
  async function historyReady() {
    if (bridge.connected) return;
    if (!historyStarting) historyStarting = bridge.start().finally(() => { historyStarting = null; });
    await historyStarting;
  }
  function view(id) {
    if (!views.has(id)) views.set(id, { threadId: id, items: [], plan: [], diff: '', activeTurnId: null, status: 'idle', readOnly: !managed.has(id), occupied: false });
    return views.get(id);
  }
  const snapshot = () => ({ connected: terminalMode || bridge.connected, error: backendError, demo, workspace, terminalMode, views: [...views.values()], approvals: [...bridge.approvals.values()] });
  async function loadHistory(id) {
    let history;
    try { history = await bridge.request('thread/turns/list', { threadId: id, limit: 30, sortDirection: 'desc', itemsView: 'full' }); }
    catch (error) { if (/not materialized|before first user message/.test(error.message)) history = { data: [], nextCursor: null }; else throw error; }
    const turns = [...history.data].reverse(); const v = view(id);
    const items = new Map(turns.flatMap(t => t.items || []).map(i => [i.id, i]));
    if (managed.has(id)) for (const i of v.items) items.set(i.id, i);
    v.items = [...items.values()];
    if (!managed.has(id)) { v.readOnly = true; v.activeTurnId = null; v.status = turns.at(-1)?.status || 'idle'; }
    return { view: v, historyCursor: history.nextCursor };
  }
  function publish(event) {
    const p = event.params || {};
    if (event.method === 'bridge/error') {
      backendError = p.message;
      for (const v of views.values()) { v.status = 'disconnected'; v.activeTurnId = null; }
    }
    if (p.threadId) {
      const v = view(p.threadId);
      if (event.method === 'turn/started') { v.activeTurnId = p.turn.id; v.status = 'inProgress'; v.error = null; v.plan = []; v.diff = ''; }
      if (event.method === 'turn/completed') { v.activeTurnId = null; v.status = p.turn.status; v.error = p.turn.error?.message; }
      if (event.method === 'turn/plan/updated') v.plan = p.plan;
      if (event.method === 'turn/diff/updated') v.diff = p.diff;
      if (event.method === 'item/started' || event.method === 'item/completed') {
        const existing = v.items.find(i => i.id === p.item.id);
        if (existing) Object.assign(existing, p.item); else v.items.push(p.item);
        if (v.items.length > 1500) v.items.splice(0, v.items.length - 1500);
      }
      if (event.method === 'item/agentMessage/delta' || event.method === 'item/commandExecution/outputDelta') {
        let item = v.items.find(i => i.id === p.itemId);
        if (!item) { item = { id: p.itemId, type: event.method.includes('agentMessage') ? 'agentMessage' : 'commandExecution' }; v.items.push(item); }
        const key = item.type === 'agentMessage' ? 'text' : 'aggregatedOutput';
        item[key] = ((item[key] || '') + p.delta).slice(-500000);
      }
    }
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) { if (res.writableLength > 2_000_000) { res.destroy(); clients.delete(res); } else res.write(payload); }
  }
  bridge.on('event', publish);
  if (!terminalMode) try { await bridge.start(); } catch (error) { backendError = error.message; }
  function json(res, code, data) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }
  async function body(req) {
    let buffer = ''; for await (const part of req) { buffer += part; if (buffer.length > 100000) throw new Error('请求过大'); }
    return JSON.parse(buffer || '{}');
  }
  const attempts = new Map();
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self'${terminalMode || req.url === '/terminal' ? " 'unsafe-inline'" : ''}; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return json(res, 403, { error: '不允许跨站访问' });
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const [file, type] = terminalMode && url.pathname === '/' ? ['terminal.html', 'text/html'] : assets.get(url.pathname); res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); return res.end(await readFile(path.join(root, 'public', file)));
      }
      if (req.method === 'POST' && req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res, 415, { error: '需要 JSON 请求' });
      // A UI upgrade can share the existing PTY service without restarting active tasks.
      const historyRoute = ['/api/history', '/api/history/read'].includes(url.pathname);
      if (upstream && url.pathname.startsWith('/api/') && !historyRoute) {
        const headers = { ...req.headers, host: upstream.host }; delete headers.origin;
        const target = new URL(upstream); target.pathname = url.pathname; target.search = url.search;
        const proxy = http.request(target, { method: req.method, headers }, response => {
          res.writeHead(response.statusCode, response.headers); response.pipe(res);
        });
        proxy.on('error', () => { if (!res.headersSent) json(res, 502, { error: '现有终端服务未连接，请保持原服务运行' }); else res.end(); });
        res.on('close', () => proxy.destroy()); req.pipe(proxy); return;
      }
      if (url.pathname === '/api/login' && req.method === 'POST') {
        const ip = req.socket.remoteAddress; const now = Date.now(); const attempt = attempts.get(ip) || { count: 0, since: now };
        if (now - attempt.since > 60000) { attempt.count = 0; attempt.since = now; }
        attempts.set(ip, attempt); if (++attempt.count > 15) return json(res, 429, { error: '尝试过于频繁，请稍后再试' });
        const data = await body(req); if (!secureEqual(data.token, token)) return json(res, 401, { error: '配对码不正确' });
        const id = randomBytes(32).toString('hex'); sessions.set(id, now + 86400000);
        res.setHeader('Set-Cookie', `remote_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${req.socket.encrypted || process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`);
        return json(res, 200, { ok: true });
      }
      const cookie = /(?:^|;\s*)remote_session=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
      let authenticated = cookie && (sessions.get(cookie) || 0) >= Date.now();
      if (upstream && historyRoute) {
        const auth = await fetch(new URL('/api/state', upstream), { headers: { Cookie: req.headers.cookie || '' }, signal: AbortSignal.timeout(5000) });
        authenticated = auth.ok;
      }
      if (!authenticated) return json(res, 401, { error: '请先配对' });
      if (url.pathname === '/api/logout' && req.method === 'POST') {
        sessions.delete(cookie); res.setHeader('Set-Cookie', 'remote_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, snapshot());
      if (url.pathname === '/api/history' && req.method === 'GET') {
        await historyReady();
        const cursor = url.searchParams.get('cursor'); const search = url.searchParams.get('search')?.trim();
        return json(res, 200, await bridge.request('thread/list', { limit: 30, ...(cursor ? { cursor: text(cursor, '分页游标', 4000) } : {}), ...(search ? { searchTerm: text(search, '搜索词', 200) } : {}) }));
      }
      if (url.pathname === '/api/history/read' && req.method === 'POST') {
        const data = await body(req); const threadId = text(data.threadId, '历史会话 ID', 200); await historyReady();
        const result = await bridge.request('thread/read', { threadId, includeTurns: false });
        let history;
        try { history = await bridge.request('thread/turns/list', { threadId, limit: 20, sortDirection: 'desc', itemsView: 'full', ...(data.cursor ? { cursor: text(data.cursor, '分页游标', 4000) } : {}) }); }
        catch (error) { if (/not materialized|before first user message/.test(error.message)) history = { data: [], nextCursor: null }; else throw error; }
        return json(res, 200, { thread: result.thread, turns: [...history.data].reverse(), nextCursor: history.nextCursor });
      }
      if (url.pathname === '/api/terminals' && req.method === 'GET') return json(res, 200, { sessions: terminals.list(), workspace });
      if (url.pathname === '/api/terminals' && req.method === 'POST') {
        const data = await body(req); const cwd = path.resolve(data.cwd || workspace);
        if (!(await stat(cwd)).isDirectory()) throw new Error('项目路径不是文件夹');
        return json(res, 200, { session: terminals.create({ cwd, cols: data.cols ?? 100, rows: data.rows ?? 30, resumeId: data.resumeId }) });
      }
      const terminalRoute = /^\/api\/terminals\/([a-f0-9-]+)\/(events|input|message|key|resize|close)$/.exec(url.pathname);
      if (terminalRoute) {
        const [, id, action] = terminalRoute; const session = terminals.get(id);
        if (action === 'events' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          const send = event => { if (res.writableLength > 2000000) res.destroy(); else res.write(`data: ${JSON.stringify(event)}\n\n`); };
          session.viewers++; session.emitter.on('event', send); send(terminals.snapshot(id)); clients.add(res);
          const timer = setInterval(() => { if ((sessions.get(cookie) || 0) < Date.now()) res.end(); else res.write(': keepalive\n\n'); }, 15000);
          req.on('close', () => { clearInterval(timer); clients.delete(res); session.viewers--; session.emitter.off('event', send); }); return;
        }
        if (req.method !== 'POST') return json(res, 405, { error: '请求方法无效' });
        const data = await body(req);
        if (action === 'input') await terminals.write(id, data.data);
        else if (action === 'message') await terminals.message(id, data.text);
        else if (action === 'key') { if (!Object.hasOwn(TERMINAL_KEYS, data.key)) throw new Error('按键无效'); await terminals.write(id, TERMINAL_KEYS[data.key]); }
        else if (action === 'resize') terminals.resize(id, data.cols, data.rows);
        else if (action === 'close') terminals.close(id);
        else return json(res, 405, { error: '请求方法无效' });
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(`data: ${JSON.stringify({ method: 'snapshot', params: snapshot() })}\n\n`); clients.add(res);
        const timer = setInterval(() => { if ((sessions.get(cookie) || 0) < Date.now()) res.end(); else res.write(': keepalive\n\n'); }, 15000);
        req.on('close', () => { clearInterval(timer); clients.delete(res); }); return;
      }
      if (!bridge.connected) return json(res, 503, { error: backendError || 'Codex 未连接' });
      if (url.pathname === '/api/threads' && req.method === 'GET') {
        return json(res, 200, await bridge.request('thread/list', { limit: 50, ...(url.searchParams.get('cursor') ? { cursor: url.searchParams.get('cursor') } : {}) }));
      }
      if (url.pathname === '/api/threads' && req.method === 'POST') {
        const data = await body(req); const cwd = path.resolve(data.cwd || workspace);
        if (!(await stat(cwd)).isDirectory()) throw new Error('项目路径不是文件夹');
        const result = await bridge.request('thread/start', { cwd, approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandbox: 'workspace-write' });
        managed.add(result.thread.id); view(result.thread.id).readOnly = false; return json(res, 200, result);
      }
      if (url.pathname === '/api/open' && req.method === 'POST') {
        const data = await body(req); const id = text(data.threadId, '任务 ID', 200);
        const result = await bridge.request('thread/read', { threadId: id, includeTurns: false });
        return json(res, 200, { thread: result.thread, ...await loadHistory(id) });
      }
      if (url.pathname === '/api/resume' && req.method === 'POST') {
        const data = await body(req); const id = text(data.threadId, '任务 ID', 200);
        let result;
        try { result = await bridge.request('thread/resume', { threadId: id, excludeTurns: true, approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandbox: 'workspace-write' }); }
        catch (error) {
          if (!/already has an active writer/i.test(error.message)) throw error;
          const v = view(id); v.readOnly = true; v.occupied = true;
          return json(res, 409, { code: 'THREAD_BUSY', error: '此任务正在其他 Codex 客户端中打开。你可以继续只读查看，退出原客户端的会话后重试，或复制为新会话。' });
        }
        managed.add(id);
        const v = view(id); v.readOnly = false; v.occupied = false;
        const active = result.thread.turns?.find(t => t.status === 'inProgress');
        if (active) { v.activeTurnId = active.id; v.status = 'inProgress'; }
        return json(res, 200, { thread: result.thread, ...await loadHistory(id) });
      }
      if (url.pathname === '/api/fork' && req.method === 'POST') {
        const data = await body(req); const id = text(data.threadId, '任务 ID', 200);
        const result = await bridge.request('thread/fork', { threadId: id, excludeTurns: true, approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandbox: 'workspace-write' });
        managed.add(result.thread.id); view(result.thread.id).readOnly = false;
        return json(res, 200, { thread: result.thread, ...await loadHistory(result.thread.id) });
      }
      if (url.pathname === '/api/turn' && req.method === 'POST') {
        const data = await body(req); const id = text(data.threadId, '任务 ID', 200);
        if (!managed.has(id)) throw new Error('请先打开任务');
        const input = [{ type: 'text', text: text(data.text, '消息'), text_elements: [] }]; const v = view(id);
        if (sending.has(id)) return json(res, 409, { error: '上一条消息正在发送，请稍后重试' });
        sending.add(id);
        try {
          const result = v.activeTurnId
            ? await bridge.request('turn/steer', { threadId: id, expectedTurnId: v.activeTurnId, input })
            : await bridge.request('turn/start', { threadId: id, input });
          return json(res, 200, result);
        } finally { sending.delete(id); }
      }
      if (url.pathname === '/api/interrupt' && req.method === 'POST') {
        const data = await body(req); const v = views.get(data.threadId); if (!managed.has(data.threadId) || !v?.activeTurnId) throw new Error('没有由网页管理的运行中任务');
        return json(res, 200, await bridge.request('turn/interrupt', { threadId: data.threadId, turnId: v.activeTurnId }));
      }
      if (url.pathname === '/api/respond' && req.method === 'POST') {
        const data = await body(req); const request = bridge.approvals.get(String(data.id)); if (!request) return json(res, 409, { error: '此请求已处理或已过期' });
        const method = request.method; let result;
        if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) {
          if (!['accept', 'decline', 'cancel'].includes(data.decision)) throw new Error('审批选项无效'); result = { decision: data.decision };
        } else if (method === 'item/permissions/requestApproval') {
          if (!['accept', 'decline'].includes(data.decision)) throw new Error('审批选项无效');
          result = { permissions: data.decision === 'accept' ? request.params.permissions : {}, scope: 'turn' };
        } else if (method === 'item/tool/requestUserInput' || method === 'tool/requestUserInput') {
          result = { answers: {} }; for (const q of request.params.questions) result.answers[q.id] = { answers: [text(data.answers?.[q.id], '回答')] };
        } else if (method === 'mcpServer/elicitation/request' && data.decision === 'decline') result = { action: 'decline', content: null };
        else throw new Error('此类型暂不支持网页审批，请在原生客户端处理');
        bridge.respond(data.id, result); return json(res, 200, { ok: true });
      }
      json(res, 404, { error: '接口不存在' });
    } catch (error) { if (!res.headersSent) json(res, 400, { error: error.message }); else res.end(); }
  });
  server.requestTimeout = 70000;
  server.on('close', () => { bridge.stop(); terminals.stop(); for (const res of clients) res.end(); });
  return { server, bridge, terminals, token };
}

export async function runServer({ demo = process.argv.includes('--demo'), terminalMode = process.argv.includes('--terminal'), terminalUpstream = process.env.TERMINAL_UPSTREAM, port = Number(process.env.PORT || (terminalMode ? 8789 : 8787)), host = process.env.HOST || '127.0.0.1' } = {}) {
  const tokenPath = path.join(root, '.remote-token');
  let token = process.env.REMOTE_TOKEN;
  if (!token) { try { token = (await readFile(tokenPath, 'utf8')).trim(); } catch { /* First run */ } }
  if (!token) { token = randomBytes(24).toString('hex'); await mkdir(root, { recursive: true }); await writeFile(tokenPath, token, { mode: 0o600 }); }
  const { server } = await createServer({ token, bridge: demo ? new DemoBridge() : new CodexBridge(), demo, terminalMode, terminalUpstream });
  server.listen(port, host, () => { console.log(`Codex Remote${demo ? ' [DEMO]' : ''}: http://${host}:${port}`); console.log('配对码保存在 .remote-token；请在本机打开该文件查看。'); });
  server.on('error', error => { console.error(error.message); process.exit(1); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); setTimeout(() => process.exit(0), 500).unref(); });
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runServer();
