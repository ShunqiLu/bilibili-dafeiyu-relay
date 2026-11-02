import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Fish, Anchor, Task, Session, Message, Settings, PublicSettings } from '../shared/types.js';

export const defaults: Settings = { mode: 'bilibili', pollSeconds: 15, timeoutSeconds: 180, cooldownSeconds: 60, dailyLimit: 20, autoCleanup: false, cleanupDelaySeconds: 60, liveEnabled: false };
type Entities = { fish: Fish; anchors: Anchor; tasks: Task; sessions: Session; messages: Message };
interface Secrets { apiKey: string; cookie: string; accountUid: string; accountName: string; }

export class Store {
  db: DatabaseSync;
  secrets: Secrets;
  constructor(readonly directory: string) {
    if (directory !== ':memory:') mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(directory === ':memory:' ? ':memory:' : join(directory, 'fish.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);`);
    this.secrets = { apiKey: 'fish_' + randomBytes(24).toString('hex'), cookie: '', accountUid: '', accountName: '' };
    const secretsFile = join(directory, 'credentials.json');
    if (directory !== ':memory:' && existsSync(secretsFile)) this.secrets = JSON.parse(readFileSync(secretsFile, 'utf8'));
    this.saveSecrets();
    if (!this.db.prepare('SELECT id FROM settings').get()) this.saveSettings(defaults);
    this.migrate();
  }
  saveSecrets() {
    if (this.directory !== ':memory:') writeFileSync(join(this.directory, 'credentials.json'), JSON.stringify(this.secrets, null, 2), { mode: 0o600 });
  }
  settings(): Settings { return { ...JSON.parse(String(this.db.prepare('SELECT data FROM settings WHERE id=1').get()!.data)), mode: 'bilibili' }; }
  saveSettings(settings: Settings) { this.db.prepare('INSERT OR REPLACE INTO settings VALUES(1,?)').run(JSON.stringify({ ...settings, mode: 'bilibili' })); }
  publicSettings(): PublicSettings { return { ...this.settings(), cookieConfigured: !!this.secrets.cookie, apiKeyHint: this.secrets.apiKey.slice(0, 9) + '…' + this.secrets.apiKey.slice(-4), accountUid: this.secrets.accountUid, accountName: this.secrets.accountName }; }
  all<K extends keyof Entities>(kind: K): Entities[K][] { return this.db.prepare('SELECT data FROM records WHERE kind=?').all(kind).map(row => JSON.parse(String(row.data))); }
  get<K extends keyof Entities>(kind: K, id: string): Entities[K] | undefined { const row = this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind, id); return row ? JSON.parse(String(row.data)) : undefined; }
  put<K extends keyof Entities>(kind: K, value: Entities[K]): Entities[K] { this.db.prepare('INSERT OR REPLACE INTO records VALUES(?,?,?)').run(kind, value.id, JSON.stringify(value)); return value; }
  remove(kind: keyof Entities, id: string) { this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id); }
  transaction<T>(action: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = action(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  patchTask(id: string, patch: Partial<Task>) { const task = this.get('tasks', id); if (!task) throw new Error('任务不存在'); return this.put('tasks', { ...task, ...patch, updatedAt: Date.now() }); }
  message(task: Task, role: Message['role'], content: string) { return this.put('messages', { id: randomUUID(), taskId: task.id, sessionId: task.sessionId, role, content, createdAt: Date.now() }); }
  private migrate() {
    const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
    if (version >= 2) return;
    // Keep a local archive while removing data produced by the retired demo runtime.
    type LegacyRecord = { id: string; [field: string]: unknown };
    const records = this.db.prepare('SELECT kind,data FROM records').all().map(row => ({ kind: String(row.kind), data: JSON.parse(String(row.data)) as LegacyRecord }));
    const fishIds = new Set(records.filter(r => r.kind === 'fish' && (r.data.platform === 'demo' || String(r.data.uid).startsWith('demo-'))).map(r => r.data.id));
    const anchorIds = new Set(records.filter(r => r.kind === 'anchors' && (r.data.source === 'demo' || fishIds.has(String(r.data.fishId)))).map(r => r.data.id));
    const legacyTasks = records.filter(r => r.kind === 'tasks' && (r.data.mode === 'demo' || fishIds.has(String(r.data.fishId)) || anchorIds.has(String(r.data.anchorId))));
    const taskIds = new Set(legacyTasks.map(r => r.data.id));
    const legacySessionIds = new Set(legacyTasks.map(r => String(r.data.sessionId)));
    const realSessionIds = new Set(records.filter(r => r.kind === 'tasks' && !taskIds.has(r.data.id)).map(r => String(r.data.sessionId)));
    const sessionIds = new Set(records.filter(r => r.kind === 'sessions' && !realSessionIds.has(r.data.id) && (r.data.platform === 'demo' || fishIds.has(String(r.data.fishId)) || legacySessionIds.has(r.data.id))).map(r => r.data.id));
    const retired = records.filter(r => r.kind === 'fish' ? fishIds.has(r.data.id) : r.kind === 'anchors' ? anchorIds.has(r.data.id) : r.kind === 'tasks' ? taskIds.has(r.data.id) : r.kind === 'sessions' ? sessionIds.has(r.data.id) : r.kind === 'messages' && (taskIds.has(String(r.data.taskId)) || sessionIds.has(String(r.data.sessionId))));
    if (retired.length && this.directory !== ':memory:') {
      const archive = join(this.directory, 'archive');
      mkdirSync(archive, { recursive: true });
      writeFileSync(join(archive, `retired-demo-${Date.now()}.json`), JSON.stringify({ archivedAt: new Date().toISOString(), records: retired }, null, 2));
    }
    const saved = JSON.parse(String(this.db.prepare('SELECT data FROM settings WHERE id=1').get()!.data));
    this.transaction(() => {
      for (const record of retired) this.remove(record.kind as keyof Entities, record.data.id);
      this.saveSettings({ ...defaults, ...saved, mode: 'bilibili', liveEnabled: saved.mode === 'bilibili' && saved.liveEnabled === true });
      this.db.exec('PRAGMA user_version=2');
    });
  }
  close() { this.db.close(); }
}
