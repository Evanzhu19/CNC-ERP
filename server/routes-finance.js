import { Router } from 'express';
import multer from 'multer';
import { db, today } from './db.js';
import { requireRole, BASICS_ROLES } from './auth.js';
import { parseFinanceExcel } from './finance-excel.js';
import { encRecord, decRecord, handshake, getSession, encPayload, decPayload, decPayloadBytes } from './finance-crypto.js';

export const financeRouter = Router();

// 财务台账：标准往来账户模式 —— 每个客户/供应商一个账户，
//   当前余额 = 上年结转(期初) + 累计销售/采购 − 累计回收/付款
// 盈亏只算本期发生额（结转不算收入/支出）。与CNC订单数据完全无关。
// 权限锁死：财务=看+操作；总经理=只读；其余角色一律不可见（另有index.js围栏）。
// 数据安全：账户与流水内容落盘加密（enc列）；/finance/* 传输全报文加密。
const FIN_VIEW = ['admin', 'finance'];
const FIN_EDIT = ['finance'];

const KINDS = ['receivable', 'payable'];
const round2 = v => Math.round(Number(v || 0) * 100) / 100;
const normKind = k => (KINDS.includes(k) ? k : 'receivable');
const normName = s => String(s || '').replace(/\s/g, '');
const validDate = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));

// ---- 底层读写（enc 落盘加密）----
function insertAccount(kind, d, remind, userId) {
  const r = db.prepare('INSERT INTO fin_accounts (kind, remind, enc, created_by) VALUES (?, ?, ?, ?)')
    .run(kind, remind ? 1 : 0, encRecord({ name: d.name, biz: d.biz || null, opening: round2(d.opening || 0), note: d.note || null }), userId ?? null);
  return Number(r.lastInsertRowid);
}

function updateAccount(id, d, remind) {
  db.prepare('UPDATE fin_accounts SET enc = ?, remind = ? WHERE id = ?')
    .run(encRecord({ name: d.name, biz: d.biz || null, opening: round2(d.opening || 0), note: d.note || null }), remind ? 1 : 0, id);
}

function insertTxn(accountId, kind, t, userId) {
  db.prepare('INSERT INTO fin_txns (account_id, kind, enc, created_by) VALUES (?, ?, ?, ?)')
    .run(accountId, kind, encRecord({ type: t.type, amount: round2(t.amount), date: t.date, title: t.title || null }), userId ?? null);
}

function readAccountsRaw(kind) {
  return db.prepare('SELECT a.id, a.kind, a.remind, a.enc FROM fin_accounts a WHERE a.kind = ?').all(kind)
    .map(r => ({ id: r.id, kind: r.kind, remind: r.remind, ...decRecord(r.enc) }));
}

function readTxnsOf(kind) {
  return db.prepare('SELECT t.id, t.account_id, t.enc, u.name AS created_by_name FROM fin_txns t LEFT JOIN users u ON u.id = t.created_by WHERE t.kind = ?').all(kind)
    .map(r => ({ id: r.id, account_id: r.account_id, created_by_name: r.created_by_name, ...decRecord(r.enc) }));
}

// 账户 + 汇总数
function readAccounts(kind) {
  const accounts = readAccountsRaw(kind);
  const txns = readTxnsOf(kind);
  const agg = new Map();
  for (const t of txns) {
    const o = agg.get(t.account_id) || { sales: 0, paid: 0, last: '', cnt: 0 };
    if (t.type === 'sale') o.sales += t.amount; else o.paid += t.amount;
    if (t.date && t.date > o.last) o.last = t.date;
    o.cnt++;
    agg.set(t.account_id, o);
  }
  return accounts.map(a => {
    const o = agg.get(a.id) || { sales: 0, paid: 0, last: '', cnt: 0 };
    return {
      ...a,
      opening: round2(a.opening),
      sales_total: round2(o.sales),
      paid_total: round2(o.paid),
      balance: round2(a.opening + o.sales - o.paid),
      last_txn: o.last || null,
      txn_count: o.cnt
    };
  }).sort((a, b) => (b.remind - a.remind) || (b.balance - a.balance));
}

function accountTotals(accounts) {
  const owed = accounts.filter(a => a.balance > 0.005);
  return {
    opening: round2(accounts.reduce((s, a) => s + a.opening, 0)),
    sales: round2(accounts.reduce((s, a) => s + a.sales_total, 0)),
    paid: round2(accounts.reduce((s, a) => s + a.paid_total, 0)),
    balance: round2(accounts.reduce((s, a) => s + a.balance, 0)),
    remind_count: owed.filter(a => a.remind).length,
    remind_balance: round2(owed.filter(a => a.remind).reduce((s, a) => s + a.balance, 0))
  };
}

// ===== 旧模型（按笔记账）→ 往来账户 一次性迁移 =====
(function migrateLegacyModel() {
  const hasE = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='finance_entries'`).get();
  if (!hasE) return;
  const hasP = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='finance_payments'`).get();
  const entries = db.prepare('SELECT * FROM finance_entries').all();
  const pays = hasP ? db.prepare('SELECT * FROM finance_payments').all() : [];
  db.exec('BEGIN');
  try {
    if (entries.length) {
      const decE = r => r.enc ? decRecord(r.enc) : { customer: r.customer, biz: r.biz, title: r.title, amount: r.amount, received: r.received, entry_date: r.entry_date, note: r.note };
      const decP = r => r.enc ? decRecord(r.enc) : { amount: r.amount, pay_date: r.pay_date };
      const entryById = new Map();
      const accts = new Map();
      for (const r of entries) {
        const d = decE(r);
        entryById.set(r.id, { kind: r.kind, d });
        const key = `${r.kind}|${normName(d.customer)}`;
        if (!accts.has(key)) accts.set(key, { kind: r.kind, name: d.customer, biz: d.biz || null, opening: 0, remind: 0, sales: [], payments: [], created_by: r.created_by });
        const a = accts.get(key);
        if (!a.biz && d.biz) a.biz = d.biz;
        if (r.remind) a.remind = 1;
        if (String(d.title || '') === '上年结转') a.opening = round2(a.opening + d.amount);
        else a.sales.push({ date: d.entry_date || today(), amount: round2(d.amount), title: d.title || null });
      }
      for (const p of pays) {
        const e = entryById.get(p.entry_id);
        if (!e) continue;
        const dp = decP(p);
        accts.get(`${e.kind}|${normName(e.d.customer)}`)?.payments.push({ date: dp.pay_date || today(), amount: round2(dp.amount) });
      }
      for (const a of accts.values()) {
        const id = insertAccount(a.kind, a, a.remind, a.created_by);
        for (const s of a.sales) insertTxn(id, a.kind, { type: 'sale', ...s }, a.created_by);
        for (const pm of a.payments) insertTxn(id, a.kind, { type: 'payment', date: pm.date, amount: pm.amount }, a.created_by);
      }
      console.log(`[财务] 旧记账数据已迁移为往来账户：${accts.size} 个单位`);
    }
    db.exec('DROP TABLE IF EXISTS finance_entries_old');
    db.exec('ALTER TABLE finance_entries RENAME TO finance_entries_old');
    if (hasP) {
      db.exec('DROP TABLE IF EXISTS finance_payments_old');
      db.exec('ALTER TABLE finance_payments RENAME TO finance_payments_old');
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('[财务] 旧模型迁移失败:', e.message);
  }
})();

// ===== 传输加密通道 =====
financeRouter.post('/finance/handshake', requireRole(...FIN_VIEW), (req, res) => {
  try {
    res.json({ pub: handshake(req.token, req.body?.pub) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

financeRouter.use('/finance', (req, res, next) => {
  const s = getSession(req.token);
  if (!s) return res.status(428).json({ error: '加密通道未建立' });
  req.finKey = s.key;
  if (req.body && typeof req.body.x === 'string') {
    try { req.body = decPayload(s.key, req.body.x); }
    catch { return res.status(400).json({ error: '请求解密失败，请刷新页面' }); }
  }
  res.finSend = obj => res.json({ x: encPayload(s.key, obj) });
  next();
});

// ===== 账户 =====
financeRouter.get('/finance/accounts', requireRole(...FIN_VIEW), (req, res) => {
  const accounts = readAccounts(normKind(req.query.kind));
  res.finSend({ accounts, totals: accountTotals(accounts) });
});

financeRouter.get('/finance/accounts/:id', requireRole(...FIN_VIEW), (req, res) => {
  const row = db.prepare('SELECT id, kind, remind, enc FROM fin_accounts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '账户不存在' });
  const account = readAccounts(row.kind).find(a => a.id === row.id);
  const txns = readTxnsOf(row.kind).filter(t => t.account_id === row.id)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || (b.id - a.id));
  res.finSend({ account, txns });
});

function validAccount(b) {
  if (!b?.name || !String(b.name).trim()) return '请填写单位名称';
  if (b.opening != null && !isFinite(Number(b.opening))) return '期初结转金额格式不对';
  return null;
}

financeRouter.post('/finance/accounts', requireRole(...FIN_EDIT), (req, res) => {
  const err = validAccount(req.body);
  if (err) return res.status(400).json({ error: err });
  const kind = normKind(req.body.kind);
  const name = String(req.body.name).trim();
  if (readAccountsRaw(kind).some(a => normName(a.name) === normName(name))) {
    return res.status(400).json({ error: `「${name}」已有账户，直接在它下面记流水即可` });
  }
  const id = insertAccount(kind, { ...req.body, name }, req.body.remind, req.user.id);
  res.finSend({ id });
});

financeRouter.put('/finance/accounts/:id', requireRole(...FIN_EDIT), (req, res) => {
  const row = db.prepare('SELECT id, kind, remind, enc FROM fin_accounts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '账户不存在' });
  const err = validAccount(req.body);
  if (err) return res.status(400).json({ error: err });
  const name = String(req.body.name).trim();
  if (readAccountsRaw(row.kind).some(a => a.id !== row.id && normName(a.name) === normName(name))) {
    return res.status(400).json({ error: `已存在同名账户「${name}」` });
  }
  updateAccount(row.id, { ...req.body, name }, req.body.remind ?? row.remind);
  res.finSend({ ok: true });
});

financeRouter.post('/finance/accounts/:id/remind', requireRole(...FIN_EDIT), (req, res) => {
  const row = db.prepare('SELECT id, remind FROM fin_accounts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '账户不存在' });
  const next = row.remind ? 0 : 1;
  db.prepare('UPDATE fin_accounts SET remind = ? WHERE id = ?').run(next, row.id);
  res.finSend({ ok: true, remind: next });
});

financeRouter.delete('/finance/accounts/:id', requireRole(...FIN_EDIT), (req, res) => {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM fin_txns WHERE account_id = ?').run(req.params.id);
    db.prepare('DELETE FROM fin_accounts WHERE id = ?').run(req.params.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.finSend({ ok: true });
});

// ===== 流水 =====
financeRouter.post('/finance/accounts/:id/txns', requireRole(...FIN_EDIT), (req, res) => {
  const row = db.prepare('SELECT id, kind, remind, enc FROM fin_accounts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '账户不存在' });
  const { type, amount, date, title } = req.body || {};
  if (!['sale', 'payment'].includes(type)) return res.status(400).json({ error: '流水类型不对' });
  if (!(Number(amount) > 0)) return res.status(400).json({ error: '金额必须大于0' });
  const d = validDate(date) ? date : today();
  db.exec('BEGIN');
  try {
    insertTxn(row.id, row.kind, { type, amount: Number(amount), date: d, title }, req.user.id);
    // 收/付清后自动取消催款标记
    if (type === 'payment' && row.remind) {
      const acc = readAccounts(row.kind).find(a => a.id === row.id);
      if (acc && acc.balance <= 0.005) db.prepare('UPDATE fin_accounts SET remind = 0 WHERE id = ?').run(row.id);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.finSend({ ok: true });
});

financeRouter.delete('/finance/txns/:id', requireRole(...FIN_EDIT), (req, res) => {
  db.prepare('DELETE FROM fin_txns WHERE id = ?').run(req.params.id);
  res.finSend({ ok: true });
});

// ===== 总账：余额 + 按业务类型 + 按月/季/年盈亏（结转不算收入/支出）=====
financeRouter.get('/finance/summary', requireRole(...FIN_VIEW), (req, res) => {
  const g = ['month', 'quarter', 'year'].includes(req.query.granularity) ? req.query.granularity : 'month';
  const periodOf = d => {
    if (!d) return null;
    if (g === 'month') return d.slice(0, 7);
    if (g === 'year') return d.slice(0, 4);
    return `${d.slice(0, 4)}Q${Math.ceil(Number(d.slice(5, 7)) / 3)}`;
  };

  const balances = {};
  const byBiz = {};
  const periodMap = new Map();
  const P = p => { if (!periodMap.has(p)) periodMap.set(p, { period: p, income: 0, expense: 0, cash_in: 0, cash_out: 0 }); return periodMap.get(p); };

  for (const kind of KINDS) {
    const accounts = readAccounts(kind);
    balances[kind] = accountTotals(accounts);

    const m = new Map();
    for (const a of accounts) {
      const biz = (a.biz || '').trim() || '未分类';
      const o = m.get(biz) || { biz, amount: 0, received: 0, balance: 0, cnt: 0 };
      o.amount += a.opening + a.sales_total; o.received += a.paid_total; o.balance += a.balance; o.cnt++;
      m.set(biz, o);
    }
    byBiz[kind] = [...m.values()].map(o => ({ ...o, amount: round2(o.amount), received: round2(o.received), balance: round2(o.balance) }))
      .sort((a, b) => b.balance - a.balance);

    for (const t of readTxnsOf(kind)) {
      const p = periodOf(t.date);
      if (!p) continue;
      const o = P(p);
      if (t.type === 'sale') { if (kind === 'receivable') o.income += t.amount; else o.expense += t.amount; }
      else { if (kind === 'receivable') o.cash_in += t.amount; else o.cash_out += t.amount; }
    }
  }
  balances.net = round2(balances.receivable.balance - balances.payable.balance);

  let periods = [...periodMap.values()].map(o => ({
    period: o.period,
    income: round2(o.income), expense: round2(o.expense), profit: round2(o.income - o.expense),
    cash_in: round2(o.cash_in), cash_out: round2(o.cash_out), net_cash: round2(o.cash_in - o.cash_out)
  })).sort((a, b) => b.period.localeCompare(a.period));
  periods = periods.slice(0, g === 'month' ? 12 : g === 'quarter' ? 8 : 20);

  res.finSend({ balances, by_biz: byBiz, periods, granularity: g });
});

// ===== Excel 导入 =====
const xlsUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

financeRouter.post('/finance/parse-excel', requireRole(...FIN_EDIT), xlsUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择Excel文件' });
  try {
    const buf = decPayloadBytes(req.finKey, req.file.buffer);
    const { sheets } = parseFinanceExcel(buf);
    const kind = normKind(req.query.kind);
    const existing = new Set(readAccountsRaw(kind).map(a => normName(a.name)));
    for (const sheet of sheets) {
      for (const a of sheet.accounts || []) a.duplicate = existing.has(normName(a.name));
    }
    res.finSend({ sheets });
  } catch (e) {
    console.error('财务Excel解析失败:', e);
    res.status(422).json({ error: 'Excel解析失败：' + e.message });
  }
});

financeRouter.post('/finance/import', requireRole(...FIN_EDIT), (req, res) => {
  const { accounts, kind: rawKind } = req.body || {};
  if (!Array.isArray(accounts) || !accounts.length) return res.status(400).json({ error: '没有要导入的单位' });
  if (accounts.length > 500) return res.status(400).json({ error: '一次最多导入500个单位' });
  const kind = normKind(rawKind);
  const existing = new Set(readAccountsRaw(kind).map(a => normName(a.name)));

  db.exec('BEGIN');
  try {
    let imported = 0, txnCount = 0;
    const skipped = [];
    for (const a of accounts) {
      const name = String(a.name || '').trim();
      if (!name) continue;
      if (existing.has(normName(name))) { skipped.push(name); continue; }
      existing.add(normName(name));
      const id = insertAccount(kind, { name, biz: a.biz, opening: a.opening, note: a.note }, 0, req.user.id);
      for (const s of a.sales || []) {
        if (!(Number(s.amount) > 0)) continue;
        insertTxn(id, kind, { type: 'sale', amount: Number(s.amount), date: validDate(s.date) ? s.date : today(), title: s.title }, req.user.id);
        txnCount++;
      }
      for (const p of a.payments || []) {
        if (!(Number(p.amount) > 0)) continue;
        insertTxn(id, kind, { type: 'payment', amount: Number(p.amount), date: validDate(p.date) ? p.date : today() }, req.user.id);
        txnCount++;
      }
      imported++;
    }
    db.exec('COMMIT');
    res.finSend({ imported, txns: txnCount, skipped });
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('财务导入失败:', e);
    res.status(400).json({ error: '导入失败，已全部回滚：' + e.message });
  }
});

// ===== 车辆：年检 / 商业保险 到期提醒（提前30天黄、提前14天红，不允许过期） =====
function vehicleDue(dateStr) {
  if (!dateStr) return null;
  const days = Math.round((Date.parse(dateStr) - Date.parse(today())) / 86400_000);
  const level = days < 0 ? 'overdue' : days <= 14 ? 'alert' : days <= 30 ? 'warn' : 'ok';
  return { date: dateStr, days_left: days, level };
}

export function vehiclesDueSoon() {
  const rows = db.prepare('SELECT * FROM vehicles WHERE active = 1').all();
  const due = [];
  for (const v of rows) {
    for (const [kind, d] of [['年检', v.inspection_due], ['商业保险', v.insurance_due]]) {
      const info = vehicleDue(d);
      if (info && info.level !== 'ok') due.push({ plate_no: v.plate_no, name: v.name, kind, ...info });
    }
  }
  return due.sort((a, b) => a.days_left - b.days_left);
}

financeRouter.get('/vehicles', (req, res) => {
  const rows = db.prepare('SELECT * FROM vehicles ORDER BY active DESC, plate_no').all();
  res.json({
    vehicles: rows.map(v => ({
      ...v,
      inspection: vehicleDue(v.inspection_due),
      insurance: vehicleDue(v.insurance_due)
    }))
  });
});

financeRouter.post('/vehicles', requireRole(...BASICS_ROLES), (req, res) => {
  const { plate_no, name, inspection_due, insurance_due, note } = req.body || {};
  if (!plate_no || !String(plate_no).trim()) return res.status(400).json({ error: '车牌号不能为空' });
  try {
    const r = db.prepare(
      'INSERT INTO vehicles (plate_no, name, inspection_due, insurance_due, note) VALUES (?, ?, ?, ?, ?)'
    ).run(String(plate_no).trim(), name || null, inspection_due || null, insurance_due || null, note || null);
    res.json({ id: Number(r.lastInsertRowid) });
  } catch {
    res.status(400).json({ error: '该车牌已存在' });
  }
});

financeRouter.put('/vehicles/:id', requireRole(...BASICS_ROLES), (req, res) => {
  const { plate_no, name, inspection_due, insurance_due, note, active } = req.body || {};
  if (!plate_no || !String(plate_no).trim()) return res.status(400).json({ error: '车牌号不能为空' });
  try {
    db.prepare(
      'UPDATE vehicles SET plate_no = ?, name = ?, inspection_due = ?, insurance_due = ?, note = ?, active = ? WHERE id = ?'
    ).run(String(plate_no).trim(), name || null, inspection_due || null, insurance_due || null, note || null, active ? 1 : 0, req.params.id);
    res.json({ ok: true });
  } catch {
    res.status(400).json({ error: '该车牌已存在' });
  }
});

financeRouter.delete('/vehicles/:id', requireRole('admin', 'procurement', 'finance'), (req, res) => {
  db.prepare('DELETE FROM vehicles WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});
