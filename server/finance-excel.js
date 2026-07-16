import * as XLSX from 'xlsx';

// 财务账本 Excel 导入 —— 统一输出"往来账户"结构：
//   { name(单位), biz, opening(上年结转), sales:[{date,amount,title}], payments:[{date,amount}] }
// 支持两种格式：
//   A. 矩阵账本（你们的《采购/销售统计表》）：每单位两行(发生额/收付款)×月份列+上年结转
//   B. 普通流水表：一行一笔（单位/金额/已收付/日期/备注）

const FIN_FIELDS = {
  customer: ['客户', '单位', '供应商', '公司', '客户名称', '单位名称', '供应商名称', '往来单位'],
  biz: ['业务', '业务类型', '类型', '类别', '款项类型'],
  title: ['事由', '摘要', '内容', '说明', '品名', '款项', '项目', '货物'],
  amount: ['金额', '应收金额', '应付金额', '应收', '应付', '合计', '总额', '价款', '货款', '销售额', '采购额'],
  received: ['已收', '已付', '回款', '已收金额', '已付金额', '实收', '实付', '收款', '付款', '回收'],
  entry_date: ['日期', '记账日期', '开单日期', '时间', '账期'],
  note: ['备注', '注', '说明备注']
};

function guessFinField(text) {
  const t = String(text || '').replace(/\s/g, '');
  if (!t) return null;
  let best = null, bestLen = 0;
  for (const [field, keys] of Object.entries(FIN_FIELDS)) {
    for (const k of keys) {
      if (t.includes(k) && k.length > bestLen) { best = field; bestLen = k.length; }
    }
  }
  return best;
}

function excelSerialToDate(n) {
  const d = new Date(Math.round((n - 25569) * 86400 * 1000));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function coerceDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v)) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  if (typeof v === 'number' && v > 20000 && v < 60000) return excelSerialToDate(v);
  const s = String(v).trim();
  const num = Number(s);
  if (!isNaN(num) && num > 20000 && num < 60000) return excelSerialToDate(num);
  let m = s.match(/(\d{4})[/\-年.](\d{1,2})[/\-月.](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[/\-](\d{1,2})$/);
  if (m) return `${new Date().getFullYear()}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

function coerceMoney(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const m = String(v).replace(/[¥￥$,，\s]/g, '').match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

const cellText = v => {
  if (v == null) return '';
  if (v instanceof Date) return coerceDate(v) || '';
  return String(v).trim();
};

const r2 = v => Math.round(v * 100) / 100;

// ===== A. 矩阵账本 =====
const CN_MONTHS = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
const ACCRUAL_TYPES = ['采购款', '销售款', '货款'];
const PAY_TYPES = ['付款', '回收款', '收款'];

function monthOf(text) {
  const t = String(text || '').replace(/\s/g, '');
  const i = CN_MONTHS.indexOf(t);
  if (i >= 0) return i + 1;
  const m = t.match(/^(\d{1,2})月$/);
  if (m) return Number(m[1]);
  return null;
}

function tryParseMatrix(rows) {
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 8); i++) {
    const cells = (rows[i] || []).map(cellText);
    if (cells.some(c => c === '序号') && cells.filter(c => monthOf(c)).length >= 3) { headerIdx = i; break; }
  }
  if (headerIdx < 0) return null;

  const header = (rows[headerIdx] || []).map(cellText);
  const monthCols = new Map();
  header.forEach((h, c) => { const m = monthOf(h); if (m) monthCols.set(c, m); });
  const carryCol = header.findIndex(h => h.includes('结转'));
  let nameCol = header.findIndex(h => /客户|供应商|单位|名称/.test(h) && !/材料|业务/.test(h));
  const bizCol = header.findIndex(h => /^材料$|业务/.test(h.replace(/\s/g, '')));
  if (nameCol < 0) nameCol = (bizCol >= 0 ? bizCol + 1 : 1);

  let year = new Date().getFullYear();
  for (let i = 0; i <= headerIdx; i++) {
    const m = (rows[i] || []).map(cellText).join(' ').match(/20\d{2}/);
    if (m) { year = Number(m[0]); break; }
  }

  const accounts = new Map(); // name -> account
  const acct = (name, biz) => {
    if (!accounts.has(name)) accounts.set(name, { name, biz: biz || null, opening: 0, sales: [], payments: [] });
    return accounts.get(name);
  };
  let current = null;

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const cells = row.map(cellText);
    if (!cells.join('')) continue;
    let type = null;
    for (let c = 0; c < cells.length; c++) {
      const t = cells[c].replace(/\s/g, '');
      if (ACCRUAL_TYPES.includes(t) || PAY_TYPES.includes(t)) { type = t; break; }
    }
    if (!type) continue;

    const isAccrual = ACCRUAL_TYPES.includes(type);
    if (isAccrual) {
      const name = cellText(row[nameCol]);
      if (!name) continue;
      current = acct(name, bizCol >= 0 ? cellText(row[bizCol]) : null);
      const carry = carryCol >= 0 ? coerceMoney(row[carryCol]) : null;
      if (carry) current.opening = r2(current.opening + carry);
    }
    if (!current) continue;
    for (const [c, month] of monthCols) {
      const v = coerceMoney(row[c]);
      if (!v || v === 0) continue;
      const mm = String(month).padStart(2, '0');
      const date = `${year}-${mm}-01`;
      if (isAccrual) current.sales.push({ date, amount: r2(v), title: `${CN_MONTHS[month - 1]}${type}` });
      else current.payments.push({ date, amount: r2(v) });
    }
  }
  if (!accounts.size) return null;
  return { mode: 'matrix', year, accounts: [...accounts.values()] };
}

// ===== B. 普通流水表 → 聚合成账户 =====
function tryParseFlat(rows) {
  let headerIdx = -1, map = {};
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const m = {};
    let hits = 0;
    for (let c = 0; c < (rows[i] || []).length; c++) {
      const f = guessFinField(cellText(rows[i][c]));
      if (f && !(f in m)) { m[f] = c; hits++; }
    }
    if (hits >= 2 && ('amount' in m) && ('customer' in m || 'title' in m)) { headerIdx = i; map = m; break; }
  }
  if (headerIdx < 0) return null;

  const accounts = new Map();
  const acct = name => {
    if (!accounts.has(name)) accounts.set(name, { name, biz: null, opening: 0, sales: [], payments: [] });
    return accounts.get(name);
  };
  const skipped = [];
  let lastCustomer = '';
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const get = f => (f in map ? row[map[f]] : null);
    const rowText = row.map(cellText).join('');
    if (!rowText) continue;
    if (/合计|总计|小计/.test(rowText) && !cellText(get('customer'))) continue;

    const customer = cellText(get('customer')) || lastCustomer;
    if (cellText(get('customer'))) lastCustomer = cellText(get('customer'));
    const amount = coerceMoney(get('amount'));
    if (!customer && amount == null) continue;
    if (!customer) { skipped.push({ row: i + 1, reason: '缺客户/单位' }); continue; }
    if (amount == null || amount <= 0) { skipped.push({ row: i + 1, reason: '缺金额或金额无效' }); continue; }

    const a = acct(customer);
    if (!a.biz && cellText(get('biz'))) a.biz = cellText(get('biz'));
    const date = coerceDate(get('entry_date'));
    a.sales.push({ date, amount: r2(amount), title: cellText(get('title')) || cellText(get('note')) || null });
    const rec = coerceMoney(get('received'));
    if (rec && rec > 0) a.payments.push({ date, amount: r2(Math.min(rec, amount)) });
  }
  if (!accounts.size) return null;
  return { mode: 'flat', accounts: [...accounts.values()], skipped };
}

export function parseFinanceExcel(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheets = [];
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null, raw: true });
    const parsed = tryParseMatrix(rows) || tryParseFlat(rows);
    if (!parsed) { sheets.push({ name, error: '没有识别到账本表格（需要单位名和金额）', accounts: [] }); continue; }
    // 每个账户的汇总数，供预览
    for (const a of parsed.accounts) {
      a.sales_total = r2(a.sales.reduce((s, x) => s + x.amount, 0));
      a.paid_total = r2(a.payments.reduce((s, x) => s + x.amount, 0));
      a.balance = r2(a.opening + a.sales_total - a.paid_total);
      a.txn_count = a.sales.length + a.payments.length;
    }
    sheets.push({ name, ...parsed });
  }
  return { sheets };
}
