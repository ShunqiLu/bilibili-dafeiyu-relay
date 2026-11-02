import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { Store } from '../server/store.js';
import { Engine } from '../server/engine.js';
import { Bilibili, AppError, matchesReply, formatContext, idString, mapAicuReplies, discoverAicu } from '../server/platform.js';
import { createApp } from '../server/app.js';
import type { Anchor, Fish, Task } from '../shared/types.js';

// Synthetic fixture IDs only; tests use an injected adapter and never contact real accounts.
class FakeBili extends Bilibili {
  sent: string[] = []; removed: string[] = []; answer: { text: string; rpid: string } | null = null; rejectSend = false;
  constructor() { super(() => 'test-cookie'); }
  override async account() { return { uid: '9007199254740993001', name: '测试账号' }; }
  override async verifyAnchor(_anchor: Anchor, _uid: string) {}
  override async post(_anchor: Anchor, text: string) { this.sent.push(text); if (this.rejectSend) throw new AppError('写入回执不确定', 502, 'delivery_unknown'); return '9007199254740993124'; }
  override async replies() { return this.answer; }
  override async remove(task: Task) { this.removed.push(task.queryRpid); }
}
function setupLive() {
  const store = new Store(':memory:'), bili = new FakeBili(), engine = new Engine(store, bili);
  store.secrets.cookie = 'test'; store.secrets.accountUid = '9007199254740993001';
  store.saveSettings({ ...store.settings(), mode: 'bilibili', liveEnabled: true });
  const fish = store.put('fish', { id: randomUUID(), uid: '100000001', name: '测试对象', platform: 'bilibili', note: '', enabled: true, createdAt: Date.now() });
  store.put('anchors', { id: randomUUID(), fishId: fish.id, oid: '900000000000101', rpid: '900000000000201', root: '900000000000202', type: 1, message: '测试入口', url: '', source: 'manual', createdAt: Date.now() });
  return { store, bili, engine, fish };
}
const request = (fishId: string) => ({ fishId, messages: [{ role: 'user' as const, content: 'test' }] });

test('reply matching requires the correct UID, parent, time, and visibility', () => {
  const task = { queryRpid: '9007199254740993124', accountUid: '9007199254740993001', sentAt: 1793595000000 } as Task;
  const reply = { member: { mid: '100000001' }, parent_str: task.queryRpid, ctime: task.sentAt / 1000, content: { message: '收到' }, state: 0 };
  assert.equal(matchesReply(reply, task, '100000001'), true);
  assert.equal(matchesReply({ ...reply, member: { mid: '999' } }, task, '100000001'), false);
  assert.equal(matchesReply({ ...reply, parent_str: '9007199254740993125' }, task, '100000001'), false);
  assert.equal(matchesReply({ ...reply, parent_str: '9007199254740993125', dialog: task.queryRpid }, task, '100000001'), false);
  assert.equal(matchesReply({ ...reply, ctime: task.sentAt / 1000 - 10 }, task, '100000001'), false);
  assert.equal(matchesReply({ ...reply, invisible: true }, task, '100000001'), false);
  assert.equal(matchesReply({ ...reply, state: 17 }, task, '100000001'), false);
});

test('public index maps v4 nested video IDs and skips non-video entries', () => {
  const fish = { id: 'f' } as Fish;
  const anchors = mapAicuReplies(fish, [{ dyn: { type: 1, oid: '900000000000101' }, rank: 2, rpid: '900000000000201', parent: { rootid: '900000000000202' }, message: 'hello', time: 1793590000 }, { dyn: { type: 17, oid: '1' }, rank: 1, rpid: '2' }]);
  assert.equal(anchors.length, 1); assert.equal(anchors[0].root, '900000000000202'); assert.equal(anchors[0].oid, '900000000000101');
  assert.throws(() => idString(9007199254740992), /精确整数/);
  assert.equal(idString('9007199254740993124'), '9007199254740993124');
});

test('public index uses the normal queue ticket and never sends a Bilibili credential', async () => {
  const calls: string[] = [];
  const mockFetch = (async (url: any, options: any) => { calls.push(String(url)); assert.equal(options.headers.Cookie, undefined); if (String(url).includes('/enqueue')) return Response.json({ code: 0, data: { ticket: 'issued-ticket', status: 'ready' } }); assert.match(String(url), /ticket=issued-ticket/); return new Response('{"code":0,"data":{"replies":[{"dyn":{"type":1,"oid":900000000000101},"rank":1,"rpid":9007199254740993124,"message":"hello","time":1793590000}]}}'); }) as typeof fetch;
  const rows = await discoverAicu({ id: 'f', uid: '100000001' } as Fish, 1, mockFetch);
  assert.equal(calls.length, 2); assert.equal(rows[0].rpid, '9007199254740993124'); assert.equal(rows[0].root, '0');
});

test('public index waits for the issued queue ready event', async () => {
  const paths: string[] = [];
  const mockFetch = (async (url: any) => { const path = String(url); paths.push(path); if (path.includes('/enqueue')) return Response.json({ code: 0, data: { ticket: 'queue-ticket', status: 'waiting' } }); if (path.includes('/stream')) return new Response('event: position\ndata: {"position":1}\n\nevent: ready\ndata: {}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }); return Response.json({ code: 0, data: { replies: [] } }); }) as typeof fetch;
  assert.deepEqual(await discoverAicu({ id: 'f', uid: '100000001' } as Fish, 1, mockFetch), []);
  assert.equal(paths.length, 3); assert.match(paths[1], /queue\/stream\?ticket=queue-ticket/);
});

test('missing post receipts are uncertain rather than treated as confirmed failures', async () => {
  const mockFetch = (async () => Response.json({ code: 0, data: {} })) as typeof fetch;
  const bili = new Bilibili(() => 'SESSDATA=test;bili_jct=testing', mockFetch);
  await assert.rejects(() => bili.post({ type: 1, oid: '11', rpid: '22', root: '0' } as Anchor, 'test'), (error: any) => error.code === 'delivery_unknown');
});

test('idempotency survives completion and changing bodies is rejected', async () => {
  const { store, engine, bili, fish } = setupLive();
  const input = { ...request(fish.id), requestKey: 'same-request' };
  const first = engine.create(input), second = engine.create(input);
  assert.equal(first.id, second.id); assert.equal(store.all('messages').length, 1);
  await engine.tick(); assert.equal(bili.sent.length, 1);
  store.patchTask(first.id, { nextPollAt: 0 }); bili.answer = { text: '测试成功', rpid: '9007199254740993125' }; await engine.tick();
  assert.equal(store.get('tasks', first.id)?.status, 'completed');
  assert.equal(engine.create(input).id, first.id); await engine.tick(); assert.equal(bili.sent.length, 1);
  assert.throws(() => engine.create({ ...input, messages: [{ role: 'user', content: 'different' }] }), /请求内容不同/);
  store.close();
});

test('a second active request to one UID never posts and cancel does not delete', async () => {
  const { store, engine, bili, fish } = setupLive();
  const first = engine.create(request(fish.id));
  assert.throws(() => engine.create(request(fish.id)), /等待处理/);
  await engine.tick(); engine.cancel(first.id); await engine.tick();
  assert.equal(bili.sent.length, 1); assert.equal(bili.removed.length, 0); assert.equal(store.get('tasks', first.id)?.status, 'cancelled');
  store.close();
});

test('only completed app queries can be cleaned and response content stays', async () => {
  const { store, engine, bili, fish } = setupLive(); const task = engine.create(request(fish.id));
  await assert.rejects(() => engine.cleanup(task.id), /已收到目标回复/);
  await engine.tick(); store.patchTask(task.id, { nextPollAt: 0 }); bili.answer = { text: '回来了', rpid: '9007199254740993125' }; await engine.tick();
  await engine.cleanup(task.id); await engine.cleanup(task.id);
  assert.deepEqual(bili.removed, ['9007199254740993124']); assert.equal(store.get('tasks', task.id)?.result, '回来了'); assert.equal(store.all('messages').length, 2);
  store.close();
});

test('live cleanup stops before deletion if the account has changed', async () => {
  const paths: string[] = [];
  const mockFetch = (async (url: any) => { paths.push(String(url)); return Response.json({ code: 0, data: { isLogin: true, mid: 'different-account', uname: 'other' } }); }) as typeof fetch;
  const bili = new Bilibili(() => 'SESSDATA=test;bili_jct=testing', mockFetch);
  await assert.rejects(() => bili.remove({ accountUid: 'original-account', queryRpid: '123', oid: '456' } as Task), /账号不同/);
  assert.equal(paths.length, 1); assert.match(paths[0], /\/nav\?/);
});

test('unknown post outcomes and restart recovery never resend', async () => {
  const { store, engine, bili, fish } = setupLive(); bili.rejectSend = true;
  const task = engine.create(request(fish.id)); await engine.tick(); await engine.tick();
  assert.equal(store.get('tasks', task.id)?.status, 'interrupted'); assert.equal(bili.sent.length, 1);
  store.patchTask(task.id, { status: 'posting' }); engine.recover(); await engine.tick();
  assert.equal(store.get('tasks', task.id)?.status, 'interrupted'); assert.equal(bili.sent.length, 1);
  store.close();
});

test('live cooldown and daily limit are enforced across tasks', async () => {
  const { store, engine, bili, fish } = setupLive(); const first = engine.create(request(fish.id));
  await engine.tick(); engine.cancel(first.id); const second = engine.create(request(fish.id)); await engine.tick();
  assert.equal(store.get('tasks', second.id)?.status, 'queued'); assert.equal(bili.sent.length, 1);
  store.patchTask(first.id, { sentAt: Date.now() - 61000 }); store.saveSettings({ ...store.settings(), dailyLimit: 1 }); await engine.tick();
  assert.equal(store.get('tasks', second.id)?.status, 'failed'); assert.match(store.get('tasks', second.id)!.error, /额度/); assert.equal(bili.sent.length, 1); store.close();
});

test('context is preserved and oversized context fails before side effects', () => {
  const { store, engine, fish } = setupLive();
  assert.match(formatContext([{ role: 'user', content: 'first' }, { role: 'assistant', content: 'second' }, { role: 'user', content: 'third' }]), /我：first\n你：second\n我：third/);
  assert.throws(() => engine.create({ fishId: fish.id, messages: [{ role: 'user', content: 'a'.repeat(901) }] }), /900/);
  assert.equal(store.all('tasks').length, 0); assert.equal(store.all('messages').length, 0); store.close();
});

test('new stores have only real mode and no seeded accounts or conversations', () => {
  const store = new Store(':memory:');
  try {
    assert.equal(store.settings().mode, 'bilibili');
    assert.equal(store.settings().liveEnabled, false);
    for (const kind of ['fish', 'anchors', 'tasks', 'sessions', 'messages'] as const) assert.deepEqual(store.all(kind), []);
  } finally { store.close(); }
});

test('store persists credentials without exposing them in public settings', () => {
  const folder = mkdtempSync(join(tmpdir(), 'fish-relay-test-'));
  const store = new Store(folder); const key = store.secrets.apiKey;
  store.secrets.cookie = 'PRIVATE_SECRET_COOKIE'; store.saveSecrets(); store.close();
  const reopened = new Store(folder); assert.equal(reopened.secrets.apiKey, key); assert.equal(reopened.secrets.cookie, 'PRIVATE_SECRET_COOKIE'); assert.equal(JSON.stringify(reopened.publicSettings()).includes('PRIVATE_SECRET_COOKIE'), false);
  reopened.close(); assert.equal(dirname(resolve(folder)), resolve(tmpdir())); assert.match(basename(folder), /^fish-relay-test-/); rmSync(folder, { recursive: true });
});

test('retired demo data is archived once while real records and credentials survive migration', () => {
  const folder = mkdtempSync(join(tmpdir(), 'fish-relay-test-'));
  let store: Store | undefined = new Store(folder);
  try {
    const key = store.secrets.apiKey;
    store.secrets.cookie = 'MIGRATION_PRIVATE_COOKIE'; store.secrets.accountUid = '123456'; store.saveSecrets();
    store.saveSettings({ ...store.settings(), liveEnabled: true });
    const fish = store.put('fish', { id: 'real-fish', uid: '100000001', name: '真实账号', platform: 'bilibili', note: '保留备注', enabled: true, createdAt: 1 });
    store.put('anchors', { id: 'real-anchor', fishId: fish.id, oid: '900000000000101', rpid: '900000000000201', root: '900000000000202', type: 1, message: '真实入口', url: '', source: 'aicu', createdAt: 1 });
    const task = new Engine(store, new FakeBili()).create(request(fish.id));
    store.patchTask(task.id, { status: 'completed', result: '保留原文回复', queryRpid: '9007199254740993124', replyRpid: '9007199254740993125' });
    store.message(task, 'assistant', '保留原文回复');
    store.put('fish', { ...fish, enabled: false });
    const legacy = [
      ['fish', { id: 'old-fish', uid: 'demo-1', platform: 'demo' }],
      ['anchors', { id: 'old-anchor', fishId: 'old-fish', source: 'demo' }],
      ['sessions', { id: 'old-session', fishId: 'old-fish', platform: 'demo' }],
      ['tasks', { id: 'old-task', fishId: 'old-fish', anchorId: 'old-anchor', sessionId: 'old-session', mode: 'demo' }],
      ['messages', { id: 'old-message', sessionId: 'old-session', taskId: 'old-task', content: '旧模拟回复' }],
      ['tasks', { id: 'orphan-task', fishId: 'removed-fish', sessionId: 'orphan-session', mode: 'demo' }],
      ['sessions', { id: 'orphan-session', fishId: 'removed-fish' }],
      ['messages', { id: 'orphan-message', sessionId: 'orphan-session', taskId: 'orphan-task' }],
    ] as const;
    for (const [kind, value] of legacy) store.db.prepare('INSERT INTO records VALUES(?,?,?)').run(kind, value.id, JSON.stringify(value));
    store.db.prepare('UPDATE settings SET data=? WHERE id=1').run(JSON.stringify({ ...store.settings(), mode: 'demo', liveEnabled: true }));
    store.db.exec('PRAGMA user_version=1'); store.close(); store = undefined;
    store = new Store(folder);
    assert.deepEqual(store.all('fish').map(f => [f.id, f.enabled]), [['real-fish', false]]);
    assert.deepEqual(store.all('anchors').map(a => a.id), ['real-anchor']);
    assert.deepEqual(store.all('tasks').map(t => [t.id, t.queryRpid, t.result]), [[task.id, '9007199254740993124', '保留原文回复']]);
    assert.deepEqual(store.all('sessions').map(s => s.id), [task.sessionId]);
    assert.equal(store.all('messages').length, 2);
    assert.equal(store.settings().mode, 'bilibili'); assert.equal(store.settings().liveEnabled, false);
    assert.equal(store.secrets.apiKey, key); assert.equal(store.secrets.cookie, 'MIGRATION_PRIVATE_COOKIE');
    const files = readdirSync(join(folder, 'archive')); assert.equal(files.length, 1);
    const archiveText = readFileSync(join(folder, 'archive', files[0]), 'utf8');
    assert.equal(JSON.parse(archiveText).records.length, legacy.length);
    assert.equal(archiveText.includes(key), false); assert.equal(archiveText.includes('MIGRATION_PRIVATE_COOKIE'), false);
    store.close(); store = undefined; store = new Store(folder);
    assert.equal(readdirSync(join(folder, 'archive')).length, 1);
    assert.equal(store.all('tasks')[0].result, '保留原文回复');
  } finally {
    store?.close(); assert.equal(dirname(resolve(folder)), resolve(tmpdir())); assert.match(basename(folder), /^fish-relay-test-/); rmSync(folder, { recursive: true });
  }
});

test('HTTP API auth, CSRF checks, import, SSE and idempotent replies work end to end', async () => {
  const { store, bili, fish } = setupLive();
  bili.answer = { text: '来自上游的原文回复', rpid: '9007199254740993125' };
  store.saveSettings({ ...store.settings(), pollSeconds: 0, cooldownSeconds: 0 });
  const { app, engine } = createApp(store, bili); const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); engine.start();
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const ui = { 'X-Fish-UI': '1', 'Content-Type': 'application/json' }, auth = { Authorization: `Bearer ${store.secrets.apiKey}`, 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(base + '/api/overview')).status, 403);
    assert.equal((await fetch(base + '/api/overview', { headers: { ...ui, Origin: 'https://untrusted.example' } })).status, 403);
    assert.equal((await fetch(base + '/v1/models')).status, 401);
    const models = await (await fetch(base + '/v1/models', { headers: auth })).json(); assert.equal(models.data[0].id, 'fish-auto');
    const imported = await (await fetch(base + '/api/fish/import', { method: 'POST', headers: ui, body: JSON.stringify({ text: '667788,薄荷\n667788,重复' }) })).json(); assert.deepEqual(imported, { added: 1, skipped: 1 });
    const rejectedMode = await fetch(base + '/api/fish', { method: 'POST', headers: ui, body: JSON.stringify({ uid: '123', name: '无效模式', platform: 'demo' }) }); assert.equal(rejectedMode.status, 400);
    const rejectedUid = await fetch(base + '/api/fish', { method: 'POST', headers: ui, body: JSON.stringify({ uid: 'demo-1', name: '无效 UID' }) }); assert.equal(rejectedUid.status, 400);
    const rejectedSettings = await fetch(base + '/api/settings', { method: 'PUT', headers: ui, body: JSON.stringify({ ...store.settings(), pollSeconds: 15, cooldownSeconds: 60, mode: 'demo' }) }); assert.equal(rejectedSettings.status, 400); assert.match((await rejectedSettings.json()).error.message, /mode/);
    assert.equal(store.settings().mode, 'bilibili');
    const body = JSON.stringify({ model: 'fish-auto', fish_uid: fish.uid, messages: [{ role: 'user', content: 'test' }] });
    const response = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { ...auth, 'Idempotency-Key': 'http-one' }, body });
    assert.equal(response.status, 200); const reply = await response.json(); assert.equal(reply.choices[0].message.content, bili.answer.text); assert.equal(reply.fish.mode, 'bilibili'); assert.equal(reply.fish.uid, fish.uid); assert.equal(bili.sent.length, 1);
    const repeat = await (await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { ...auth, 'Idempotency-Key': 'http-one' }, body })).json(); assert.equal(repeat.id, reply.id); assert.equal(bili.sent.length, 1);
    const stream = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: auth, body: JSON.stringify({ model: 'fish-auto', fish_uid: fish.uid, stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
    assert.match(stream.headers.get('content-type')!, /text\/event-stream/); const events = await stream.text(); assert.match(events, /chat.completion.chunk/); assert.match(events, /data: \[DONE\]/); assert.equal(bili.sent.length, 2);
    const unsupported = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: auth, body: JSON.stringify({ model: 'fish-auto', messages: [{ role: 'user', content: 'hi' }], tools: [] }) }); assert.equal(unsupported.status, 400);
    const exported = await (await fetch(base + '/api/export', { headers: ui })).text(); assert.equal(exported.includes(store.secrets.apiKey), false);
  } finally { engine.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});
