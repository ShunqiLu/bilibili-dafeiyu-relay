import { createHash, randomUUID } from 'node:crypto';
import type { ChatMessage, Task } from '../shared/types.js';
import { Store } from './store.js';
import { AppError, Bilibili, formatContext } from './platform.js';

export const active = (task: Task) => ['queued', 'posting', 'waiting'].includes(task.status);
export class Engine {
  private busy = false;
  private timer?: NodeJS.Timeout;
  constructor(readonly store: Store, readonly bili: Bilibili) {}
  recover() {
    for (const task of this.store.all('tasks')) {
      if (task.status === 'posting') this.store.patchTask(task.id, { status: 'interrupted', error: '发送过程中服务重启，是否发布成功尚未确认；请先检查原评论区；本工具不会重复发送' });
      if (task.status === 'queued') this.store.patchTask(task.id, { status: 'interrupted', error: '服务重启，尚未发送的任务已停止' });
      if (task.cleanupStatus === 'deleting') this.store.patchTask(task.id, { cleanupStatus: 'failed', cleanupError: '清理过程中服务重启，请检查原评论区后再操作' });
    }
  }
  start() { this.recover(); this.timer = setInterval(() => void this.tick().catch(() => {}), 400); }
  stop() { clearInterval(this.timer); }
  create(input: { fishId?: string; anchorId?: string; sessionId?: string; messages: ChatMessage[]; requestKey?: string }): Task {
    const settings = this.store.settings();
    const fingerprint = createHash('sha256').update(JSON.stringify({ ...input, requestKey: undefined, mode: settings.mode })).digest('hex');
    if (input.requestKey) {
      const existing = this.store.all('tasks').find(t => t.requestKey === input.requestKey);
      if (existing) { if (existing.requestHash !== fingerprint) throw new AppError('相同 Idempotency-Key 对应的请求内容不同', 409); return existing; }
    }
    const session = input.sessionId ? this.store.get('sessions', input.sessionId) : undefined;
    if (input.sessionId && !session) throw new AppError('会话不存在', 404);
    if (session && input.fishId && session.fishId !== input.fishId) throw new AppError('不能在同一会话中更换目标 UID');
    const fishId = session?.fishId ?? input.fishId;
    const fish = fishId ? this.store.get('fish', fishId) : this.store.all('fish').find(f => f.enabled);
    if (!fish || !fish.enabled) throw new AppError('请先添加或启用 UID', 409);
    if (this.store.all('tasks').some(t => t.fishId === fish.id && active(t))) throw new AppError('该 UID 还有一条消息等待处理，请先等待或取消', 409);
    const anchor = input.anchorId ? this.store.get('anchors', input.anchorId) : this.store.all('anchors').filter(a => a.fishId === fish.id).sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!anchor || anchor.fishId !== fish.id) throw new AppError('请先查询或导入这个 UID 的评论入口', 409);
    const payload = formatContext(input.messages);
    if (Array.from(payload).length > 900) throw new AppError('对话上下文超过 900 字，请缩短或新建会话；内容不会被静默截断');
    if (!settings.liveEnabled || !this.store.secrets.cookie) throw new AppError('请先连接 B 站账号并开启评论发送', 409);
    const now = Date.now(), sessionId = session?.id ?? randomUUID();
    const task: Task = { id: randomUUID(), sessionId, fishId: fish.id, anchorId: anchor.id, mode: settings.mode, status: 'queued', prompt: input.messages.at(-1)!.content, payload, result: '', error: '', queryRpid: '', replyRpid: '', oid: anchor.oid, root: anchor.root === '0' ? anchor.rpid : anchor.root, accountUid: '', cleanupStatus: 'none', cleanupError: '', cleanupAt: 0, createdAt: now, updatedAt: now, sentAt: 0, deadlineAt: 0, nextPollAt: 0, requestKey: input.requestKey ?? null, requestHash: fingerprint, fishName: fish.name, uid: fish.uid };
    return this.store.transaction(() => {
      this.store.put('sessions', session ? { ...session, updatedAt: now } : { id: sessionId, fishId: fish.id, title: task.prompt.slice(0, 34), fishName: fish.name, platform: fish.platform, createdAt: now, updatedAt: now });
      this.store.put('tasks', task); this.store.message(task, 'user', task.prompt); return task;
    });
  }
  cancel(id: string) {
    const task = this.store.get('tasks', id);
    if (!task) throw new AppError('任务不存在', 404);
    if (task.status === 'posting') throw new AppError('发送正在进行，请等待回执后停止等待', 409);
    if (!active(task)) throw new AppError('此任务已经结束', 409);
    return this.store.patchTask(id, { status: 'cancelled', error: task.queryRpid ? '已停止等待；发出的评论仍保留在原评论区' : '任务已取消，未发送评论' });
  }
  async cleanup(id: string) {
    const task = this.store.get('tasks', id);
    if (!task) throw new AppError('任务不存在', 404);
    if (task.status !== 'completed' || !task.queryRpid || !task.result) throw new AppError('只允许清理已收到目标回复的本工具查询评论', 409);
    if (task.cleanupStatus === 'deleted') return task;
    if (task.cleanupStatus === 'deleting') throw new AppError('正在清理，请稍候', 409);
    this.store.patchTask(id, { cleanupStatus: 'deleting', cleanupError: '' });
    try {
      await this.bili.remove(task);
      return this.store.patchTask(id, { cleanupStatus: 'deleted', cleanupAt: Date.now() });
    } catch (error) {
      this.store.patchTask(id, { cleanupStatus: 'failed', cleanupError: error instanceof Error ? error.message : '清理失败' }); throw error;
    }
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const settings = this.store.settings(), now = Date.now();
      const tasks = this.store.all('tasks').sort((a, b) => a.createdAt - b.createdAt);
      for (const current of tasks) {
        let task = this.store.get('tasks', current.id)!;
        if (task.status === 'queued') {
          const fish = this.store.get('fish', task.fishId), anchor = this.store.get('anchors', task.anchorId);
          if (!fish?.enabled || !anchor) { this.store.patchTask(task.id, { status: 'failed', error: '目标账号已停用或评论入口已移除' }); continue; }
          if (!settings.liveEnabled) { this.store.patchTask(task.id, { status: 'cancelled', error: '评论发送已关闭，未发送这条评论' }); continue; }
          const sent = tasks.filter(t => t.sentAt > 0);
          const lastSent = Math.max(0, ...sent.map(t => t.sentAt));
          if (now - lastSent < settings.cooldownSeconds * 1000) continue;
          const day = (ms: number) => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
          if (sent.filter(t => day(t.sentAt) === day(now)).length >= settings.dailyLimit) { this.store.patchTask(task.id, { status: 'failed', error: '今日发送额度已用完（北京时间），未发送这条评论' }); continue; }
          this.store.patchTask(task.id, { status: 'posting' });
          try {
            const account = await this.bili.account();
            await this.bili.verifyAnchor(anchor, fish.uid);
            if (!this.store.settings().liveEnabled) throw new AppError('评论发送已关闭');
            const sentAt = Date.now();
            task = this.store.patchTask(task.id, { sentAt, accountUid: account.uid });
            const rpid = await this.bili.post(anchor, task.payload);
            this.store.patchTask(task.id, { status: 'waiting', queryRpid: rpid, deadlineAt: Date.now() + settings.timeoutSeconds * 1000, nextPollAt: Date.now() + settings.pollSeconds * 1000 });
          } catch (error) {
            this.store.patchTask(task.id, { status: error instanceof AppError && error.code === 'delivery_unknown' ? 'interrupted' : 'failed', error: error instanceof Error ? error.message : '发送失败' });
          }
          break;
        }
        if (task.status === 'waiting' && task.deadlineAt <= now) { this.store.patchTask(task.id, { status: 'failed', error: '等待超时，尚未收到目标账号对本条评论的回复；查询评论保留供核对，不会自动重发' }); continue; }
        if (task.status === 'waiting' && task.nextPollAt <= now) {
          const fish = this.store.get('fish', task.fishId);
          if (!fish) { this.store.patchTask(task.id, { status: 'failed', error: '目标账号已移除' }); continue; }
          this.store.patchTask(task.id, { nextPollAt: now + settings.pollSeconds * 1000 });
          try {
            const reply = await this.bili.replies(task, fish);
            if (this.store.get('tasks', task.id)?.status !== 'waiting') continue;
            if (reply) this.store.transaction(() => { const complete = this.store.patchTask(task.id, { status: 'completed', result: reply.text, replyRpid: reply.rpid, error: '', cleanupStatus: settings.autoCleanup ? 'pending' : 'none', cleanupAt: settings.autoCleanup ? Date.now() + settings.cleanupDelaySeconds * 1000 : 0 }); this.store.message(complete, 'assistant', reply.text); const session = this.store.get('sessions', task.sessionId); if (session) this.store.put('sessions', { ...session, updatedAt: Date.now() }); });
          } catch (error) {
            if (this.store.get('tasks', task.id)?.status === 'waiting') this.store.patchTask(task.id, { error: error instanceof Error ? error.message : '读取回复失败，稍后再检查' });
          }
          break;
        }
        if (task.status === 'completed' && task.cleanupStatus === 'pending' && settings.autoCleanup && settings.liveEnabled && task.cleanupAt <= now) { await this.cleanup(task.id).catch(() => {}); break; }
      }
    } finally { this.busy = false; }
  }
  async wait(id: string, signal?: AbortSignal): Promise<Task> {
    for (;;) {
      const task = this.store.get('tasks', id)!;
      if (!active(task)) return task;
      if (signal?.aborted) throw new AppError('客户端已断开，任务仍可在评论台账查看', 499);
      await new Promise(r => setTimeout(r, 300));
    }
  }
}
