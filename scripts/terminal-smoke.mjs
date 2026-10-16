import { TerminalManager } from '../terminal-manager.mjs';
const manager = new TerminalManager();
let session, timer, deadline;
function content() { const buffer = session.terminal.buffer.active; const lines = []; for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true)); return lines.join('\n'); }
try {
  const info = manager.create({ cwd: process.cwd(), cols: 110, rows: 32 }); session = manager.get(info.id);
  await new Promise((resolve, reject) => {
    timer = setInterval(() => { if (content().includes('Ask Codex to do anything')) resolve(); }, 200);
    deadline = setTimeout(() => reject(new Error('CLI startup timed out:\n' + content())), 30000);
  });
  clearInterval(timer); clearTimeout(deadline);
  console.log('Official CLI startup OK');
  await manager.message(info.id, '只回复这一句：远程终端验证成功。不要读取或修改文件，不运行命令，不调用工具。');
  await new Promise((resolve, reject) => {
    timer = setInterval(() => {
      const text = content();
      if (/403 Forbidden|only allows Codex official clients|unexpected status|Error:/.test(text)) reject(new Error(text));
      // The user prompt contains the marker too; require an assistant bullet line.
      if (/•\s*远程终端验证成功/.test(text)) resolve();
    }, 400);
    deadline = setTimeout(() => reject(new Error('No confirmed model reply within 90s:\n' + content())), 90000);
  });
  console.log('Actual provider inference OK'); console.log(content());
} finally { clearInterval(timer); clearTimeout(deadline); manager.stop(); }
