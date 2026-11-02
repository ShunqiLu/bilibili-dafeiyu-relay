import JSONbig from 'json-bigint';
import type { Anchor, ChatMessage, Fish, Task } from '../shared/types.js';
import { randomUUID } from 'node:crypto';

export class AppError extends Error { constructor(message: string, readonly status = 400, readonly code = 'invalid_request_error') { super(message); } }
const parse = JSONbig({ storeAsString: true }).parse;
const digit = /^[1-9]\d{0,24}$/;
export function idString(value: unknown): string { if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new AppError('评论 ID 超出精确整数范围，请用字符串格式导入'); const text = String(value ?? ''); if (!digit.test(text)) throw new AppError('评论 ID 必须是正整数字符串'); return text; }

export function matchesReply(reply: any, task: Task, targetUid: string): boolean {
  const uid = String(reply.member?.mid ?? reply.mid ?? '');
  const parent = String(reply.parent_str ?? reply.parent ?? '');
  const at = Number(reply.ctime) * 1000;
  return uid === targetUid && uid !== task.accountUid && parent === task.queryRpid && at >= task.sentAt - 2000 && !!reply.content?.message && reply.invisible !== true && Number(reply.state || 0) === 0;
}

export function formatContext(messages: ChatMessage[]): string {
  const last = messages.at(-1);
  if (!last || last.role !== 'user') throw new AppError('最后一条消息必须来自 user');
  if (messages.length === 1) return last.content;
  return '请结合以下对话回答最后一个问题：\n' + messages.map(m => `${m.role === 'user' ? '我' : m.role === 'assistant' ? '你' : '背景'}：${m.content}`).join('\n');
}

export class Bilibili {
  private tail: Promise<unknown> = Promise.resolve();
  private lastRead = 0;
  constructor(private getCookie: () => string, private request: typeof fetch = fetch) {}
  async call(path: string, values: Record<string, string> = {}, post = false, anonymous = false): Promise<any> {
    const run = async () => {
      const delay = 650 - (Date.now() - this.lastRead);
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
      this.lastRead = Date.now();
      const cookie = anonymous ? '' : this.getCookie();
      if (post && !cookie) throw new AppError('请先在设置中连接 B 站账号', 409);
      const headers: Record<string, string> = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/' };
      if (cookie) headers.Cookie = cookie;
      if (post) {
        const csrf = cookie.match(/(?:^|;\s*)bili_jct=([^;]+)/)?.[1];
        if (!csrf) throw new AppError('登录态缺少 bili_jct，请重新复制完整 Cookie', 409);
        values = { ...values, csrf, csrf_token: csrf };
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
      let response: Response;
      try { response = await this.request('https://api.bilibili.com' + path + (post ? '' : '?' + new URLSearchParams(values)), { method: post ? 'POST' : 'GET', headers, body: post ? new URLSearchParams(values).toString() : undefined, signal: AbortSignal.timeout(20000), redirect: 'error' }); }
      catch { throw new AppError(post ? 'B 站写入请求未取得回执，状态不确定；请先到原评论区核对，避免重复发送' : '暂时无法连接 B 站，请稍后重试', 502, post ? 'delivery_unknown' : 'upstream_error'); }
      if (!response.ok) throw new AppError(`B 站返回 HTTP ${response.status}，请暂停并检查登录态或访问限制${post && response.status >= 500 ? '；写入状态不确定，请先核对原评论区' : ''}`, 502, post && response.status >= 500 ? 'delivery_unknown' : 'upstream_error');
      let json: any;
      try { json = parse(await response.text()); } catch { throw new AppError(post ? 'B 站未返回可识别的写入回执，请先核对原评论区，避免重复发送' : 'B 站返回了无法识别的响应', 502, post ? 'delivery_unknown' : 'upstream_error'); }
      if (Number(json.code) !== 0) throw new AppError(`B 站接口返回 ${json.code}：${String(json.message ?? json.msg ?? '请求失败').slice(0, 160)}`, 502);
      return json.data;
    };
    const pending = this.tail.then(run, run);
    this.tail = pending.catch(() => {});
    return pending;
  }
  async account() { const data = await this.call('/x/web-interface/nav'); if (!data.isLogin || !data.mid) throw new AppError('B 站登录态已失效', 409); return { uid: String(data.mid), name: String(data.uname) }; }
  async resolveVideo(input: string): Promise<string> {
    if (/^[1-9]\d*$/.test(input)) return input;
    const bvid = input.match(/BV[\da-zA-Z]{10}/)?.[0];
    const aid = input.match(/(?:\/av|^av)(\d+)/)?.[1];
    if (aid) return aid;
    if (!bvid) throw new AppError('请输入视频 BV 号、av 号、AID 或完整视频链接');
    const data = await this.call('/x/web-interface/view', { bvid }); return idString(data.aid);
  }
  async thread(anchor: Pick<Anchor, 'oid' | 'type'>, root: string, page = 1) { return this.call('/x/v2/reply/reply', { type: String(anchor.type), oid: anchor.oid, root, pn: String(page), ps: '20' }); }
  async verifyAnchor(anchor: Anchor, uid: string) {
    const root = anchor.root === '0' ? anchor.rpid : anchor.root;
    const first = await this.thread(anchor, root);
    if (String(first.root?.rpid_str ?? first.root?.rpid ?? '') === anchor.rpid && String(first.root?.member?.mid) === uid) return;
    const pages = Math.min(Math.ceil(Number(first.page?.count || 0) / 20), 25);
    for (let pn = 1; pn <= Math.max(1, pages); pn++) {
      const data = pn === 1 ? first : await this.thread(anchor, root, pn);
      if ((data.replies ?? []).some((r: any) => String(r.rpid_str ?? r.rpid) === anchor.rpid && String(r.member?.mid) === uid && !r.invisible)) return;
    }
    throw new AppError('未在评论线程中找到该 UID 的目标评论；入口可能过期，或超出本次 500 条扫描范围，请更换入口', 409);
  }
  async post(anchor: Anchor, message: string): Promise<string> {
    const data = await this.call('/x/v2/reply/add', { type: String(anchor.type), oid: anchor.oid, root: anchor.root === '0' ? anchor.rpid : anchor.root, parent: anchor.rpid, message, plat: '1' }, true);
    try { return idString(data.rpid_str ?? data.rpid ?? data.reply?.rpid_str ?? data.reply?.rpid); }
    catch { throw new AppError('B 站未返回有效评论 ID，写入状态不确定；请先核对原评论区，避免重复发送', 502, 'delivery_unknown'); }
  }
  async replies(task: Task, fish: Fish): Promise<{ text: string; rpid: string } | null> {
    // Match author and parent together; unrelated replies in the same thread never complete a task.
    const first = await this.thread({ oid: task.oid, type: 1 }, task.root);
    const pages = Math.min(Math.ceil(Number(first.page?.count || 0) / 20), 25);
    for (let pn = 1; pn <= Math.max(1, pages); pn++) {
      const row = pn === 1 ? first : await this.thread({ oid: task.oid, type: 1 }, task.root, pn);
      const reply = (row.replies ?? []).find((r: any) => matchesReply(r, task, fish.uid));
      if (reply) return { text: String(reply.content.message), rpid: idString(reply.rpid_str ?? reply.rpid) };
    }
    return null;
  }
  async remove(task: Task) {
    const account = await this.account();
    if (account.uid !== task.accountUid) throw new AppError('当前账号与发出这条查询的账号不同，停止清理', 409);
    await this.call('/x/v2/reply/del', { type: '1', oid: task.oid, rpid: task.queryRpid }, true);
  }
}

export async function discoverAicu(fish: Fish, page = 1, request: typeof fetch = fetch): Promise<Anchor[]> {
  const headers: Record<string, string> = { 'User-Agent': 'FishRelay/0.1', Accept: 'application/json' };
  const call = async (path: string, method = 'GET', timeout = 15000) => {
    let response: Response;
    try { response = await request('https://api.aicu.cc' + path, { method, signal: AbortSignal.timeout(timeout), redirect: 'error', headers }); }
    catch { throw new AppError('公开索引暂时无法连接；可打开 Aicu 页面查询，再手动导入评论入口', 502); }
    if (!response.ok) throw new AppError(`Aicu 返回 HTTP ${response.status}；可通过公开网页查询后手动导入`, 502);
    const cookies = response.headers.getSetCookie?.();
    if (cookies?.length) headers.Cookie = cookies.map(c => c.split(';')[0]).join('; ');
    return response;
  };
  const json = async (response: Response): Promise<any> => { try { return parse(await response.text()); } catch { throw new AppError('公开索引没有返回可识别的数据，请使用网页查询或手动导入', 502); } };
  // Use the public site's normal v4 queue. Tickets are never invented or reused across lookups.
  const queued = await json(await call('/api/v4/queue/enqueue', 'POST'));
  const ticket = queued.data?.ticket;
  if (typeof ticket !== 'string' || !ticket) throw new AppError(String(queued.message || '公开索引未提供查询排队凭据，请使用网页查询').slice(0, 200), 502);
  const ticketQuery = '?ticket=' + encodeURIComponent(ticket);
  if (queued.data.status !== 'ready') {
    let ready = false;
    try {
      const response = await call('/api/v4/queue/stream' + ticketQuery, 'GET', 45000);
      const reader = response.body?.getReader();
      if (!reader) throw new Error('empty stream');
      const decoder = new TextDecoder(); let buffer = '';
      try { while (!ready) { const part = await reader.read(); if (part.done) break; buffer += decoder.decode(part.value, { stream: true }).replace(/\r\n/g, '\n'); let boundary: number; while ((boundary = buffer.indexOf('\n\n')) >= 0) { const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2); if (/^event:\s*ready\s*$/m.test(event)) ready = true; if (/^event:\s*(expired|error)\s*$/m.test(event)) throw new Error('queue ended'); } if (buffer.length > 65536) throw new Error('invalid stream'); } }
      finally { await reader.cancel().catch(() => {}); }
    } catch { /* Return a usable fallback after the bounded queue wait. */ }
    if (!ready) { await call('/api/v4/queue/cancel' + ticketQuery, 'POST', 5000).catch(() => {}); throw new AppError('公开索引排队尚未完成，已退出本次排队；可稍后再查，或通过 Aicu 网页查询后手动导入', 503); }
  }
  const query = new URLSearchParams({ uid: fish.uid, pn: String(page), ps: '20', mode: '0', keyword: '', ticket });
  const body = await json(await call('/api/v4/search/getreply?' + query));
  if (body.code !== undefined && ![0, 200].includes(Number(body.code))) throw new AppError(`公开索引查询失败：${String(body.message ?? body.msg ?? body.code).slice(0, 150)}`, 502);
  const replies = body.data?.replies;
  if (!Array.isArray(replies)) throw new AppError('公开索引的数据格式已变化，请先手动导入入口', 502);
  return mapAicuReplies(fish, replies);
}

export function mapAicuReplies(fish: Fish, replies: any[]): Anchor[] {
  return replies.filter((r: any) => Number(r.dyn?.type) === 1).map((r: any) => {
    const oid = idString(r.dyn.oid), rpid = idString(r.rpid_str ?? r.rpid);
    const root = Number(r.rank) === 1 ? '0' : idString(r.parent?.rootid ?? r.root);
    return { id: randomUUID(), fishId: fish.id, oid, rpid, root, type: 1, message: String(r.message ?? ''), url: `https://www.bilibili.com/video/av${oid}/#reply${rpid}`, source: 'aicu', createdAt: Number(r.time || Date.now() / 1000) * 1000 };
  });
}
