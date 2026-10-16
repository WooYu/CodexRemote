import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';

export function codexCommand() {
  if (process.env.CODEX_BIN) return { command: process.env.CODEX_BIN, args: ['app-server'] };
  if (process.platform === 'win32') {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      const script = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (existsSync(script)) return { command: process.execPath, args: [script, 'app-server'] };
    }
  }
  return { command: 'codex', args: ['app-server'] };
}

export class CodexBridge extends EventEmitter {
  constructor() { super(); this.pending = new Map(); this.approvals = new Map(); this.nextId = 1; this.connected = false; }
  async start() {
    const { command, args } = codexCommand();
    this.proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc.stdin.on('error', () => {});
    this.proc.on('error', error => this.fail(error));
    this.proc.on('exit', code => this.fail(new Error(`Codex 已退出 (${code})，请重启服务。`)));
    this.proc.stderr.on('data', chunk => this.emit('diagnostic', chunk.toString()));
    readline.createInterface({ input: this.proc.stdout }).on('line', line => {
      try { this.receive(JSON.parse(line)); } catch { /* Ignore non-protocol log lines. */ }
    });
    const result = await this.request('initialize', { clientInfo: { name: 'codex_remote_web', title: 'Codex Remote', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.write({ method: 'initialized' });
    this.connected = true;
    return result;
  }
  write(message) {
    if (!this.proc?.stdin.writable || this.proc.killed) throw new Error('Codex 后端未连接');
    this.proc.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 请求超时`)); }, 60000);
      this.pending.set(id, { resolve, reject, timeout });
      try { this.write({ id, method, params }); } catch (error) { clearTimeout(timeout); this.pending.delete(id); reject(error); }
    });
  }
  receive(message) {
    if (message.method) {
      if (message.id !== undefined) this.approvals.set(String(message.id), message);
      if (message.method === 'serverRequest/resolved') this.approvals.delete(String(message.params.requestId));
      this.emit('event', message);
    } else {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout); this.pending.delete(message.id);
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
    }
  }
  respond(id, result) {
    const request = this.approvals.get(String(id));
    if (!request) throw new Error('此请求已处理或已过期');
    this.write({ id: request.id, result });
    this.approvals.delete(String(id));
    this.emit('event', { method: 'serverRequest/resolved', params: { requestId: request.id } });
  }
  fail(error) {
    this.connected = false;
    for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(error); }
    this.pending.clear(); this.approvals.clear();
    this.emit('event', { method: 'bridge/error', params: { message: error.message } });
  }
  stop() { this.proc?.kill(); }
}
