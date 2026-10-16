import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  await page.goto('http://127.0.0.1:8789');
  await page.getByLabel('设备配对码').fill((await readFile('.remote-token', 'utf8')).trim());
  await page.getByRole('button', { name: '连接终端', exact: true }).click();
  await page.getByRole('button', { name: '创建一个会话' }).click();
  await page.getByRole('button', { name: '打开终端', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.xterm-accessibility')?.textContent.includes('Ask Codex to do anything'), null, { timeout: 30000 });
  await page.getByLabel('发送到当前终端', { exact: true }).fill('只回复：网页终端实测成功。不要读取或修改任何文件，不运行命令，不调用工具。');
  await page.getByRole('button', { name: '发送 ↑', exact: true }).click();
  await page.waitForFunction(() => /•\s*网页终端实测成功/.test(document.querySelector('.xterm-accessibility')?.textContent || ''), null, { timeout: 90000 });
  await page.screenshot({ path: 'test-results/terminal-live.png', fullPage: true });
  console.log('PASS real web → PTY → official Codex CLI → configured provider → streamed model reply. Session retained for the user.');
} finally { await browser.close(); }
