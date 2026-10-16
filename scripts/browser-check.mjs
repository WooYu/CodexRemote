import { chromium } from '@playwright/test';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createServer } from '../server.mjs';
import { DemoBridge } from '../demo.mjs';

const bridge = new DemoBridge();
bridge.threads.push({ id: 'external-ui', preview: '原客户端占用的任务', cwd: process.cwd(), externalWriter: true, turns: [{ id: 'external-turn', status: 'completed', items: [{ id: 'external-item', type: 'agentMessage', text: '其他客户端已保存的任务结果' }] }] });
const { server } = await createServer({ bridge, token: 'browser-check-token', demo: true });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  await mkdir('test-results', { recursive: true });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport }); const page = await context.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByLabel('设备配对码').fill('browser-check-token'); await page.getByRole('button', { name: '连接工作台' }).click();
    await page.getByRole('button', { name: '开始一个任务' }).waitFor();
    if (viewport.width < 700) await page.getByRole('button', { name: '打开任务列表' }).click();
    await page.locator('.task-link').filter({ has: page.locator('strong', { hasText: /^原客户端占用的任务$/ }) }).click();
    await page.getByText('其他客户端已保存的任务结果', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('发送给 Codex 的消息').isDisabled(), true);
    await page.locator('#resume-task').click();
    await page.getByText('原客户端正在使用此会话', { exact: true }).waitFor();
    await page.screenshot({ path: `test-results/readonly-${viewport.width}.png`, fullPage: true });
    await page.getByRole('button', { name: '复制为新会话', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('message').disabled);
    await page.getByText('其他客户端已保存的任务结果', { exact: true }).waitFor();
    // Return to the overview for the existing task lifecycle checks.
    await page.reload();
    await page.getByRole('button', { name: '开始一个任务' }).waitFor();
    await page.screenshot({ path: `test-results/welcome-${viewport.width}.png`, fullPage: true });
    await page.getByRole('button', { name: '开始一个任务' }).click(); await page.getByRole('button', { name: '创建任务' }).click();
    await page.getByLabel('发送给 Codex 的消息').fill('检查项目并运行测试'); await page.getByRole('button', { name: '发送' , exact: true }).click();
    await page.getByRole('button', { name: '批准本次' }).waitFor();
    // Reload simulates browser disconnect; the same approval must still be actionable.
    await page.reload();
    if (viewport.width < 700) await page.getByRole('button', { name: '打开任务列表' }).click();
    await page.locator('.task-link').first().click(); await page.getByRole('button', { name: '批准本次' }).waitFor();
    await page.screenshot({ path: `test-results/approval-${viewport.width}.png`, fullPage: true });
    await page.getByLabel('发送给 Codex 的消息').fill('先执行单元测试'); await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.getByRole('button', { name: '批准本次' }).click();
    await page.getByText('已收到批准。演示测试通过，任务完成。', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'horizontal overflow');
    assert.deepEqual(errors, []); await page.screenshot({ path: `test-results/completed-${viewport.width}.png`, fullPage: true });
    console.log(`PASS ${viewport.width}px: read-only history, writer conflict, fork, pairing, task creation, input, reload, steering, approval, results, no overflow or JS errors`);
    await context.close();
  }
} finally { await browser?.close(); server.closeAllConnections(); server.close(); }
