import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from '../server.mjs';
import { DemoBridge } from '../demo.mjs';
import { CodexBridge } from '../bridge.mjs';

async function setup(t) {
  const bridge = new DemoBridge(); const { server } = await createServer({ bridge, token: 'test-pair-token', demo: true });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'test-pair-token' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  async function call(route, body, headers = {}) {
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }
  return { bridge, base, cookie, call };
}

test('authentication, origin checks and static asset boundary', async t => {
  const { base, call } = await setup(t);
  assert.equal((await fetch(base + '/api/state')).status, 401);
  assert.equal((await call('/api/state')).body.demo, true);
  assert.equal((await call('/api/threads', {}, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await fetch(base + '/.remote-token')).status, 401);
  assert.equal((await fetch(base + '/')).headers.get('content-security-policy').includes("frame-ancestors 'none'"), true);
  assert.equal((await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"token":"incorrect"}' })).status, 401);
});

test('turn progress, steering, pending approval survival and one-shot approval', async t => {
  const { call } = await setup(t);
  const { body: { thread } } = await call('/api/threads', {});
  assert.equal((await call('/api/turn', { threadId: thread.id, text: '检查项目' })).status, 200);
  let snapshot = (await call('/api/state')).body;
  assert.equal(snapshot.views[0].status, 'inProgress'); assert.equal(snapshot.approvals.length, 1);
  assert.equal((await call('/api/turn', { threadId: thread.id, text: '先运行测试' })).status, 200);
  snapshot = (await call('/api/state')).body; assert.equal(snapshot.approvals.length, 1);
  const id = snapshot.approvals[0].id;
  assert.equal((await call('/api/respond', { id, decision: 'acceptForSession' })).status, 400);
  assert.equal((await call('/api/respond', { id, decision: 'accept' })).status, 200);
  assert.equal((await call('/api/respond', { id, decision: 'accept' })).status, 409);
  snapshot = (await call('/api/state')).body;
  assert.equal(snapshot.approvals.length, 0); assert.equal(snapshot.views[0].status, 'completed');
  assert.ok(snapshot.views[0].items.some(i => i.text?.includes('演示测试通过')));
});

test('interrupt clears pending approvals; empty messages are rejected', async t => {
  const { call } = await setup(t); const { body: { thread } } = await call('/api/threads', {});
  assert.equal((await call('/api/turn', { threadId: thread.id, text: '' })).status, 400);
  await call('/api/turn', { threadId: thread.id, text: '工作' }); await call('/api/interrupt', { threadId: thread.id });
  const state = (await call('/api/state')).body;
  assert.equal(state.views[0].status, 'interrupted'); assert.equal(state.approvals.length, 0);
});

test('SSE reconnection sends the full state including unresolved requests', async t => {
  const { base, cookie, call } = await setup(t); const { body: { thread } } = await call('/api/threads', {});
  await call('/api/turn', { threadId: thread.id, text: '工作' });
  for (let i = 0; i < 2; i++) {
    const controller = new AbortController(); const response = await fetch(base + '/api/events', { headers: { Cookie: cookie }, signal: controller.signal });
    const reader = response.body.getReader(); const first = await reader.read(); const event = JSON.parse(new TextDecoder().decode(first.value).split('data: ')[1].split('\n\n')[0]);
    assert.equal(event.method, 'snapshot'); assert.equal(event.params.approvals.length, 1); controller.abort();
  }
});

test('freeform user questions and permission approval response shape', async t => {
  const { bridge, call } = await setup(t); let result;
  bridge.respond = (id, response) => { result = response; bridge.approvals.delete(String(id)); };
  bridge.approvals.set('q', { id: 'q', method: 'item/tool/requestUserInput', params: { questions: [{ id: 'preference' }] } });
  assert.equal((await call('/api/respond', { id: 'q', answers: {} })).status, 400);
  assert.equal((await call('/api/respond', { id: 'q', answers: { preference: '先处理错误' } })).status, 200);
  assert.deepEqual(result, { answers: { preference: { answers: ['先处理错误'] } } });
  bridge.approvals.set('p', { id: 'p', method: 'item/permissions/requestApproval', params: { permissions: { network: { enabled: true } } } });
  assert.equal((await call('/api/respond', { id: 'p', decision: 'decline' })).status, 200);
  assert.deepEqual(result, { permissions: {}, scope: 'turn' });
});

test('logout invalidates the paired session', async t => {
  const { call } = await setup(t); assert.equal((await call('/api/logout', {})).status, 200); assert.equal((await call('/api/state')).status, 401);
});

test('bridge routes JSON-RPC results and preserves string approval IDs', async () => {
  const bridge = new CodexBridge(); const sent = []; bridge.write = value => sent.push(value);
  const request = bridge.request('thread/list', {}); bridge.receive({ id: sent[0].id, result: { data: [] } }); assert.deepEqual(await request, { data: [] });
  bridge.receive({ id: 'opaque-id', method: 'item/fileChange/requestApproval', params: {} });
  bridge.respond('opaque-id', { decision: 'decline' }); assert.deepEqual(sent.at(-1), { id: 'opaque-id', result: { decision: 'decline' } });
  assert.throws(() => bridge.respond('opaque-id', {}), /过期/);
});

test('opening an externally owned task only reads; resume conflicts keep history visible', async t => {
  const { bridge, call } = await setup(t);
  bridge.threads.push({ id: 'external', preview: '其他客户端的任务', cwd: process.cwd(), externalWriter: true, turns: [{ id: 'old-turn', status: 'inProgress', items: [{ id: 'old-item', type: 'agentMessage', text: '已保存的进度' }] }] });
  const methods = []; const request = bridge.request.bind(bridge); bridge.request = (method, params) => { methods.push(method); return request(method, params); };
  const opened = await call('/api/open', { threadId: 'external' });
  assert.equal(opened.status, 200); assert.equal(opened.body.view.readOnly, true); assert.equal(opened.body.view.activeTurnId, null);
  assert.deepEqual(methods, ['thread/read', 'thread/turns/list']);
  assert.equal((await call('/api/turn', { threadId: 'external', text: '不应发送' })).status, 400);
  assert.equal((await call('/api/interrupt', { threadId: 'external' })).status, 400);
  const resumed = await call('/api/resume', { threadId: 'external' });
  assert.equal(resumed.status, 409); assert.equal(resumed.body.code, 'THREAD_BUSY'); assert.ok(!resumed.body.error.includes('active writer'));
  const v = (await call('/api/state')).body.views[0]; assert.equal(v.occupied, true); assert.equal(v.items[0].text, '已保存的进度');
  bridge.threads[0].turns[0].items[0].text = '新保存的进度';
  assert.equal((await call('/api/open', { threadId: 'external' })).body.view.items[0].text, '新保存的进度');
  bridge.threads[0].externalWriter = false;
  assert.equal((await call('/api/resume', { threadId: 'external' })).body.view.readOnly, false);
});

test('fork copies history without acquiring or mutating the occupied source', async t => {
  const { bridge, call } = await setup(t);
  const source = { id: 'busy-source', preview: '原会话', cwd: process.cwd(), externalWriter: true, turns: [{ id: 'old', status: 'completed', items: [{ id: 'message', type: 'agentMessage', text: '历史上下文' }] }] };
  bridge.threads.push(source); const before = structuredClone(source);
  const result = await call('/api/fork', { threadId: source.id });
  assert.equal(result.status, 200); assert.notEqual(result.body.thread.id, source.id);
  assert.equal(result.body.view.readOnly, false); assert.equal(result.body.view.items[0].text, '历史上下文');
  assert.deepEqual(source, before);
  assert.equal((await call('/api/turn', { threadId: result.body.thread.id, text: '继续副本' })).status, 200);
  assert.deepEqual(source, before);
});
