import { TerminalManager } from '../terminal-manager.mjs';
export function fakeTerminals() {
  const processes = [];
  const manager = new TerminalManager({ commandFactory: () => ({ command: 'official-codex', args: ['app-server'] }), spawn(command, args, options) {
    const process = { command, args, options, inputs: [], output: null, exit: null, killed: false,
      onData(callback) { this.output = callback; queueMicrotask(() => callback('\x1b[32m>_ OpenAI Codex\x1b[0m\r\n准备输入\r\n')); },
      onExit(callback) { this.exit = callback; },
      write(data) { this.inputs.push(data); if (data.startsWith('\x1b[200~')) this.message = data.slice(6, -6); if (data === '\r') this.output(`\r\n› ${this.message || '确认'}\r\n• CLI 收到输入\r\n`); },
      resize(cols, rows) { this.lastSize = { cols, rows }; },
      kill() { this.killed = true; this.exit({ exitCode: 0 }); },
    };
    processes.push(process); return process;
  } });
  return { manager, processes };
}
