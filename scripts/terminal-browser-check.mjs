import { chromium } from '@playwright/test';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createServer } from '../server.mjs';
import { fakeTerminals } from '../tests/terminal-fixture.mjs';
import { DemoBridge } from '../demo.mjs';
const { manager, processes } = fakeTerminals();
const historyBridge = new DemoBridge();
historyBridge.threads.push({ id: 'saved-history-task', name: '修复历史任务', preview: '修复历史任务', cwd: process.cwd(), externalWriter: true, turns: [{ id: 'saved-turn', status: 'completed', items: [{ id: 'saved-message', type: 'agentMessage', text: '原来的任务结果还在这里。' }] }] });
const { server } = await createServer({ terminalMode: true, terminals: manager, bridge: historyBridge, token: 'terminal-ui-token' });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true }); await mkdir('test-results', { recursive: true });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport }); const page = await context.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByLabel('设备配对码').fill('terminal-ui-token'); await page.getByRole('button', { name: '连接终端', exact: true }).click();
    await page.getByRole('button', { name: '创建一个会话' }).click(); await page.getByRole('button', { name: '打开终端', exact: true }).click();
    await page.getByText('CLI 已连接', { exact: true }).waitFor();
    await page.getByLabel('发送到当前终端', { exact: true }).fill('手机输入的中文需求'); await page.getByRole('button', { name: '发送 ↑', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.xterm-accessibility')?.textContent.includes('CLI 收到输入'));
    await page.getByRole('button', { name: '方向键上', exact: true }).click();
    assert.ok(processes.at(-1).inputs.includes('\x1b[A'));
    await page.reload(); await page.getByText('CLI 已连接', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('.xterm-accessibility')?.textContent.includes('CLI 收到输入'));
    assert.equal(processes.at(-1).killed, false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    await page.getByLabel('发送到当前终端', { exact: true }).fill('刷新后仍在的草稿');
    await page.reload(); await page.getByText('CLI 已连接', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('发送到当前终端', { exact: true }).inputValue(), '刷新后仍在的草稿');
    processes.at(-1).output('\x1b[2J\x1b[HThis conversation is open in another app\r\nr to retry\r\nClose it there and press R to continue here.');
    await page.getByText('会话被占用', { exact: true }).waitFor();
    assert.equal(await page.locator('#send').isDisabled(), true);
    await page.getByRole('button', { name: '已退出电脑端，重试连接' }).click();
    assert.ok(processes.at(-1).inputs.includes('r'));
    processes.at(-1).output('\x1b[2J\x1b[H准备输入\r\n');
    await page.getByText('CLI 已连接', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('发送到当前终端', { exact: true }).inputValue(), '刷新后仍在的草稿');
    processes.at(-1).output('\x1b[2J\x1b[H' + Array.from({ length: 120 }, (_, i) => `history-line-${i}\r\n`).join(''));
    await page.waitForFunction(() => document.querySelector('.xterm-accessibility')?.textContent.includes('history-line-119'));
    const beforeScroll = await page.locator('.xterm-accessibility').textContent();
    const inputsBeforeScroll = processes.at(-1).inputs.length;
    await page.locator('#terminal').evaluate(element => {
      element.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [new Touch({ identifier: 1, target: element, clientX: 100, clientY: 200 })] }));
      element.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: [new Touch({ identifier: 1, target: element, clientX: 100, clientY: 400 })] }));
      element.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [] }));
    });
    await page.waitForFunction(before => document.querySelector('.xterm-accessibility')?.textContent !== before, beforeScroll);
    assert.equal(processes.at(-1).inputs.length, inputsBeforeScroll, 'scrolling must not send CLI input');
    processes.at(-1).output('new-output-while-reading\r\n');
    await page.getByRole('button', { name: '有新输出 · 回到底部 ↓' }).waitFor();
    assert.equal(await page.locator('.xterm-accessibility').textContent() === beforeScroll, false);
    if (viewport.width < 700) {
      const key = await page.locator('[data-key=interrupt]').boundingBox();
      assert.ok(key && key.x >= 0 && key.x + key.width <= viewport.width, 'interrupt must be visible without horizontal scrolling');
    }

    await page.getByRole('button', { name: '向上翻页' }).click();
    await page.getByRole('button', { name: '向下翻页' }).click();
    await page.locator('#scroll-bottom').click();
    await page.waitForFunction(() => document.querySelector('.xterm-accessibility')?.textContent.includes('new-output-while-reading'));
    await page.route('**/api/terminals/*/message', route => route.abort());
    await page.locator('#send').click();
    await page.getByText('发送结果未确认，草稿已保留。', { exact: true }).waitFor();
    assert.equal(await page.locator('#message').inputValue(), '刷新后仍在的草稿');
    assert.equal(await page.locator('#send').isDisabled(), false);
    await page.unroute('**/api/terminals/*/message');
    await page.screenshot({ path: `test-results/terminal-${viewport.width}.png`, fullPage: true });
    await page.getByRole('button', { name: '关闭会话', exact: true }).click();
    await page.getByRole('button', { name: '继续保留' }).click(); assert.equal(processes.at(-1).killed, false);
    if (viewport.width < 700) await page.getByRole('button', { name: '打开会话列表' }).click();
    await page.getByRole('button', { name: /修复历史任务/ }).click();
    await page.getByText('原来的任务结果还在这里。', { exact: true }).waitFor();
    assert.equal(processes.at(-1).killed, false, 'reading history must preserve running terminal');
    await page.screenshot({ path: `test-results/terminal-history-${viewport.width}.png`, fullPage: true });
    await page.getByRole('button', { name: '在终端中继续' }).click();
    await page.getByText('CLI 已连接', { exact: true }).waitFor();
    assert.ok(processes.at(-1).args.includes('resume')); assert.ok(processes.at(-1).args.includes('saved-history-task'));
    await page.getByRole('button', { name: '关闭会话', exact: true }).click(); await page.locator('#close-confirm').getByRole('button', { name: '关闭会话', exact: true }).click();
    await page.getByRole('button', { name: '创建一个会话' }).waitFor(); assert.equal(processes.at(-1).killed, true);
    console.log(`PASS CLI ${viewport.width}px: pairing, Chinese input, keys, reconnect, historical preview/resume, no overflow/JS errors, explicit close confirmation`);
    await context.close();
  }
} finally { await browser?.close(); server.closeAllConnections(); server.close(); }
