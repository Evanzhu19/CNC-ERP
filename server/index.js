import express from 'express';
import path from 'node:path';
import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db, BACKUP_DIR } from './db.js';
import { requireAuth } from './auth.js';
import { authRouter, basicsRouter } from './routes-basics.js';
import { ordersRouter, purgeExpiredVoidedOrders } from './routes-orders.js';
import { productionRouter } from './routes-production.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

const app = express();
app.use(express.json({ limit: '2mb' }));

app.use('/api', authRouter);
app.use('/api', requireAuth, basicsRouter);
app.use('/api', requireAuth, ordersRouter);
app.use('/api', requireAuth, productionRouter);

const distDir = path.join(__dirname, '..', 'web', 'dist');
if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

app.use((err, req, res, next) => {
  if (err) {
    console.error(err);
    const msg = err.code === 'LIMIT_FILE_SIZE' ? '文件太大（限50MB）' : (err.message || '服务器内部错误');
    return res.status(err.status || 500).json({ error: msg });
  }
  next();
});

function backup() {
  try {
    const stamp = new Date().toISOString().slice(0, 10);
    const file = path.join(BACKUP_DIR, `erp-${stamp}.sqlite`);
    if (!existsSync(file)) {
      db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
      console.log(`[备份] 已备份数据库到 ${file}`);
    }
    const files = readdirSync(BACKUP_DIR).filter(f => f.startsWith('erp-')).sort();
    while (files.length > 30) {
      const old = files.shift();
      unlinkSync(path.join(BACKUP_DIR, old));
    }
  } catch (e) {
    console.error('[备份] 失败：', e.message);
  }
}
backup();
setInterval(backup, 6 * 3600 * 1000);

try { purgeExpiredVoidedOrders(); } catch (e) { console.error('[清理] 启动清理失败:', e.message); }
setInterval(() => {
  try { purgeExpiredVoidedOrders(); } catch (e) { console.error('[清理] 定时清理失败:', e.message); }
}, 12 * 3600 * 1000);

setInterval(() => {
  try { db.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`).run(); } catch {}
}, 3600 * 1000);

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`CNC ERP 已启动：http://localhost:${PORT}（局域网内用本机IP访问）`);
});

// 优雅关机：停止接新请求 → 把 WAL 检查点写回主库 → 关库退出
let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[关机] 收到 ${sig}，正在保存数据…`);
  server.close(() => {
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      db.close();
      console.log('[关机] 数据库已安全关闭');
    } catch (e) {
      console.error('[关机] 关库出错:', e.message);
    }
    process.exit(0);
  });
  // 3秒内没关完（长连接挂着）也强制走人，库已checkpoint过
  setTimeout(() => {
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); } catch {}
    process.exit(0);
  }, 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
