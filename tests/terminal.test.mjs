import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fakeTerminals } from './terminal-fixture.mjs';
import { createServer } from '../server.mjs';

test('PTY runs official interactive CLI with approval and sandbox, never app-server', async () => {
  const { manager, processes } = fakeTerminals();
  try {
    const s = manager.create({ cwd: process.cwd() }); await delay(30);
    assert.equal(processes[0].command, 'official-codex');
    assert.ok(!processes[0].args.includes('app-server')); assert.ok(processes[0].args.includes('--no-daemon'));
    assert.ok(processes[0].args.includes('on-request')); assert.ok(processes[0].args.includes('workspace-write'));
    assert.ok(!processes[0].args.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(manager.snapshot(s.id).data.includes('OpenAI Codex'));
    await manager.message(s.id, '检查进度\n保留文件');
    await manager.write(s.id, '\x1b[A');
    assert.deepEqual(processes[0].inputs.slice(-3), ['\x1b[200~检查进度\n保留文件\x1b[201~', '\r', '\x1b[A']);
    manager.resize(s.id, 40, 20); assert.deepEqual(processes[0].lastSize, { cols: 40, rows: 20 });
    assert.throws(() => manager.resize(s.id, 1, 900), /尺寸/);
    await assert.rejects(manager.message(s.id, '\x1b[31m侵入按键'), /控制字符/);
    assert.equal(manager.get(s.id).status, 'running');
    manager.close(s.id); assert.equal(processes[0].killed, true);
  } finally { manager.stop(); }
});

test('terminal HTTP authentication, key routing, SSE reconnect and close', async t => {
  const { manager, processes } = fakeTerminals();
  const { server } = await createServer({ terminalMode: true, terminals: manager, token: 'terminal-test-token' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/api/terminals')).status, 401);
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'terminal-test-token' }) });
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' };
  const post = (url, body) => fetch(base + url, { method: 'POST', headers, body: JSON.stringify(body) });
  const response = await post('/api/terminals', {}); const { session } = await response.json(); assert.equal(response.status, 200);
  const prefix = `/api/terminals/${session.id}`; await delay(30);
  for (let i = 0; i < 2; i++) {
    const controller = new AbortController(); const event = await fetch(base + prefix + '/events', { headers, signal: controller.signal });
    const first = await event.body.getReader().read(); const snapshot = JSON.parse(new TextDecoder().decode(first.value).slice(6));
    assert.equal(snapshot.type, 'snapshot'); assert.ok(snapshot.data.includes('OpenAI Codex')); controller.abort();
  }
  assert.equal(processes[0].killed, false, 'disconnect must not kill the CLI');
  assert.equal((await post(prefix + '/key', { key: 'up' })).status, 200); assert.equal(processes[0].inputs.at(-1), '\x1b[A');
  assert.equal((await post(prefix + '/key', { key: 'arbitrary' })).status, 400);
  assert.equal((await post(prefix + '/message', { text: '结果' })).status, 200);
  assert.equal((await post(prefix + '/resize', { cols: 40, rows: 20 })).status, 200);
  assert.equal((await post(prefix + '/close', {})).status, 200); assert.equal(processes[0].killed, true);
  assert.equal((await post('/api/terminals', { resumeId: '--bad-option' })).status, 400);
});
