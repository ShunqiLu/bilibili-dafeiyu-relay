import React, { useState, useEffect, useCallback, useRef, useId, memo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Fish as FishIcon, SquaresFour, ChatCircleDots, ListBullets, PlugsConnected, GearSix, ArrowUpRight, ArrowRight, Plus, MagnifyingGlass, ArrowClockwise, Check, X, CaretRight, Copy, Trash, Pause, Play, DownloadSimple, UploadSimple, TerminalWindow, Clock, Waves, Link as LinkIcon, PaperPlaneTilt, ShieldCheck, WarningCircle, CheckSquare, BookOpen, CaretDown } from '@phosphor-icons/react';
import type { Overview, Fish, Anchor, Message, Task, Session, PublicSettings, Settings } from '../shared/types';
import './styles.css';
import './blue-theme.css';

type Page = 'overview' | 'fish' | 'chat' | 'history' | 'api' | 'settings';
const pageInfo: Record<Page, string> = {
  overview: '大肥鱼中转站',
  fish: 'UID 名单',
  chat: '对话',
  history: '评论记录',
  api: 'API 接入',
  settings: '设置',
};
const nav = [{ key: 'overview', label: '首页', icon: SquaresFour }, { key: 'fish', label: 'UID 名单', icon: FishIcon }, { key: 'chat', label: '对话', icon: ChatCircleDots }, { key: 'history', label: '评论记录', icon: ListBullets }, { key: 'api', label: 'API 接入', icon: PlugsConnected }, { key: 'settings', label: '设置', icon: GearSix }] as const;
async function api<T>(path: string, body?: unknown, method?: string): Promise<T> { const response = await fetch('/api' + path, { method: method ?? (body !== undefined ? 'POST' : 'GET'), headers: { 'X-Fish-UI': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined }); const data = await response.json(); if (!response.ok) throw new Error(data.error?.message ?? '请求未完成'); return data; }
const date = (ms: number) => new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai', hour12: false });
const statusNames: Record<string, string> = { queued: '排队中', posting: '发送中', waiting: '等待回复', completed: '已收到回复', failed: '未完成', cancelled: '已停止', interrupted: '待核对' };
const plainText = (value: string) => value.replaceAll('。', '；').replace(/[；.]$/, '');
const cleanupNames: Record<string, string> = { none: '保留评论', pending: '等待清理', deleting: '清理中', deleted: '已清理', failed: '清理失败' };
function Status({ task }: { task: Task }) { return <span className={`status ${task.status}`}><i />{statusNames[task.status]}</span>; }
function Avatar({ small = false }: { fish?: { name: string; platform?: string }; small?: boolean }) {
  return <span className={`avatar picture-avatar ${small ? 'small' : ''}`}><img src="/assets/deepseek-avatar.png" alt="" draggable={false} decoding="async" /></span>;
}
function Empty({ icon, title, text, children }: { icon?: ReactNode; title: string; text?: string; children?: ReactNode }) { return <div className="empty"><div className="empty-icon">{icon ?? <Waves size={32} weight="duotone" />}</div><h3>{title}</h3>{text && <p>{text}</p>}{children}</div>; }
function Modal({ title, description, children, close, wide = false }: { title: string; description?: string; children: ReactNode; close: () => void; wide?: boolean }) { const ref = useRef<HTMLDialogElement>(null); useEffect(() => { const el = ref.current!; el.showModal(); return () => el.close(); }, []); return <dialog ref={ref} className={`modal ${wide ? 'wide' : ''}`} onCancel={close} onClick={e => { if (e.target === e.currentTarget) close(); }}><div className="modal-head"><div><h2>{title}</h2>{description && <p>{description}</p>}</div><button className="icon-btn" aria-label="关闭" onClick={close}><X size={20} /></button></div>{children}</dialog>; }
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const id = useId();
  const control = React.isValidElement(children) && ['input', 'textarea', 'select'].includes(String(children.type));
  const child = control ? React.cloneElement(children as React.ReactElement<{ id?: string; 'aria-describedby'?: string }>, { id, 'aria-describedby': hint ? id + '-hint' : undefined }) : children;
  return <div className="field">{control ? <label htmlFor={id}>{label}</label> : <span>{label}</span>}{child}{hint && <small id={id + '-hint'}>{hint}</small>}</div>;
}
function Switch({ checked, onChange, label, text }: { checked: boolean; onChange: (value: boolean) => void; label: string; text?: string }) { return <div className="switch-row"><div><strong>{label}</strong>{text && <p>{text}</p>}</div><button type="button" role="switch" aria-checked={checked} aria-label={label} className={`switch ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}><span /></button></div>; }
function CopyButton({ text, label = '复制' }: { text: string; label?: string }) { const [done, setDone] = useState(false); return <button className="btn small" onClick={async () => { try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1800); } catch { setDone(false); } }}>{done ? <Check size={15} /> : <Copy size={15} />}{done ? '已复制' : label}</button>; }
const Mascot = memo(function Mascot({ className = '', decorative = false }: { className?: string; decorative?: boolean }) {
  return <img src="/assets/deepseek-chan.png" className={`mascot-image ${className}`} alt={decorative ? '' : 'DeepSeek Q版看板娘'} draggable={false} decoding="async" />;
});

function App() {
  const getPage = (): Page => (Object.keys(pageInfo).includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview') as Page;
  const [page, setPage] = useState<Page>(getPage), [data, setData] = useState<Overview>(), [loadError, setLoadError] = useState(''), [toast, setToast] = useState(''), [busy, setBusy] = useState(false), [sessionId, setSessionId] = useState(''), [targetFish, setTargetFish] = useState('');
  const refresh = useCallback(async () => { try { setData(await api<Overview>('/overview')); setLoadError(''); } catch (e) { setLoadError((e as Error).message); } }, []);
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 2200); const hash = () => setPage(getPage()); window.addEventListener('hashchange', hash); return () => { clearInterval(timer); window.removeEventListener('hashchange', hash); }; }, [refresh]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 5500); return () => clearTimeout(timer); }, [toast]);
  const go = (next: Page) => { location.hash = next; setPage(next); };
  const run = async (fn: () => Promise<unknown>, success?: string) => { setBusy(true); try { await fn(); if (success) setToast(success); await refresh(); } catch (e) { setToast((e as Error).message); } finally { setBusy(false); } };
  const chat = (fishId = '', id = '') => { setTargetFish(fishId); setSessionId(id); go('chat'); };
  const title = pageInfo[page];
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#overview"><span className="brand-mark"><img src="/assets/deepseek-avatar.png" className="brand-avatar" alt="" draggable={false} /></span><span>大肥鱼中转站</span></a>

        <nav>{nav.map(item => (
          <button key={item.key} aria-label={item.label} className={page === item.key ? 'selected' : ''} onClick={() => go(item.key)}>
            <item.icon size={20} weight={page === item.key ? 'fill' : 'regular'} /><span>{item.label}</span>
            {item.key === 'history' && !!data?.counts.waiting && <b>{data.counts.waiting}</b>}
          </button>
        ))}</nav>
        <div className="sidebar-foot">
          <a className="sidebar-help" href="#api"><BookOpen size={17} /> 接入说明 <ArrowUpRight size={15} /></a>
          <div className="workspace"><div className="workspace-icon"><TerminalWindow size={19} /></div><span>本地运行<small><i />{loadError ? '连接中' : '服务已启动'}</small></span><span className="version">v0.1</span></div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div><span className="breadcrumb">工作台</span><CaretRight size={13} /><span>{title}</span></div>
          <div className="top-actions"><button className="mode-badge" onClick={() => go('settings')}><span className={`mode-dot ${data?.settings.cookieConfigured ? 'real' : ''}`} />{data?.settings.cookieConfigured ? 'B 站已连接' : 'B 站未连接'}<CaretDown size={13} /></button><button className="icon-btn" aria-label="刷新数据" disabled={busy} onClick={() => void refresh()}><ArrowClockwise size={19} /></button></div>
        </header>
        <div className="page-content">
          <div className="page-heading"><div><h1>{title}</h1></div></div>
          {loadError && <div className="notice danger" role="alert"><WarningCircle size={18} />连接失败：{plainText(loadError)}<button onClick={() => void refresh()}>重试</button></div>}
          {!data ? <div className="loading-state"><div /><div /><div /><p>加载中</p></div> : <>
            {page === 'overview' && <OverviewPage data={data} go={go} chat={chat} />}
            {page === 'fish' && <FishPage data={data} run={run} busy={busy} chat={chat} />}
            {page === 'chat' && <ChatPage data={data} run={run} busy={busy} sessionId={sessionId} setSessionId={setSessionId} targetFish={targetFish} setTargetFish={setTargetFish} />}
            {page === 'history' && <HistoryPage data={data} run={run} chat={chat} busy={busy} />}
            {page === 'api' && <ApiPage data={data} run={run} />}
            {page === 'settings' && <SettingsPage settings={data.settings} run={run} busy={busy} />}
          </>}
        </div>
      </main>
      {toast && <div className="toast" role="status"><div>{plainText(toast)}</div><button aria-label="关闭提示" onClick={() => setToast('')}><X size={16} /></button></div>}
    </div>
  );
}

function OverviewPage({ data, go, chat }: { data: Overview; go: (page: Page) => void; chat: (fishId?: string, sessionId?: string) => void }) {
  const [picked, setPicked] = useState('');
  const fish = data.fish;
  const available = fish.filter(f => f.enabled);
  const selected = available.some(f => f.id === picked) ? picked : available[0]?.id ?? '';
  const tasks = data.tasks;
  const stats = [
    { label: '可用账号', value: available.length, icon: FishIcon },
    { label: '已回复', value: tasks.filter(t => t.status === 'completed').length, icon: ChatCircleDots },
    { label: '等待中', value: tasks.filter(t => ['queued', 'posting', 'waiting'].includes(t.status)).length, icon: Clock },
    { label: '已清理', value: tasks.filter(t => t.cleanupStatus === 'deleted').length, icon: CheckSquare },
  ];
  return <>
    <section className="workbench-banner">
      <img className="banner-background" src="/assets/dashboard-ocean.png" alt="" />
      <div className="banner-copy">
        <h2>开始对话</h2>
        <div className="quick-start">
          <select aria-label="快速选择账号" value={selected} onChange={e => setPicked(e.target.value)}>{available.length ? available.map(f => <option value={f.id} key={f.id}>{f.name}</option>) : <option value="">暂无可用账号</option>}</select>
          <button className="btn primary" disabled={!selected} onClick={() => chat(selected)}>新建对话 <ArrowRight size={16} /></button>
        </div>
      </div>
      <Mascot className="banner-mascot" />
    </section>
    <section className="stats">{stats.map(stat => <div className="stat" key={stat.label}><div className="stat-top"><span>{stat.label}</span><stat.icon size={18} /></div><div className="stat-number">{stat.value}</div></div>)}</section>
    <div className="dashboard-grid">
      <section className="panel recent-panel"><div className="panel-heading"><h2>最近对话</h2><button className="text-btn" onClick={() => go('history')}>全部记录 <ArrowRight size={15} /></button></div>
        {tasks.length ? <div className="recent-list">{tasks.slice(0, 5).map(task => <button key={task.id} className="recent-row" onClick={() => chat(task.fishId, task.sessionId)}><Avatar fish={{ name: task.fishName || '', platform: task.mode }} small /><div><strong>{task.prompt}</strong><small>{task.fishName}<span>·</span>{date(task.createdAt)}</small></div><Status task={task} /><CaretRight size={16} /></button>)}</div> : <Empty title="暂无对话" icon={<ChatCircleDots size={29} weight="duotone" />} />}
      </section>
      <section className="panel pond-panel"><div className="panel-heading"><h2>UID 名单 <span className="count-pill">{fish.length}</span></h2><button className="icon-btn" aria-label="管理名单" onClick={() => go('fish')}><ArrowUpRight size={18} /></button></div>
        <div className="pond-list">{fish.slice(0, 4).map(f => <button className="pond-row" key={f.id} onClick={() => f.enabled ? chat(f.id) : go('fish')}><Avatar fish={f} /><span><strong>{f.name}</strong><small>UID {f.uid}</small></span><span className="fish-state"><i className={!f.enabled ? 'off' : ''} />{f.enabled ? '已启用' : '已暂停'}</span></button>)}{!fish.length && <p className="empty-mini">暂无账号</p>}</div>
        <button className="add-pond" onClick={() => go('fish')}><Plus size={15} /> 管理名单</button>
      </section>
    </div>
  </>;
}

type Run = (fn: () => Promise<unknown>, success?: string) => Promise<void>;
function FishPage({ data, run, busy, chat }: { data: Overview; run: Run; busy: boolean; chat: (fishId?: string, sessionId?: string) => void }) {
  const [search, setSearch] = useState(''), [modal, setModal] = useState<'add' | 'import' | null>(null), [editing, setEditing] = useState<Fish>(), [selected, setSelected] = useState<Fish>();
  const fish = data.fish.filter(f => `${f.uid} ${f.name} ${f.note}`.toLowerCase().includes(search.toLowerCase()));
  return <><div className="toolbar"><div className="search-input"><MagnifyingGlass size={18} /><input aria-label="搜索名单" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索 UID、昵称或备注…" /></div><span className="toolbar-count">{fish.length} 个账号</span><button className="btn" onClick={() => setModal('import')}><UploadSimple size={16} /> 批量导入</button><button className="btn primary" onClick={() => setModal('add')}><Plus size={17} /> 添加 UID</button></div><section className="panel table-panel"><div className="table-scroll"><table><thead><tr><th>账号 / UID</th><th>备注</th><th>评论入口</th><th>状态</th><th className="right">操作</th></tr></thead><tbody>{fish.map(f => <tr key={f.id}><td><div className="account-cell"><Avatar fish={f} /><div><strong>{f.name}</strong><small className="mono">{f.uid}</small></div></div></td><td className="note-cell">{f.note ? plainText(f.note) : '—'}</td><td><button className="inline-link" onClick={() => setSelected(f)}>{f.anchorCount ?? 0} 条公开评论 <ArrowUpRight size={13} /></button></td><td><span className={`status ${f.enabled ? 'completed' : 'cancelled'}`}><i />{f.enabled ? '已启用' : '已暂停'}</span></td><td><div className="row-actions"><button className="btn small" onClick={() => setSelected(f)}>评论入口</button><button className="icon-btn" aria-label={`与${f.name}对话`} onClick={() => chat(f.id)}><ChatCircleDots size={18} /></button><button className="icon-btn" aria-label={`编辑${f.name}`} onClick={() => setEditing(f)}><GearSix size={18} /></button><button className="icon-btn" aria-label={f.enabled ? `暂停${f.name}` : `启用${f.name}`} disabled={busy} onClick={() => void run(() => api(`/fish/${f.id}`, { enabled: !f.enabled }, 'PATCH'))}>{f.enabled ? <Pause size={17} /> : <Play size={17} />}</button></div></td></tr>)}</tbody></table></div>{!fish.length && <Empty title={search ? '没有匹配的账号' : '暂无账号'} text={search ? '调整 UID 或昵称重新搜索' : '添加 UID 后导入评论入口'}><button className="btn primary" onClick={() => setModal('add')}><Plus size={16} /> 添加 UID</button></Empty>}</section>{(modal === 'add' || editing) && <Modal title={editing ? '编辑账号' : '添加 UID'} close={() => { setModal(null); setEditing(undefined); }}><FishForm fish={editing} busy={busy} onSubmit={async values => { await run(async () => { if (editing) await api(`/fish/${editing.id}`, { name: values.name, note: values.note }, 'PATCH'); else await api('/fish', { ...values, platform: data.settings.mode }); setModal(null); setEditing(undefined); }, '名单已保存'); }} />{editing && <button className="danger-link" disabled={busy} onClick={() => { if (confirm(`从本地名单移除「${editing.name}」？已有对话台账会保留`)) void run(async () => { await api(`/fish/${editing.id}`, undefined, 'DELETE'); setEditing(undefined); }, '已从本地名单移除'); }}><Trash size={16} /> 从本地名单移除</button>}</Modal>}{modal === 'import' && <Modal title="批量导入 UID" description="每行填写 UID 或 UID,昵称" close={() => setModal(null)}><form onSubmit={e => { e.preventDefault(); const text = String(new FormData(e.currentTarget).get('text')); void run(async () => { const result = await api<{ added: number; skipped: number }>('/fish/import', { text, platform: data.settings.mode }); setModal(null); alert(`已添加 ${result.added} 个，跳过 ${result.skipped} 个重复 UID`); }); }}><Field label="UID 列表"><textarea name="text" rows={9} required placeholder={'一行一个 UID\n也支持 UID,昵称'} /></Field><div className="form-actions"><button type="button" className="btn" onClick={() => setModal(null)}>取消</button><button className="btn primary" disabled={busy}>导入名单</button></div></form></Modal>}{selected && <AnchorModal fish={selected} close={() => setSelected(undefined)} run={run} busy={busy} />}</>;
}
function FishForm({ fish, busy, onSubmit }: { fish?: Fish; busy: boolean; onSubmit: (values: { uid: string; name: string; note: string }) => Promise<void> }) { return <form onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); void onSubmit({ uid: String(f.get('uid') ?? fish?.uid ?? ''), name: String(f.get('name')), note: String(f.get('note')) }); }}><Field label="B 站 UID" hint="账号主页地址末尾的数字"><input name="uid" required defaultValue={fish?.uid} disabled={!!fish} placeholder="输入数字 UID" inputMode="numeric" maxLength={25} /></Field><Field label="显示昵称"><input name="name" required defaultValue={fish?.name} placeholder="输入显示昵称" maxLength={60} /></Field><Field label="备注"><textarea name="note" rows={3} defaultValue={fish?.note} placeholder="输入备注" maxLength={500} /></Field><div className="form-actions"><button className="btn primary" disabled={busy}>{busy ? '保存中…' : '保存'}</button></div></form>; }
function AnchorModal({ fish, close, run, busy }: { fish: Fish; close: () => void; run: Run; busy: boolean }) {
  const [anchors, setAnchors] = useState<Anchor[]>([]), [manual, setManual] = useState(false), [page, setPage] = useState(1), [error, setError] = useState('');
  const load = useCallback(async () => { try { setAnchors(await api<Anchor[]>(`/fish/${fish.id}/anchors`)); } catch (e) { setError((e as Error).message); } }, [fish.id]); useEffect(() => { void load(); }, [load]);
  return <Modal title={`${fish.name}的评论入口`} description={`UID ${fish.uid}`} close={close} wide><div className="anchor-toolbar"><a className="btn" target="_blank" rel="noreferrer" href={`https://www.aicu.cc/reply?uid=${encodeURIComponent(fish.uid)}`}>Aicu 网页查询 <ArrowUpRight size={15} /></a><div className="page-input"><span>第</span><input aria-label="索引页码" type="number" min="1" max="30" value={page} onChange={e => setPage(Number(e.target.value))} /><span>页</span></div><button className="btn" disabled={busy} onClick={() => void run(async () => { const result = await api<{ added: number; message: string }>(`/fish/${fish.id}/discover`, { page }); await load(); setError(result.message); })}><ArrowClockwise size={15} /> 查询并导入</button><button className="btn primary" onClick={() => setManual(!manual)}><Plus size={16} /> 手动入口</button></div>{error && <div className="notice">{plainText(error)}</div>}{manual && <form className="manual-form" onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); void run(async () => { await api(`/fish/${fish.id}/anchors`, Object.fromEntries(f.entries())); await load(); setManual(false); }, '入口已验证并添加'); }}><Field label="视频链接 / BV 号 / AID"><input name="video" required placeholder="粘贴视频地址或 av 号" /></Field><div className="form-grid"><Field label="目标评论 rpid"><input name="rpid" required inputMode="numeric" placeholder="目标 UID 发出的评论 ID" /></Field><Field label="根评论 root" hint="一级评论填 0；楼中楼填根评论 ID"><input name="root" defaultValue="0" required inputMode="numeric" /></Field></div><Field label="评论内容（选填）"><input name="message" placeholder="方便下次辨认这个入口" /></Field><button className="btn primary" disabled={busy}>验证原评论并添加</button></form>}<div className="anchor-list">{anchors.map(anchor => <div className="anchor-card" key={anchor.id}><div><span className="tag">{anchor.source === 'aicu' ? '公开索引' : '手动导入'}</span><small>{date(anchor.createdAt)}</small></div><p>{anchor.message || '无文本预览'}</p><div className="anchor-meta"><span className="mono">rpid {anchor.rpid}</span>{anchor.url && <a href={anchor.url} target="_blank" rel="noreferrer">打开原评论 <ArrowUpRight size={13} /></a>}<button className="icon-btn" aria-label="移除此入口" disabled={busy} onClick={() => void run(async () => { await api(`/anchors/${anchor.id}`, undefined, 'DELETE'); await load(); })}><Trash size={15} /></button></div></div>)}</div>{!anchors.length && <Empty title="暂无评论入口" text="查询公开索引或手动添加" />}</Modal>;
}

function ChatPage({ data, run, busy, sessionId, setSessionId, targetFish, setTargetFish }: { data: Overview; run: Run; busy: boolean; sessionId: string; setSessionId: (id: string) => void; targetFish: string; setTargetFish: (id: string) => void }) {
  const fish = data.fish.filter(f => f.enabled), [messages, setMessages] = useState<Message[]>([]), [input, setInput] = useState(''), [anchors, setAnchors] = useState<Anchor[]>([]), [anchorId, setAnchorId] = useState(''), [error, setError] = useState('');
  const selected = fish.find(f => f.id === targetFish) ?? fish[0];
  const sessions = data.sessions;
  const task = data.tasks.find(t => t.sessionId === sessionId), pending = !!task && ['queued', 'posting', 'waiting'].includes(task.status);
  const messageEnd = useRef<HTMLDivElement>(null);
  useEffect(() => { if (selected) { void api<Anchor[]>(`/fish/${selected.id}/anchors`).then(rows => { setAnchors(rows); setAnchorId(rows[0]?.id ?? ''); }).catch(e => setError(e.message)); } else { setAnchors([]); setAnchorId(''); } }, [selected?.id]);
  useEffect(() => { if (!sessionId) { setMessages([]); return; } let alive = true; const read = () => api<{ messages: Message[]; session: Session }>(`/sessions/${sessionId}`).then(result => { if (alive) { setMessages(result.messages); setTargetFish(result.session.fishId); setError(''); } }).catch(e => { if (alive) setError(e.message); }); void read(); const timer = setInterval(() => void read(), 1500); return () => { alive = false; clearInterval(timer); }; }, [sessionId, setTargetFish]);
  useEffect(() => { messageEnd.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [messages.length, pending]);
  const send = () => { if (!input.trim() || !selected || pending || busy) return; void run(async () => { const task = await api<Task>('/chat', { fishId: selected.id, anchorId, sessionId: sessionId || undefined, content: input.trim() }); setSessionId(task.sessionId); setTargetFish(selected.id); setInput(''); }); };
  return <section className="chat-layout panel"><aside className="session-list"><div className="session-head"><strong>对话记录</strong><button className="icon-btn" aria-label="新建对话" onClick={() => { setSessionId(''); setInput(''); }}><Plus size={19} /></button></div><button className={`new-session ${!sessionId ? 'active' : ''}`} onClick={() => setSessionId('')}><Plus size={17} /> 新建对话</button><div className="session-items">{sessions.map(session => <button key={session.id} className={session.id === sessionId ? 'active' : ''} onClick={() => { setSessionId(session.id); setTargetFish(session.fishId); }}><ChatCircleDots size={17} /><span><strong>{session.title}</strong><small>{session.fishName} · {date(session.updatedAt)}</small></span></button>)}</div></aside><div className="chat-main"><div className="chat-header"><Avatar fish={selected} /><div><strong>{selected?.name ?? '先添加一个账号'}</strong><small>{selected ? `UID ${selected.uid}` : '在名单中添加 UID'}</small></div><select aria-label="选择对话账号" value={selected?.id ?? ''} disabled={!!sessionId || pending} onChange={e => setTargetFish(e.target.value)}>{fish.length ? fish.map(f => <option value={f.id} key={f.id}>{f.name}</option>) : <option value="">暂无可用账号</option>}</select></div><div className="chat-feed">{!messages.length ? <div className="chat-welcome"><Mascot className="welcome-mascot" /><h2>新建对话</h2></div> : messages.map(message => <div className={`chat-message ${message.role}`} key={message.id}>{message.role === 'assistant' && <Avatar fish={selected} small />}<div><span>{message.role === 'user' ? '我' : selected?.name ?? '目标回复'} <small>{date(message.createdAt)}</small></span><div className="message-bubble">{message.content}</div></div></div>)}{pending && <div className="pending-message"><div className="typing"><i /><i /><i /></div><span>{task && statusNames[task.status]}</span></div>}{task && !pending && task.status !== 'completed' && <div className="notice danger"><WarningCircle size={18} />{plainText(task.error)}</div>}{error && <div className="notice danger">{plainText(error)}</div>}<div ref={messageEnd} /></div><div className="composer-area"><div className="entry-select"><LinkIcon size={14} /><span>评论入口</span><select aria-label="选择评论入口" value={anchorId} disabled={pending} onChange={e => setAnchorId(e.target.value)}>{anchors.length ? anchors.map(a => <option key={a.id} value={a.id}>{a.message.slice(0, 42)} · {a.rpid.slice(-9)}</option>) : <option value="">请先添加评论入口</option>}</select></div><div className="composer"><textarea aria-label="对话内容" value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} placeholder={pending ? '等待当前回复' : '写下想对它说的话…'} rows={3} maxLength={900} disabled={pending} /><div><small>Enter 发送 <span>·</span> Shift + Enter 换行</small>{pending && task ? <button className="btn small" disabled={busy || task.status === 'posting'} onClick={() => void run(() => api(`/tasks/${task.id}/cancel`, {}))}><Pause size={15} /> 停止等待</button> : <button className="btn primary" disabled={busy || !input.trim() || !anchorId || !selected} onClick={send}>发送 <PaperPlaneTilt size={17} /></button>}</div></div><div className="composer-foot"><ShieldCheck size={13} />内容会公开发布<span>{input.length} / 900</span></div></div></div></section>;
}

function HistoryPage({ data, run, chat, busy }: { data: Overview; run: Run; chat: (fishId?: string, sessionId?: string) => void; busy: boolean }) {
  const [filter, setFilter] = useState('all'), [selected, setSelected] = useState<Task>(); const tasks = data.tasks.filter(t => (filter === 'all' || (filter === 'waiting' ? ['waiting', 'posting', 'queued'].includes(t.status) : filter === 'cleaned' ? t.cleanupStatus === 'deleted' : t.status === filter)));
  const detail = selected ? data.tasks.find(t => t.id === selected.id) ?? selected : undefined;
  return <><div className="toolbar"><div className="tabs">{[['all', '全部评论'], ['waiting', '等待回复'], ['completed', '已回复'], ['failed', '未完成'], ['cleaned', '已清理']].map(([value, text]) => <button className={filter === value ? 'active' : ''} key={value} onClick={() => setFilter(value)}>{text}</button>)}</div><span className="toolbar-count">最近 {tasks.length} 条</span><button className="btn" onClick={() => void run(async () => { const content = JSON.stringify(await api('/export'), null, 2); const url = URL.createObjectURL(new Blob([content], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = `fish-relay-${new Date().toISOString().slice(0, 10)}.json`; a.click(); URL.revokeObjectURL(url); }, '已导出台账，不含登录凭证和 API Key')}><DownloadSimple size={16} /> 导出台账</button></div><section className="panel table-panel"><div className="table-scroll"><table><thead><tr><th>查询内容</th><th>目标账号</th><th>状态</th><th>评论清理</th><th>发起时间</th><th className="right">操作</th></tr></thead><tbody>{tasks.map(task => <tr key={task.id}><td><button className="task-query" onClick={() => setSelected(task)}><ChatCircleDots size={17} /><span>{task.prompt}</span></button></td><td><strong>{task.fishName}</strong><small className="cell-sub mono">{task.uid}</small></td><td><Status task={task} /></td><td><span className={`cleanup-state ${task.cleanupStatus === 'deleted' ? 'cleaned' : ''}`}>{task.cleanupStatus === 'deleted' && <Check size={14} />}{cleanupNames[task.cleanupStatus]}</span></td><td className="mono muted">{date(task.createdAt)}</td><td><div className="row-actions"><button className="btn small" onClick={() => setSelected(task)}>详情</button><button className="icon-btn" aria-label="打开对话" onClick={() => chat(task.fishId, task.sessionId)}><ArrowUpRight size={18} /></button></div></td></tr>)}</tbody></table></div>{!tasks.length && <Empty title="暂无评论记录" />}</section><div className="history-note"><ShieldCheck size={17} />清理查询评论后，本地回复仍保留</div>{detail && <Modal title="评论详情" description={`任务 ${detail.id.slice(0, 8)} · ${date(detail.createdAt)}`} close={() => setSelected(undefined)} wide><div className="detail-status"><Status task={detail} /><span>{detail.fishName} / UID {detail.uid}</span></div><div className="detail-block"><small>发出的问题</small><p>{detail.prompt}</p>{detail.payload !== detail.prompt && <details><summary>查看实际发送的上下文</summary><pre>{detail.payload}</pre></details>}</div><div className="detail-block mint"><small>收到的原文回复</small><p>{detail.result || plainText(detail.error) || '还没有收到回复'}</p></div><dl className="detail-grid"><div><dt>查询评论 ID</dt><dd>{detail.queryRpid || '尚未取得回执'}</dd></div><div><dt>回复评论 ID</dt><dd>{detail.replyRpid || '还未收到'}</dd></div><div><dt>清理状态</dt><dd>{cleanupNames[detail.cleanupStatus]}</dd></div><div><dt>发送时间</dt><dd>{detail.sentAt ? date(detail.sentAt) : '尚未发送'}</dd></div></dl>{detail.cleanupError && <div className="notice danger">{plainText(detail.cleanupError)}</div>}<div className="form-actions">{detail.queryRpid && <a className="btn" target="_blank" rel="noreferrer" href={`https://www.bilibili.com/video/av${detail.oid}/#reply${detail.queryRpid}`}>查看原评论 <ArrowUpRight size={15} /></a>}{['queued', 'waiting'].includes(detail.status) && <button className="btn" disabled={busy} onClick={() => void run(() => api(`/tasks/${detail.id}/cancel`, {}))}>停止等待</button>}{detail.status === 'completed' && !['deleted', 'deleting'].includes(detail.cleanupStatus) && <button className="btn danger" disabled={busy} onClick={() => { if (confirm('清理这条已收到回复的查询评论？原平台上的这条查询评论会删除，本地台账与收到的回复会保留')) void run(() => api(`/tasks/${detail.id}/cleanup`, {}), '查询评论已清理'); }}><Trash size={15} /> 清理查询评论</button>}</div></Modal>}</>;
}

function ApiPage({ data, run }: { data: Overview; run: Run }) {
  const [key, setKey] = useState(''), [show, setShow] = useState(false), [tab, setTab] = useState<'curl' | 'python' | 'javascript'>('curl');
  const base = location.port === '5173' ? 'http://127.0.0.1:4173/v1' : location.origin + '/v1';
  useEffect(() => { void api<{ key: string }>('/key').then(r => setKey(r.key)); }, []);
  const sampleKey = 'YOUR_FISH_API_KEY';
  const snippets = { curl: `curl ${base}/chat/completions \\\n  -H "Authorization: Bearer ${sampleKey}" \\\n  -H "Content-Type: application/json" \\\n  -H "Idempotency-Key: unique-request-id" \\\n  -d '{"model":"fish-auto","messages":[{"role":"user","content":"test"}],"stream":false}'`, python: `from openai import OpenAI\n\nclient = OpenAI(\n    base_url="${base}",\n    api_key="${sampleKey}",\n    timeout=300.0,\n    max_retries=0,\n)\n\nreply = client.chat.completions.create(\n    model="fish-auto",\n    messages=[{"role": "user", "content": "test"}],\n    extra_headers={"Idempotency-Key": "unique-request-id"},\n)\nprint(reply.choices[0].message.content)`, javascript: `import OpenAI from "openai";\n\nconst client = new OpenAI({\n  baseURL: "${base}",\n  apiKey: "${sampleKey}",\n  timeout: 300_000,\n  maxRetries: 0,\n});\n\nconst reply = await client.chat.completions.create({\n  model: "fish-auto",\n  messages: [{ role: "user", content: "test" }],\n}, { headers: { "Idempotency-Key": "unique-request-id" } });\nconsole.log(reply.choices[0].message.content);` };
  return <>
    <section className="panel api-config">
      <div className="panel-heading"><h2>连接信息</h2></div>
      <div className="config-body">
        <Field label="Base URL"><div className="copy-field"><code>{base}</code><CopyButton text={base} /></div></Field>
        <Field label="API Key"><div className="copy-field"><code>{show ? key : data.settings.apiKeyHint}</code><button className="text-btn" onClick={() => setShow(!show)}>{show ? '隐藏' : '显示'}</button><CopyButton text={key} /></div></Field>
        <Field label="Model"><div className="copy-field"><code>fish-auto</code><CopyButton text="fish-auto" /></div><small>指定账号使用 fish-UID</small></Field>
        <div className="api-config-foot"><span><ShieldCheck size={15} /> 本机访问</span><button className="text-btn" onClick={() => { if (confirm('更换密钥后，原密钥立即失效；继续？')) void run(async () => { const result = await api<{ key: string }>('/key/rotate', {}); setKey(result.key); }, 'API Key 已更换'); }}>更换密钥 <ArrowClockwise size={14} /></button></div>
      </div>
    </section>
    <section className="code-panel">
      <div className="code-header"><div className="code-tabs">{(['curl', 'python', 'javascript'] as const).map(lang => <button key={lang} className={tab === lang ? 'active' : ''} onClick={() => setTab(lang)}>{lang === 'python' ? 'Python' : lang === 'javascript' ? 'JavaScript' : 'cURL'}</button>)}</div><CopyButton text={snippets[tab]} label="复制示例" /></div>
      <pre><code>{snippets[tab]}</code></pre>
    </section>
    <details className="api-details"><summary>接入提示</summary><ul><li>超时建议 300 秒，关闭 SDK 自动重试</li><li>重试沿用相同 Idempotency-Key</li><li>仅支持文本，收到评论回复后整段返回</li></ul></details>
  </>;
}

function SettingsPage({ settings, run, busy }: { settings: PublicSettings; run: Run; busy: boolean }) {
  const [draft, setDraft] = useState<Settings>(() => ({ ...settings })), [cookie, setCookie] = useState('');
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => setDraft(s => ({ ...s, [key]: value }));
  useEffect(() => { setDraft(s => ({ ...s, liveEnabled: settings.liveEnabled })); }, [settings.liveEnabled]);
  return <div className="settings-layout"><div>
    <section className="panel settings-section">
      <div className="panel-heading"><h2>连接 B 站账号</h2><span className={`status ${settings.cookieConfigured ? 'completed' : 'cancelled'}`}><i />{settings.cookieConfigured ? '已连接' : '未连接'}</span></div>
      <div className="settings-body">
        {settings.cookieConfigured && <div className="connected-account"><Avatar /><div><strong>{settings.accountName}</strong><small>UID {settings.accountUid}</small></div><button className="btn small" disabled={busy} onClick={() => void run(() => api('/account/check', {}), '连接有效')}>验证连接</button><button className="text-btn" disabled={busy} onClick={() => void run(() => api('/account', undefined, 'DELETE'), '已断开连接')}>断开</button></div>}
        <Field label="登录 Cookie" hint="需包含 SESSDATA 和 bili_jct"><textarea aria-label="登录 Cookie" value={cookie} onChange={e => setCookie(e.target.value)} rows={3} placeholder={settings.cookieConfigured ? '粘贴新 Cookie 以更换账号' : 'SESSDATA=…; bili_jct=…; DedeUserID=…'} autoComplete="off" className="secret-input" /></Field>
        <button className="btn" disabled={busy || !cookie.trim()} onClick={() => void run(async () => { await api('/account', { cookie }); setCookie(''); }, '已连接')}><LinkIcon size={16} /> 验证并连接</button>
        <Switch label="允许发送评论" checked={draft.liveEnabled} onChange={v => update('liveEnabled', v)} />
      </div>
    </section>
    <section className="panel settings-section">
      <div className="panel-heading"><h2>发送与清理</h2></div>
      <div className="settings-body">
        <div className="form-grid">
          <Field label="发送间隔（秒）" hint="所有 UID 共用，至少 60 秒"><input type="number" min="60" max="3600" value={draft.cooldownSeconds} onChange={e => update('cooldownSeconds', Number(e.target.value))} /></Field>
          <Field label="每日上限（条）" hint="按北京时间计算"><input type="number" min="1" max="100" value={draft.dailyLimit} onChange={e => update('dailyLimit', Number(e.target.value))} /></Field>
          <Field label="检查回复间隔（秒）"><input type="number" min="10" max="120" value={draft.pollSeconds} onChange={e => update('pollSeconds', Number(e.target.value))} /></Field>
          <Field label="最长等待（秒）"><input type="number" min="30" max="600" value={draft.timeoutSeconds} onChange={e => update('timeoutSeconds', Number(e.target.value))} /></Field>
        </div>
        <Switch label="收到回复后自动清理" text="仅清理查询评论，回复保留在本机" checked={draft.autoCleanup} onChange={v => update('autoCleanup', v)} />
        {draft.autoCleanup && <Field label="清理延迟（秒）"><input type="number" min="30" max="3600" value={draft.cleanupDelaySeconds} onChange={e => update('cleanupDelaySeconds', Number(e.target.value))} /></Field>}
      </div>
    </section>
    <div className="settings-save"><button className="btn primary" disabled={busy} onClick={() => void run(() => api('/settings', { mode: 'bilibili', pollSeconds: draft.pollSeconds, timeoutSeconds: draft.timeoutSeconds, cooldownSeconds: draft.cooldownSeconds, dailyLimit: draft.dailyLimit, autoCleanup: draft.autoCleanup, cleanupDelaySeconds: draft.cleanupDelaySeconds, liveEnabled: draft.liveEnabled }, 'PUT'), '设置已保存')}><Check size={17} /> 保存设置</button></div>
  </div></div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
