import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Store } from './store.js';
import { createApp } from './app.js';

const directory = resolve(process.env.FISH_DATA_DIR ?? 'data');
mkdirSync(directory, { recursive: true });
const lock = join(directory, 'server.lock');
if (existsSync(lock)) {
  const pid = Number(readFileSync(lock, 'utf8'));
  let running = false;
  if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, 0); running = true; } catch {} }
  if (running) throw new Error('此数据目录已被另一实例使用，请打开正在运行的页面');
  unlinkSync(lock);
}
const descriptor = openSync(lock, 'wx'); writeFileSync(descriptor, String(process.pid)); closeSync(descriptor);
const store = new Store(directory), { app, engine } = createApp(store);
const port = Number(process.env.PORT ?? 4173);
const server = app.listen(port, '127.0.0.1', () => { engine.start(); console.log(`大肥鱼中转站已启动：http://127.0.0.1:${port}`); });
function shutdown() { engine.stop(); server.close(); store.close(); if (existsSync(lock) && readFileSync(lock, 'utf8') === String(process.pid)) unlinkSync(lock); }
server.on('error', (error) => { shutdown(); console.error(error.message); process.exit(1); });
process.once('SIGINT', () => { shutdown(); process.exit(0); });
process.once('SIGTERM', () => { shutdown(); process.exit(0); });
