import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import pty from 'node-pty';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import { codexCommand } from './bridge.mjs';

const { Terminal } = headless;
const { SerializeAddon } = serialize;
export const TERMINAL_KEYS = Object.freeze({ enter: '\r', up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C', escape: '\x1b', tab: '\t', interrupt: '\x03', backspace: '\x7f', shiftEnter: '\x1b\r' });
export function terminalSize(cols, rows) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || cols > 300 || rows < 8 || rows > 100) throw new Error('终端尺寸无效');
  return { cols, rows };
}

export class TerminalManager extends EventEmitter {
  constructor({ spawn = pty.spawn, commandFactory = codexCommand } = {}) { super(); this.sessions = new Map(); this.spawn = spawn; this.commandFactory = commandFactory; }
  list() { return [...this.sessions.values()].map(s => this.info(s)); }
  info(s) { return { id: s.id, cwd: s.cwd, name: s.name, cols: s.cols, rows: s.rows, status: s.status, createdAt: s.createdAt, exitCode: s.exitCode }; }
  get(id) { const session = this.sessions.get(id); if (!session) throw new Error('终端会话不存在'); return session; }
  create({ cwd, cols = 100, rows = 30, resumeId } = {}) {
    terminalSize(cols, rows);
    if (this.sessions.size >= 12) throw new Error('最多保留 12 个终端会话，请关闭不再使用的会话后重试');
    if (resumeId && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(resumeId)) throw new Error('历史会话 ID 无效');
    const { command, args } = this.commandFactory();
    const cliArgs = args.at(-1) === 'app-server' ? args.slice(0, -1) : args;
    if (resumeId) cliArgs.push('resume', resumeId);
    cliArgs.push('--no-daemon', '--no-alt-screen', '--ask-for-approval', 'on-request', '--sandbox', 'workspace-write', '-c', 'approvals_reviewer="user"');
    const terminal = new Terminal({ cols, rows, scrollback: 3000, allowProposedApi: true });
    const serializer = new SerializeAddon(); terminal.loadAddon(serializer);
    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    for (const key of ['CODEX_CI', 'CODEX_DAEMON_SHUTDOWN_FILE', 'CODEX_DAEMON_SHUTDOWN_SOCKET', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_TOOL_CALL_ID']) delete env[key];
    let proc;
    try { proc = this.spawn(command, cliArgs, { name: 'xterm-256color', cols, rows, cwd, env }); }
    catch (error) { terminal.dispose(); throw error; }
    const session = { id: randomUUID(), name: resumeId ? `恢复 ${resumeId.slice(0, 8)}` : 'Codex CLI', cwd, cols, rows, status: 'running', createdAt: Date.now(), proc, terminal, serializer, viewers: 0, emitter: new EventEmitter(), writeQueue: Promise.resolve(), timers: new Set() };
    this.sessions.set(session.id, session);
    // Answer cursor/device queries while no browser is attached, allowing CLI startup unattended.
    terminal.onData(data => { if (!session.viewers && session.status === 'running') proc.write(data); });
    proc.onData(data => { if (session.status !== 'closed') terminal.write(data, () => session.emitter.emit('event', { type: 'output', data })); });
    proc.onExit(({ exitCode }) => {
      if (session.status === 'closed') return;
      session.status = 'exited'; session.exitCode = exitCode;
      terminal.write('', () => session.emitter.emit('event', { type: 'exit', exitCode }));
      this.emit('change');
    });
    this.emit('change'); return this.info(session);
  }
  snapshot(id) { const s = this.get(id); return { type: 'snapshot', ...this.info(s), data: s.serializer.serialize({ scrollback: 3000 }) }; }
  write(id, data) {
    const s = this.get(id); if (s.status !== 'running') throw new Error('终端已退出，请新建会话');
    if (typeof data !== 'string' || !data.length || data.length > 20000) throw new Error('终端输入无效');
    // Serialize paste+submit with later key events so approval/input never interleaves.
    return s.writeQueue = s.writeQueue.catch(() => {}).then(() => { if (s.status !== 'running') throw new Error('终端已退出'); s.proc.write(data); });
  }
  async message(id, text) {
    if (typeof text !== 'string' || !text.trim() || text.length > 16000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(text)) throw new Error('消息无效或含终端控制字符');
    const s = this.get(id);
    s.writeQueue = s.writeQueue.catch(() => {}).then(async () => {
      if (s.status !== 'running') throw new Error('终端已退出');
      s.proc.write(`\x1b[200~${text}\x1b[201~`);
      await new Promise(resolve => { const timer = setTimeout(() => { s.timers.delete(timer); resolve(); }, 100); s.timers.add(timer); });
      if (s.status === 'running') s.proc.write('\r');
    });
    return s.writeQueue;
  }
  resize(id, cols, rows) {
    terminalSize(cols, rows); const s = this.get(id); if (s.status !== 'running') return;
    s.proc.resize(cols, rows); s.terminal.resize(cols, rows); s.cols = cols; s.rows = rows;
    s.emitter.emit('event', { type: 'resize', cols, rows });
  }
  close(id) {
    const s = this.get(id); const running = s.status === 'running'; s.status = 'closed';
    if (running) s.proc.kill();
    s.emitter.emit('event', { type: 'exit', exitCode: null });
    s.terminal.dispose(); this.sessions.delete(id); this.emit('change');
  }
  stop() { for (const id of [...this.sessions.keys()]) this.close(id); }
}
