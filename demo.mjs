import { EventEmitter } from 'node:events';

export class DemoBridge extends EventEmitter {
  constructor() { super(); this.connected = false; this.approvals = new Map(); this.threads = []; this.counter = 0; }
  async start() { this.connected = true; }
  event(method, params) { this.emit('event', { method, params }); }
  async request(method, p) {
    if (method === 'thread/list') return { data: this.threads, nextCursor: null };
    if (method === 'thread/start') {
      const thread = { id: `demo-${++this.counter}`, cwd: p.cwd, preview: '新任务', turns: [], status: { type: 'idle' } };
      this.threads.unshift(thread); return { thread };
    }
    const thread = this.threads.find(t => t.id === p.threadId);
    if (!thread) throw new Error('任务不存在');
    if (method === 'thread/read') return { thread };
    if (method === 'thread/resume') { if (thread.externalWriter) throw new Error(`thread ${thread.id} already has an active writer`); return { thread }; }
    if (method === 'thread/fork') {
      const fork = { ...structuredClone(thread), id: `demo-${++this.counter}`, preview: `${thread.preview}（副本）`, externalWriter: false, status: { type: 'idle' } };
      for (const turn of fork.turns) if (turn.status === 'inProgress') turn.status = 'interrupted';
      this.threads.unshift(fork); return { thread: fork };
    }
    if (method === 'thread/turns/list') return { data: [...thread.turns].reverse(), nextCursor: null };
    if (method === 'turn/start') {
      const turn = { id: `turn-${++this.counter}`, status: 'inProgress', items: [{ id: `user-${this.counter}`, type: 'userMessage', content: p.input }] };
      thread.preview = p.input[0].text; thread.turns.push(turn);
      this.event('turn/started', { threadId: thread.id, turn });
      this.event('item/completed', { threadId: thread.id, turnId: turn.id, item: turn.items[0] });
      const item = { id: `agent-${this.counter}`, type: 'agentMessage', text: '这是演示任务。实时输出、断线恢复、输入与审批都可以在这里体验；不会调用模型或修改你的文件。' };
      turn.items.push(item);
      this.event('item/completed', { threadId: thread.id, turnId: turn.id, item });
      this.event('turn/plan/updated', { threadId: thread.id, plan: [{ step: '读取项目', status: 'completed' }, { step: '等待执行审批', status: 'inProgress' }] });
      const request = { id: `approval-${this.counter}`, method: 'item/commandExecution/requestApproval', params: { threadId: thread.id, turnId: turn.id, itemId: 'command-demo', command: 'npm test', cwd: thread.cwd, reason: '演示：运行测试前请确认。' } };
      this.approvals.set(request.id, request); this.emit('event', request);
      return { turn };
    }
    if (method === 'turn/steer') { this.event('item/completed', { threadId: thread.id, item: { id: `steer-${++this.counter}`, type: 'userMessage', content: p.input } }); return { turnId: p.expectedTurnId }; }
    if (method === 'turn/interrupt') {
      for (const [id, request] of this.approvals) if (request.params.threadId === thread.id) { this.approvals.delete(id); this.event('serverRequest/resolved', { requestId: id }); }
      const turn = thread.turns.at(-1); turn.status = 'interrupted'; this.event('turn/completed', { threadId: thread.id, turn }); return {};
    }
    throw new Error(`演示不支持 ${method}`);
  }
  respond(id, result) {
    const request = this.approvals.get(String(id)); if (!request) throw new Error('请求已过期');
    this.approvals.delete(String(id)); this.event('serverRequest/resolved', { requestId: id });
    const thread = this.threads.find(t => t.id === request.params.threadId); const turn = thread.turns.at(-1);
    const item = { id: `result-${++this.counter}`, type: 'agentMessage', text: result.decision === 'accept' ? '已收到批准。演示测试通过，任务完成。' : '已收到拒绝，没有执行命令。' };
    turn.items.push(item); this.event('item/completed', { threadId: thread.id, item });
    turn.status = 'completed'; this.event('turn/completed', { threadId: thread.id, turn });
  }
  stop() {}
}
