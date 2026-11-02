import express from 'express';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { Store } from './store.js';
import { Engine, active } from './engine.js';
import { Bilibili, AppError, discoverAicu, idString } from './platform.js';
import type { Anchor, ChatMessage, Fish } from '../shared/types.js';

const mode = z.literal('bilibili');
const uid = z.string().trim().regex(/^[1-9]\d{0,24}$/, '请输入有效的数字 UID');
const fishSchema = z.object({ uid, name: z.string().trim().min(1).max(60), note: z.string().max(500).default(''), platform: mode.optional() });
const settingsSchema = z.object({ mode: mode.default('bilibili'), pollSeconds: z.number().int().min(10).max(120), timeoutSeconds: z.number().int().min(30).max(600), cooldownSeconds: z.number().int().min(60).max(3600), dailyLimit: z.number().int().min(1).max(100), autoCleanup: z.boolean(), cleanupDelaySeconds: z.number().int().min(30).max(3600), liveEnabled: z.boolean() });
const messagesSchema = z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string().trim().min(1).max(10000) }).strict()).min(1).max(30);
const param = (value: unknown) => { if (typeof value !== 'string') throw new AppError('路径参数错误'); return value; };
const requireEntity = <T>(entity: T | undefined, label: string): T => { if (!entity) throw new AppError(label + '不存在', 404); return entity; };

export function createApp(store: Store, platform?: Bilibili) {
  const app = express(), bili = platform ?? new Bilibili(() => store.secrets.cookie), engine = new Engine(store, bili);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const host = req.headers.host ?? '';
    if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) return next(new AppError('仅接受本机访问', 403));
    if (req.headers.origin && ![`http://${host}`, 'http://127.0.0.1:5173', 'http://localhost:5173'].includes(req.headers.origin)) return next(new AppError('拒绝跨站请求', 403));
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
    if (req.path.startsWith('/api') || req.path.startsWith('/v1')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '128kb' }));
  app.use('/api', (req, _res, next) => { if (req.get('X-Fish-UI') !== '1') return next(new AppError('管理接口需要 X-Fish-UI 请求头', 403)); next(); });
  app.use('/v1', (req, _res, next) => {
    const supplied = Buffer.from(req.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? '');
    const expected = Buffer.from(store.secrets.apiKey);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return next(new AppError('API Key 无效，请从 API 接入页面复制', 401, 'authentication_error'));
    next();
  });
  const enrichedFish = () => store.all('fish').map(f => ({ ...f, anchorCount: store.all('anchors').filter(a => a.fishId === f.id).length, taskCount: store.all('tasks').filter(t => t.fishId === f.id).length }));
  app.get('/api/overview', (_req, res) => {
    const tasks = store.all('tasks').sort((a, b) => b.createdAt - a.createdAt), fish = enrichedFish();
    res.json({ fish, sessions: store.all('sessions').sort((a, b) => b.updatedAt - a.updatedAt), tasks: tasks.slice(0, 500), settings: store.publicSettings(), counts: { total: fish.length, enabled: fish.filter(f => f.enabled && f.platform === store.settings().mode).length, completed: tasks.filter(t => t.status === 'completed').length, waiting: tasks.filter(active).length, cleaned: tasks.filter(t => t.cleanupStatus === 'deleted').length, failed: tasks.filter(t => ['failed', 'interrupted'].includes(t.status)).length } });
  });
  app.get('/api/fish', (_req, res) => res.json(enrichedFish()));
  function addFish(data: z.infer<typeof fishSchema>): Fish {
    const platform = data.platform ?? store.settings().mode;
    if (store.all('fish').some(f => f.uid === data.uid && f.platform === platform)) throw new AppError('该 UID 已在名单中', 409);
    const fish = store.put('fish', { ...data, platform, id: randomUUID(), enabled: true, createdAt: Date.now() });
    return fish;
  }
  app.post('/api/fish', (req, res) => res.status(201).json(addFish(fishSchema.parse(req.body))));
  app.post('/api/fish/import', (req, res) => {
    const body = z.object({ text: z.string().max(30000).min(1), platform: mode.default('bilibili') }).parse(req.body);
    const lines = body.text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (lines.length > 100) throw new AppError('一次最多导入 100 个 UID');
    const entries = lines.map(line => { const [id, ...names] = line.split(/[,，\t]/); return fishSchema.parse({ uid: id.trim(), name: names.join(',').trim() || id.trim(), platform: body.platform }); });
    const result = store.transaction(() => { let added = 0, skipped = 0; for (const entry of entries) { if (store.all('fish').some(f => f.uid === entry.uid && f.platform === entry.platform)) { skipped++; continue; } addFish(entry); added++; } return { added, skipped }; });
    res.json(result);
  });
  app.patch('/api/fish/:id', (req, res) => {
    const fish = requireEntity(store.get('fish', param(req.params.id)), '账号');
    const patch = z.object({ name: z.string().trim().min(1).max(60).optional(), note: z.string().max(500).optional(), enabled: z.boolean().optional() }).strict().parse(req.body);
    res.json(store.put('fish', { ...fish, ...patch }));
  });
  app.delete('/api/fish/:id', (req, res) => {
    const id = param(req.params.id); requireEntity(store.get('fish', id), '账号');
    if (store.all('tasks').some(t => t.fishId === id && active(t))) throw new AppError('此账号有未结束的任务，请先取消或等待', 409);
    store.transaction(() => { store.remove('fish', id); for (const a of store.all('anchors').filter(a => a.fishId === id)) store.remove('anchors', a.id); });
    res.json({ deleted: true });
  });
  app.get('/api/fish/:id/anchors', (req, res) => res.json(store.all('anchors').filter(a => a.fishId === req.params.id).sort((a, b) => b.createdAt - a.createdAt)));
  app.post('/api/fish/:id/anchors', async (req, res) => {
    const fish = requireEntity(store.get('fish', param(req.params.id)), '账号');
    const body = z.object({ video: z.string().trim().min(1).max(500), rpid: z.string().regex(/^[1-9]\d{0,24}$/), root: z.string().regex(/^\d{1,25}$/).default('0'), message: z.string().max(3000).default('') }).parse(req.body);
    const oid = await bili.resolveVideo(body.video);
    const existing = store.all('anchors').find(a => a.fishId === fish.id && a.oid === oid && a.rpid === body.rpid);
    if (existing) return res.json(existing);
    const anchor: Anchor = { id: randomUUID(), fishId: fish.id, oid, rpid: body.rpid, root: body.root === body.rpid ? '0' : body.root, type: 1, message: body.message || '手动导入的评论入口', url: `https://www.bilibili.com/video/av${oid}/#reply${body.rpid}`, source: 'manual', createdAt: Date.now() };
    await bili.verifyAnchor(anchor, fish.uid);
    res.status(201).json(store.put('anchors', anchor));
  });
  const discoveryAt = new Map<string, number>();
  app.post('/api/fish/:id/discover', async (req, res) => {
    const fish = requireEntity(store.get('fish', param(req.params.id)), '账号');
    const { page } = z.object({ page: z.number().int().min(1).max(30).default(1) }).parse(req.body);
    if (Date.now() - (discoveryAt.get(fish.id) ?? 0) < 15000) throw new AppError('请间隔 15 秒再查询公开索引', 429);
    discoveryAt.set(fish.id, Date.now());
    const anchors = await discoverAicu(fish, page); let added = 0;
    store.transaction(() => { for (const anchor of anchors) { if (!store.all('anchors').some(a => a.fishId === fish.id && a.oid === anchor.oid && a.rpid === anchor.rpid)) { store.put('anchors', anchor); added++; } } });
    res.json({ added, message: anchors.length ? '索引记录已导入，发送前会再次核对原评论' : '本页没有收录视频评论，可手动导入入口', anchors });
  });
  app.delete('/api/anchors/:id', (req, res) => { const id = param(req.params.id); if (store.all('tasks').some(t => t.anchorId === id && active(t))) throw new AppError('此入口正在使用中', 409); store.remove('anchors', id); res.json({ deleted: true }); });
  app.get('/api/sessions/:id', (req, res) => { const session = requireEntity(store.get('sessions', param(req.params.id)), '会话'); res.json({ session, messages: store.all('messages').filter(m => m.sessionId === session.id).sort((a, b) => a.createdAt - b.createdAt), tasks: store.all('tasks').filter(t => t.sessionId === session.id) }); });
  app.post('/api/chat', (req, res) => {
    const body = z.object({ fishId: z.string().min(1), anchorId: z.string().optional(), sessionId: z.string().optional(), content: z.string().trim().min(1).max(900) }).parse(req.body);
    const previous = body.sessionId ? store.all('messages').filter(m => m.sessionId === body.sessionId).sort((a, b) => a.createdAt - b.createdAt).map(m => ({ role: m.role, content: m.content })) : [];
    res.status(202).json(engine.create({ ...body, messages: [...previous, { role: 'user', content: body.content }] }));
  });
  app.get('/api/tasks/:id', (req, res) => res.json(requireEntity(store.get('tasks', param(req.params.id)), '任务')));
  app.post('/api/tasks/:id/cancel', (req, res) => res.json(engine.cancel(param(req.params.id))));
  app.post('/api/tasks/:id/cleanup', async (req, res) => res.json(await engine.cleanup(param(req.params.id))));
  app.get('/api/settings', (_req, res) => res.json(store.publicSettings()));
  app.put('/api/settings', (req, res) => {
    const settings = settingsSchema.parse(req.body);
    if (settings.liveEnabled && (!store.secrets.cookie || !store.secrets.accountUid)) throw new AppError('请先连接并验证 B 站账号', 409);
    store.saveSettings(settings); res.json(store.publicSettings());
  });
  app.post('/api/account', async (req, res) => {
    if (store.all('tasks').some(t => t.mode === 'bilibili' && active(t))) throw new AppError('请先结束真实任务，再更换登录态，避免发送与清理账号不一致', 409);
    const body = z.object({ cookie: z.string().trim().min(1).max(20000) }).parse(req.body);
    if (/[\r\n]/.test(body.cookie)) throw new AppError('Cookie 不能包含换行');
    const account = await new Bilibili(() => body.cookie).account();
    if (store.all('tasks').some(t => t.mode === 'bilibili' && active(t))) throw new AppError('验证期间有真实任务启动，登录态尚未替换；请先结束任务再保存', 409);
    store.secrets = { ...store.secrets, cookie: body.cookie, accountUid: account.uid, accountName: account.name }; store.saveSecrets();
    res.json({ uid: account.uid, name: account.name });
  });
  app.post('/api/account/check', async (_req, res) => res.json(await bili.account()));
  app.delete('/api/account', (_req, res) => { if (store.all('tasks').some(t => t.mode === 'bilibili' && active(t))) throw new AppError('请先结束真实任务再断开登录态', 409); store.secrets = { ...store.secrets, cookie: '', accountUid: '', accountName: '' }; store.saveSecrets(); store.saveSettings({ ...store.settings(), liveEnabled: false }); res.json({ disconnected: true }); });
  app.get('/api/key', (_req, res) => res.json({ key: store.secrets.apiKey }));
  app.post('/api/key/rotate', (_req, res) => { store.secrets.apiKey = 'fish_' + randomBytes(24).toString('hex'); store.saveSecrets(); res.json({ key: store.secrets.apiKey }); });
  app.get('/api/export', (_req, res) => res.json({ version: 1, exportedAt: new Date().toISOString(), fish: store.all('fish'), anchors: store.all('anchors'), sessions: store.all('sessions'), messages: store.all('messages'), tasks: store.all('tasks'), settings: { ...store.settings(), liveEnabled: false } }));
  app.get('/v1/models', (_req, res) => res.json({ object: 'list', data: [{ id: 'fish-auto', object: 'model', created: 0, owned_by: 'fish-relay' }, ...store.all('fish').filter(f => f.enabled && f.platform === store.settings().mode).map(f => ({ id: 'fish-' + f.uid, object: 'model', created: Math.floor(f.createdAt / 1000), owned_by: 'fish-relay' }))] }));
  app.post('/v1/chat/completions', async (req, res) => {
    const body = z.object({ model: z.string().default('fish-auto'), messages: messagesSchema, stream: z.boolean().default(false), temperature: z.number().optional(), max_tokens: z.number().int().positive().optional(), fish_uid: z.string().optional(), anchor_id: z.string().optional() }).passthrough().parse(req.body);
    const unsupported = ['tools', 'tool_choice', 'response_format', 'functions', 'n'].filter(k => req.body[k] !== undefined);
    if (unsupported.length) throw new AppError('评论对话暂不支持这些参数：' + unsupported.join(', '));
    if (body.model !== 'fish-auto' && !body.model.startsWith('fish-')) throw new AppError('未知模型，请使用 /v1/models 返回的模型名称', 404);
    const targetUid = body.fish_uid ?? (body.model === 'fish-auto' ? undefined : body.model.slice(5));
    const fish = targetUid ? store.all('fish').find(f => f.uid === targetUid && f.platform === store.settings().mode) : undefined;
    if (targetUid && !fish) throw new AppError('名单中没有这个 UID', 404);
    const key = req.get('Idempotency-Key'); if (key && (key.length > 150 || !/^[\w.:/-]+$/.test(key))) throw new AppError('Idempotency-Key 格式不正确');
    const task = engine.create({ fishId: fish?.id, anchorId: body.anchor_id, messages: body.messages as ChatMessage[], requestKey: key });
    res.setHeader('X-Fish-Task-Id', task.id);
    const controller = new AbortController(); res.on('close', () => controller.abort());
    let heartbeat: NodeJS.Timeout | undefined;
    if (body.stream) { res.set({ 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'Cache-Control': 'no-cache' }); res.flushHeaders(); res.write(': waiting for comment reply\n\n'); heartbeat = setInterval(() => { if (!res.destroyed) res.write(': waiting\n\n'); }, 10000); }
    try {
      const result = await engine.wait(task.id, controller.signal);
      if (result.status !== 'completed') throw new AppError(result.error || '目标未返回回答', result.status === 'failed' ? 504 : 409, 'upstream_error');
      const base = { id: 'chatcmpl-' + task.id, created: Math.floor(task.createdAt / 1000), model: body.model };
      if (body.stream) {
        res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: result.result }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`); res.end();
      } else res.json({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: result.result }, finish_reason: 'stop' }], usage: null, fish: { task_id: task.id, uid: result.uid, mode: result.mode, query_rpid: result.queryRpid, reply_rpid: result.replyRpid } });
    } catch (error) {
      if (!res.destroyed && body.stream) { res.write(`data: ${JSON.stringify({ error: { message: error instanceof Error ? error.message : '请求失败', type: 'upstream_error' } })}\n\ndata: [DONE]\n\n`); res.end(); }
      else if (!res.destroyed) throw error;
    } finally { clearInterval(heartbeat); }
  });
  app.use(['/api', '/v1'], (_req, _res, next) => next(new AppError('接口不存在', 404)));
  const dist = resolve('dist');
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.use('/assets', (_req, _res, next) => next(new AppError('文件不存在', 404)));
    app.get('/{*path}', (_req, res) => res.sendFile(resolve(dist, 'index.html')));
  }
  else app.get('/', (_req, res) => res.type('text').send('前端尚未构建，请运行 npm run build，或使用 npm run dev 打开 5173 端口'));
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) return;
    if (error instanceof z.ZodError) return res.status(400).json({ error: { message: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('；'), type: 'invalid_request_error' } });
    const known = error instanceof AppError;
    res.status(known ? error.status : error.type === 'entity.parse.failed' ? 400 : 500).json({ error: { message: known ? error.message : error.type === 'entity.parse.failed' ? '请求 JSON 格式不正确' : '服务处理失败，请检查本地数据和配置', type: known ? error.code : 'server_error' } });
  });
  return { app, engine, bili };
}
