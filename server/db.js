import { DatabaseSync } from 'node:sqlite';
import { scryptSync, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
mkdirSync(UPLOAD_DIR, { recursive: true });
mkdirSync(BACKUP_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'erp.sqlite'));
db.exec('PRAGMA journal_mode = WAL');
// FULL：每次事务提交都强制刷到磁盘（fsync），断电最多丢"还没点保存的"，
// 已返回成功的操作绝不丢失。NORMAL 模式断电可能丢最近几笔已提交事务，不可用。
db.exec('PRAGMA synchronous = FULL');
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','finance','cnc_manager','clerk','follower','programmer','outsourcer')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  contact TEXT, phone TEXT, address TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,
  contact TEXT, phone TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT UNIQUE NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  customer_po TEXT,
  order_date TEXT NOT NULL,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','closed','void')),
  remark TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  part_no TEXT,
  drawing_no TEXT,
  name TEXT,
  spec TEXT,
  material TEXT,
  qty INTEGER NOT NULL CHECK(qty > 0),
  unit_price REAL,
  remark TEXT
);
CREATE TABLE IF NOT EXISTS pieces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  piece_code TEXT UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS piece_stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  piece_id INTEGER NOT NULL REFERENCES pieces(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK(stage IN ('milling','cnc','grinding','plating_sent','plating_back','shipped')),
  done_date TEXT NOT NULL,
  note TEXT,
  recorded_by INTEGER REFERENCES users(id),
  recorded_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(piece_id, stage)
);
CREATE TABLE IF NOT EXISTS outsourcing (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_no TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  sent_date TEXT NOT NULL,
  expected_date TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','open','done')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS outsourcing_pieces (
  outsourcing_id INTEGER NOT NULL REFERENCES outsourcing(id) ON DELETE CASCADE,
  piece_id INTEGER NOT NULL REFERENCES pieces(id),
  returned_date TEXT,
  PRIMARY KEY (outsourcing_id, piece_id)
);
CREATE TABLE IF NOT EXISTS shipments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ship_no TEXT UNIQUE NOT NULL,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  ship_date TEXT NOT NULL,
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS shipment_pieces (
  shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  piece_id INTEGER NOT NULL UNIQUE REFERENCES pieces(id),
  PRIMARY KEY (shipment_id, piece_id)
);
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES order_items(id) ON DELETE SET NULL,
  orig_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  size INTEGER NOT NULL,
  uploaded_by INTEGER REFERENCES users(id),
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS pdf_mappings (
  customer_id INTEGER PRIMARY KEY REFERENCES customers(id),
  mapping TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_pieces_item ON pieces(item_id);
CREATE INDEX IF NOT EXISTS idx_pieces_order ON pieces(order_id);
CREATE INDEX IF NOT EXISTS idx_stages_piece ON piece_stages(piece_id);
CREATE INDEX IF NOT EXISTS idx_osp_piece ON outsourcing_pieces(piece_id);
`);

try {
  db.exec('ALTER TABLE orders ADD COLUMN voided_at TEXT');
} catch { /* 列已存在 */ }
for (const colDef of ['wip_stage TEXT', 'wip_date TEXT', 'wip_by INTEGER', 'wip_note TEXT']) {
  try { db.exec(`ALTER TABLE pieces ADD COLUMN ${colDef}`); } catch { /* 列已存在 */ }
}

function rebuildTable(table, createSql, shouldMigrate) {
  const cur = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`).get(table);
  if (!cur || !shouldMigrate(cur.sql)) return;
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(createSql.replace(`CREATE TABLE ${table}`, `CREATE TABLE ${table}_new`));
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name).join(',');
    db.exec(`INSERT INTO ${table}_new (${cols}) SELECT ${cols} FROM ${table}`);
    db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
    db.exec('COMMIT');
    console.log(`[迁移] ${table} 表结构已升级`);
  } catch (e) {
    db.exec('ROLLBACK');
    console.error(`[迁移] ${table} 失败:`, e.message);
  }
  db.exec('PRAGMA foreign_keys = ON');
}

rebuildTable('vendors', `CREATE TABLE vendors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,
  contact TEXT, phone TEXT,
  active INTEGER NOT NULL DEFAULT 1
)`, sql => sql.includes('CHECK(type IN'));

rebuildTable('outsourcing', `CREATE TABLE outsourcing (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_no TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  sent_date TEXT NOT NULL,
  expected_date TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','open','done')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
)`, sql => sql.includes('CHECK(type IN') || !sql.includes("'draft'"));

for (const colDef of ['note TEXT', 'flag TEXT', 'flag_note TEXT', 'flag_date TEXT', 'flag_by INTEGER']) {
  try { db.exec(`ALTER TABLE pieces ADD COLUMN ${colDef}`); } catch { /* 列已存在 */ }
}
db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('stall_warn_days', '2')`).run();
db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('stall_alert_days', '4')`).run();

try { db.exec('ALTER TABLE vendors ADD COLUMN address TEXT'); } catch { /* 列已存在 */ }

// 新增采购主管角色（与刀具系统统一登录配套）
rebuildTable('users', `CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','procurement','finance','cnc_manager','clerk','follower','programmer','outsourcer')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
)`, sql => !sql.includes('procurement'));
try { db.exec('ALTER TABLE outsourcing ADD COLUMN requirements TEXT'); } catch { /* 列已存在 */ }

// 财务应收台账：独立手工账，不与CNC订单数据关联（含模具钢材等其他业务）
db.exec(`
CREATE TABLE IF NOT EXISTS finance_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer TEXT NOT NULL,
  biz TEXT,
  title TEXT,
  amount REAL NOT NULL,
  received REAL NOT NULL DEFAULT 0,
  entry_date TEXT NOT NULL,
  due_date TEXT,
  remind INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plate_no TEXT UNIQUE NOT NULL,
  name TEXT,
  inspection_due TEXT,
  insurance_due TEXT,
  note TEXT,
  active INTEGER NOT NULL DEFAULT 1
);`);
// 旧方案（按出货算应收）已废弃，payments 表从未投入使用，清掉
db.exec('DROP TABLE IF EXISTS payments');

// 财务台账扩展：应收/应付两本账 + 收付款流水（供按期间统计实收实付）
try { db.exec(`ALTER TABLE finance_entries ADD COLUMN kind TEXT NOT NULL DEFAULT 'receivable'`); } catch { /* 列已存在 */ }
// 财务数据落盘加密：敏感字段整体加密进 enc 列（迁移在 routes-finance.js 启动时做）
try { db.exec('ALTER TABLE finance_entries ADD COLUMN enc TEXT'); } catch { /* 列已存在 */ }
try { db.exec('ALTER TABLE finance_payments ADD COLUMN enc TEXT'); } catch { /* 列已存在 */ }
db.exec(`
CREATE TABLE IF NOT EXISTS finance_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL REFERENCES finance_entries(id),
  kind TEXT NOT NULL,
  amount REAL NOT NULL,
  pay_date TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);`);
// 电镀外发单专用加工要求模板（开单时预填可改，如镀层厚度8μm/10μm）
db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('out_requirements_plating', '镀硬铬，镀层厚度：8μm，镀层均匀，不得有烧焦、起泡、脱皮、露底；孔内及螺纹按图纸要求防护；回厂前做好防潮防刮包装。')`).run();
// 外发单（采购订单版）打印抬头与条款默认值，可在系统设置里改
db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('out_contact_name', '朱麟铠')`).run();
db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('out_contact_phone', '13926824659')`).run();
db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('out_deliver_address', '广东省东莞市清溪镇清溪福龙路82号105室')`).run();
db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('out_requirements', '铣磨要求：长宽正负0.2，厚度正负0.05等厚，正面精磨，磨削方向一致。（电脑锣要求：严格按图纸要求加工，外形侧面保证光洁度，正面在电脑锣上倒角，孔内无异物，精孔达标，如图纸要求盲孔就要做盲孔）')`).run();
db.exec(`UPDATE orders SET voided_at = datetime('now','localtime') WHERE status = 'void' AND voided_at IS NULL`);

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  return scryptSync(password, salt, 64).toString('hex') === hash;
}

db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('company_name', '东莞市瑞宏智能科技有限公司')`).run();

const hasAdmin = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`).get();
if (hasAdmin.n === 0) {
  db.prepare(`INSERT INTO users (username, password_hash, name, role) VALUES (?, ?, ?, 'admin')`)
    .run('admin', hashPassword('admin123'), '总经理');
  console.log('已创建初始管理员账号：admin / admin123（登录后请立即改密码）');
}

// 板件"当前状态开始时间"：取各类业务日期的最大值（报工完成日/外发发出日/回货日/开工日/特殊状态标记日），
// 一个都没有才用订单下单日兜底。故意不用 created_at/recorded_at——补录历史时倒填的日期要能生效。
export function lastActExpr(p = 'p', o = 'ord') {
  return `COALESCE(NULLIF(MAX(
    COALESCE((SELECT MAX(s9.done_date) FROM piece_stages s9 WHERE s9.piece_id = ${p}.id), '0'),
    COALESCE((SELECT MAX(o9.sent_date) FROM outsourcing_pieces op9 JOIN outsourcing o9 ON o9.id = op9.outsourcing_id WHERE op9.piece_id = ${p}.id), '0'),
    COALESCE((SELECT MAX(op8.returned_date) FROM outsourcing_pieces op8 WHERE op8.piece_id = ${p}.id), '0'),
    COALESCE(${p}.wip_date, '0'),
    COALESCE(${p}.flag_date, '0')
  ), '0'), ${o}.order_date)`;
}

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
