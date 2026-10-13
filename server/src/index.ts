import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from './db.js';
import { buildServer } from './api.js';
import { seedIfEmpty } from './seed.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dataDir = path.join(root, 'data');
mkdirSync(dataDir, { recursive: true });

const db = createDb(path.join(dataDir, 'app.db'));
seedIfEmpty(db);

const app = buildServer(db, { schedulerIntervalMs: 15_000 });
const scheduler = (app as any).scheduler as { start(): void };
scheduler.start();

const PORT = Number(process.env.PORT ?? 8787);
app.listen({ port: PORT, host: '127.0.0.1' }).then(() => {
  console.log(`⏱ 5分钟 server running → http://127.0.0.1:${PORT}`);
  console.log('   承诺调度器已启动（15s 扫描一轮）');
});
