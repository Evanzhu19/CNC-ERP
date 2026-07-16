// 输入防线：把"愚蠢用户"和乱调接口的畸形数据挡在业务逻辑之外。
// 原则：只接受预期类型，长度封顶，数字有界；越界一律 400 明确提示，绝不进数据库、绝不 500。

// 用户输入错误：抛出后由全局错误处理器转成 400 + 原文提示（区别于真正的500）
export class BadRequest extends Error {
  constructor(msg) { super(msg); this.status = 400; this.name = 'BadRequest'; }
}

export const LIMITS = {
  name: 100,        // 客户/厂家/单位/人名
  code: 60,         // 编号/图号/单号/车牌
  spec: 120,        // 规格
  note: 500,        // 备注/事由/说明
  text: 2000,       // 长文本（加工要求等）
  piece_ids: 2000,  // 单次批量操作的板件数上限（SQLite 变量上限32766，业务上也不该更多）
  items: 200,       // 单张订单明细行数
  qty: 2000,        // 单行数量
  money: 1e10       // 金额上限（100亿，防手滑多打零）
};

// 字符串：必须是 string/number，去空白，长度封顶。非法类型直接判空。
export function str(v, max = LIMITS.note) {
  if (v == null) return null;
  if (typeof v === 'object') return null;        // 数组/对象 → 不接受（防 [object Object] 脏数据）
  const s = String(v).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

// 必填字符串：不合法返回 null，由调用方报错
export function reqStr(v, max = LIMITS.name) {
  return str(v, max);
}

// 正整数，有界
export function posInt(v, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > max) return null;
  return n;
}

// 金额：有限数字，非负，有界，2位小数
export function money(v, { allowZero = true, max = LIMITS.money } = {}) {
  const n = Number(v);
  if (!isFinite(n) || n < 0 || n > max) return null;
  if (!allowZero && n === 0) return null;
  return Math.round(n * 100) / 100;
}

// 日期 YYYY-MM-DD，且是真实存在的日期
export function dateStr(v) {
  const s = String(v || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  // 防 2026-02-31 这种
  if (d.toISOString().slice(0, 10) !== s) return null;
  const y = d.getFullYear();
  if (y < 2000 || y > 2100) return null;
  return s;
}

// id 数组：必须是数组，元素为正整数，去重，数量封顶
// 返回 { ids } 或 { error }
export function idList(v, max = LIMITS.piece_ids, label = '项目') {
  if (!Array.isArray(v)) return { error: `请选择要操作的${label}` };
  if (v.length === 0) return { error: `请至少选择一${label === '板件' ? '件' : '项'}` };
  if (v.length > max) return { error: `一次最多操作 ${max} ${label === '板件' ? '件' : '项'}，请分批处理（当前选了 ${v.length}）` };
  const ids = [];
  const seen = new Set();
  for (const x of v) {
    const n = Number(x);
    if (!Number.isInteger(n) || n <= 0) return { error: `${label}编号不合法` };
    if (!seen.has(n)) { seen.add(n); ids.push(n); }
  }
  return { ids };
}

// 外键存在性检查：不存在返回 false，由调用方回 400（而不是让数据库抛 FOREIGN KEY 报 500）
export function exists(db, table, id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return false;
  return !!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(n);
}
