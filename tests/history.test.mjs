import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from '../server.mjs';
import { DemoBridge } from '../demo.mjs';
import { fakeTerminals } from './terminal-fixture.mjs';

async function listen(t, options) {
  const result = await createServer(options); result.server.listen(0, '127.0.0.1'); await once(result.server, 'listening');
  t.after(() => { result.server.closeAllConnections(); result.server.close(); });
  return { ...result, base: `http://127.0.0.1:${result.server.address().port}` };
}
async function login(base) {
  const response = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'history-token' }) });
  return { Cookie: response.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' };
}
function historyBridge() {
  const bridge = new DemoBridge();
  bridge.threads.push({ id: 'saved-task', name: '旧任务', cwd: process.cwd(), externalWriter: true, turns: [{ id: 'saved-turn', status: 'completed', items: [{ id: 'saved-result', type: 'agentMessage', text: '保存的结果' }] }] });
  const requests = []; const request = bridge.request.bind(bridge); bridge.request = (method, params) => { requests.push({ method, params }); return request(method, params); };
  return { bridge, requests };
}
test('CLI history list and preview are authenticated and do not acquire a writer or infer', async t => {
  const { bridge, requests } = historyBridge(); const { manager } = fakeTerminals();
  const { base } = await listen(t, { bridge, terminals: manager, terminalMode: true, token: 'history-token' });
  assert.equal(bridge.connected, false, 'history backend starts lazily');
  assert.equal((await fetch(base + '/api/history')).status, 401);
  const headers = await login(base);
  const listed = await (await fetch(base + '/api/history?search=旧任务&cursor=test-cursor', { headers })).json();
  assert.equal(listed.data[0].id, 'saved-task');
  assert.equal(requests[0].params.searchTerm, '旧任务'); assert.equal(requests[0].params.cursor, 'test-cursor');
  const preview = await (await fetch(base + '/api/history/read', { method: 'POST', headers, body: JSON.stringify({ threadId: 'saved-task', cursor: 'older' }) })).json();
  assert.equal(preview.turns[0].items[0].text, '保存的结果');
  assert.equal(requests.at(-1).params.cursor, 'older');
  assert.deepEqual(requests.map(r => r.method), ['thread/list', 'thread/read', 'thread/turns/list']);
  assert.equal(manager.list().length, 0, 'preview must not spawn a CLI');
});

test('UI upgrade gateway retains existing PTYs, auth and SSE', async t => {
  const { manager, processes } = fakeTerminals(); const { bridge } = historyBridge();
  const old = await listen(t, { terminalMode: true, terminals: manager, token: 'history-token' });
  const active = manager.create({ cwd: process.cwd() });
  const gateway = await listen(t, { terminalMode: true, bridge, terminalUpstream: old.base });
  const headers = await login(gateway.base);
  const listed = await (await fetch(gateway.base + '/api/terminals', { headers })).json(); assert.equal(listed.sessions[0].id, active.id);
  assert.equal((await fetch(gateway.base + '/api/history', { headers })).status, 200);
  assert.equal((await fetch(gateway.base + '/api/history')).status, 401);
  const controller = new AbortController();
  const stream = await fetch(gateway.base + `/api/terminals/${active.id}/events`, { headers, signal: controller.signal });
  const first = await stream.body.getReader().read(); const event = JSON.parse(new TextDecoder().decode(first.value).slice(6));
  assert.equal(event.type, 'snapshot'); assert.equal(event.id, active.id); controller.abort();
  assert.equal(processes[0].killed, false);
  const key = await fetch(gateway.base + `/api/terminals/${active.id}/key`, { method: 'POST', headers, body: JSON.stringify({ key: 'up' }) });
  assert.equal(key.status, 200); assert.equal(processes[0].inputs.at(-1), '\x1b[A');
  const forbidden = await fetch(gateway.base + '/api/terminals', { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.example' }, body: '{}' });
  assert.equal(forbidden.status, 403); assert.equal(manager.list().length, 1);
  gateway.server.closeAllConnections(); gateway.server.close(); assert.equal(processes[0].killed, false, 'closing UI gateway must not kill upstream CLI');
});
