import express from 'express';
import path from 'node:path';
import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db, BACKUP_DIR } from './db.js';
import { requireAuth } from './auth.js';
import { authRouter, basicsRouter } from './routes-basics.js';
import { ordersRouter, purgeExpiredVoidedOrders } from './routes-orders.js';
import { productionRouter } from './routes-production.js';
import { financeRouter } from './routes-finance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

const app = express();
app.use(express.json({ limit: '2mb' }));

// 财务账号只在财务板块活动：除财务台账/车辆/自身账号操作外，一律403（服务端强制，不是只藏菜单）
function financeScope(req, res, next) {
  if (req.user?.role !== 'finance') return next();
  const p = req.path;
  if (p.startsWith('/finance') || p.startsWith('/vehicles') || p === '/me' || p === '/me/password' || p === '/logout') {
    return next();
  }
  return res.status(403).json({ error: '财务账号只能访问财务板块' });
}

// 统一门户：ERP 挂在 /erp 前缀下（80端口网关反代过来带前缀）；
// /api 双挂载保持兼容，:3000 直连和网关两条路都通
for (const prefix of ['/api', '/erp/api']) {
  app.use(prefix, authRouter);
  app.use(prefix, requireAuth, financeScope, basicsRouter);
  app.use(prefix, requireAuth, financeScope, ordersRouter);
  app.use(prefix, requireAuth, financeScope, productionRouter);
  app.use(prefix, requireAuth, financeScope, financeRouter);
}

const distDir = path.join(__dirname, '..', 'web', 'dist');
if (existsSync(distDir)) {
  app.use('/erp', express.static(distDir));
  app.get(/^\/erp(\/.*)?$/, (req, res) => res.sendFile(path.join(distDir, 'index.html')));
  // 旧书签兼容：:3000/orders 之类的老地址 302 到 /erp 前缀下
  app.get(/^\/(?!api\/|erp\/|erp$).*/, (req, res) => res.redirect(302, '/erp' + (req.originalUrl === '/' ? '/' : req.originalUrl)));
}

// 全局错误处理：4xx 才把原文给用户；5xx 一律通用提示，内部细节（SQL语句、表名、
// 约束名、堆栈）只进服务端日志，绝不回传浏览器。
app.use((err, req, res, next) => {
  if (!err) return next();
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 400 : 500);
  if (status >= 500) {
    console.error(`[500] ${req.method} ${req.originalUrl} 用户=${req.user?.username || '未登录'}\n`, err);
    return res.status(500).json({ error: '服务器处理出错了，请重试；若反复出现请联系管理员' });
  }
  const msg = err.code === 'LIMIT_FILE_SIZE' ? '文件太大（图纸限50MB、Excel限30MB）' : (err.message || '请求有误');
  res.status(status).json({ error: msg });
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

// 兜底：任何漏网的异常都不许把整站带走（车间十几号人在用，一个人的误操作不能停所有人）。
// 记日志后继续服务；数据一致性由每个接口自己的事务保证，进程存活优先。
process.on('uncaughtException', (err, origin) => {
  console.error(`[未捕获异常/${origin}] 服务继续运行，请排查：\n`, err);
});
process.on('unhandledRejection', reason => {
  console.error('[未处理的Promise拒绝] 服务继续运行，请排查：\n', reason);
});
