import { Router } from 'express';
import multer from 'multer';
import { db, today } from './db.js';
import { requireRole, BASICS_ROLES } from './auth.js';
import { parseFinanceExcel, FIN_FIELD_NAMES } from './finance-excel.js';

export const financeRouter = Router();

// 财务台账：独立手工账（应收+应付两本，含模具钢材等CNC之外的业务），与订单/出货数据完全无关
// 权限锁死：财务=看+操作；总经理=只读；其余角色（含采购主管）一律不可见不可操作。
// 所有校验都在服务端逐接口强制，前端只是隐藏入口。
const FIN_VIEW = ['admin', 'finance'];
const FIN_EDIT = ['finance'];

const KINDS = ['receivable', 'payable'];
const round2 = v => Math.round(Number(v || 0) * 100) / 100;
const normKind = k => (KINDS.includes(k) ? k : 'receivable');

function entryTotals(entries) {
  const owed = entries.filter(e => e.balance > 0.005);
  return {
    amount: round2(entries.reduce((s, e) => s + e.amount, 0)),
    received: round2(entries.reduce((s, e) => s + e.received, 0)),
    balance: round2(entries.reduce((s, e) => s + e.balance, 0)),
    owed_count: owed.length,
    remind_count: owed.filter(e => e.remind).length,
    remind_balance: round2(owed.filter(e => e.remind).reduce((s, e) => s + e.balance, 0))
  };
}

financeRouter.get('/finance/entries', requireRole(...FIN_VIEW), (req, res) => {
  const kind = normKind(req.query.kind);
  const rows = db.prepare(`
    SELECT f.*, u.name AS created_by_name
    FROM finance_entries f LEFT JOIN users u ON u.id = f.created_by
    WHERE f.kind = ?
    ORDER BY f.remind DESC, f.entry_date DESC, f.id DESC
  `).all(kind);
  const entries = rows.map(r => ({
    ...r,
    amount: round2(r.amount),
    received: round2(r.received),
    balance: round2(r.amount - r.received)
  }));
  res.json({ entries, totals: entryTotals(entries) });
});

// 总账：当前余额 + 按业务类型小计 + 按月/季/年盈亏（收入=新增应收，支出=新增应付）
financeRouter.get('/finance/summary', requireRole(...FIN_VIEW), (req, res) => {
  const g = ['month', 'quarter', 'year'].includes(req.query.granularity) ? req.query.granularity : 'month';
  const periodExpr = col => ({
    month: `substr(${col}, 1, 7)`,
    quarter: `substr(${col}, 1, 4) || 'Q' || CAST((CAST(substr(${col}, 6, 2) AS INTEGER) + 2) / 3 AS INTEGER)`,
    year: `substr(${col}, 1, 4)`
  }[g]);

  const balances = {};
  for (const kind of KINDS) {
    const rows = db.prepare('SELECT amount, received, remind FROM finance_entries WHERE kind = ?').all(kind)
      .map(r => ({ ...r, balance: r.amount - r.received }));
    balances[kind] = entryTotals(rows.map(r => ({ ...r, amount: round2(r.amount), received: round2(r.received), balance: round2(r.balance) })));
  }
  balances.net = round2(balances.receivable.balance - balances.payable.balance);

  const byBiz = {};
  for (const kind of KINDS) {
    byBiz[kind] = db.prepare(`
      SELECT COALESCE(NULLIF(TRIM(biz), ''), '未分类') AS biz,
        SUM(amount) AS amount, SUM(received) AS received, SUM(amount - received) AS balance, COUNT(*) AS cnt
      FROM finance_entries WHERE kind = ? GROUP BY 1 ORDER BY balance DESC
    `).all(kind).map(r => ({ ...r, amount: round2(r.amount), received: round2(r.received), balance: round2(r.balance) }));
  }

  // 记账口径盈亏
  const booked = db.prepare(`
    SELECT ${periodExpr('entry_date')} AS period, kind, SUM(amount) AS total
    FROM finance_entries GROUP BY period, kind
  `).all();
  // 现金口径（收付款流水，历史导入的已收按记账日期入流水）
  const cash = db.prepare(`
    SELECT ${periodExpr('pay_date')} AS period, kind, SUM(amount) AS total
    FROM finance_payments GROUP BY period, kind
  `).all();

  const periodMap = new Map();
  const P = p => { if (!periodMap.has(p)) periodMap.set(p, { period: p, income: 0, expense: 0, profit: 0, cash_in: 0, cash_out: 0, net_cash: 0 }); return periodMap.get(p); };
  for (const r of booked) {
    const o = P(r.period);
    if (r.kind === 'receivable') o.income = round2(r.total); else o.expense = round2(r.total);
  }
  for (const r of cash) {
    const o = P(r.period);
    if (r.kind === 'receivable') o.cash_in = round2(r.total); else o.cash_out = round2(r.total);
  }
  let periods = [...periodMap.values()].map(o => ({
    ...o, profit: round2(o.income - o.expense), net_cash: round2(o.cash_in - o.cash_out)
  })).sort((a, b) => b.period.localeCompare(a.period));
  const limit = g === 'month' ? 12 : g === 'quarter' ? 8 : 20;
  periods = periods.slice(0, limit);

  res.json({ balances, by_biz: byBiz, periods, granularity: g });
});

function validEntry(body) {
  const { customer, amount, entry_date } = body || {};
  if (!customer || !String(customer).trim()) return '请填写客户/单位名称';
  if (!(Number(amount) > 0)) return '金额必须大于0';
  if (!entry_date || !/^\d{4}-\d{2}-\d{2}$/.test(String(entry_date))) return '请选择记账日期';
  if (body.received != null && Number(body.received) < 0) return '已收/已付金额不能为负';
  return null;
}

financeRouter.post('/finance/entries', requireRole(...FIN_EDIT), (req, res) => {
  const err = validEntry(req.body);
  if (err) return res.status(400).json({ error: err });
  const b = req.body;
  const kind = normKind(b.kind);
  db.exec('BEGIN');
  try {
    const r = db.prepare(`
      INSERT INTO finance_entries (kind, customer, biz, title, amount, received, entry_date, due_date, remind, note, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(kind, String(b.customer).trim(), b.biz || null, b.title || null, Number(b.amount),
      Number(b.received || 0), b.entry_date, b.due_date || null, b.remind ? 1 : 0, b.note || null, req.user.id);
    const id = Number(r.lastInsertRowid);
    if (Number(b.received || 0) > 0) {
      db.prepare('INSERT INTO finance_payments (entry_id, kind, amount, pay_date, created_by) VALUES (?, ?, ?, ?, ?)')
        .run(id, kind, Number(b.received), b.entry_date, req.user.id);
    }
    db.exec('COMMIT');
    res.json({ id });
  } catch (e) { db.exec('ROLLBACK'); throw e; }
});

financeRouter.put('/finance/entries/:id', requireRole(...FIN_EDIT), (req, res) => {
  const row = db.prepare('SELECT id FROM finance_entries WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '记录不存在' });
  const err = validEntry(req.body);
  if (err) return res.status(400).json({ error: err });
  const b = req.body;
  db.prepare(`
    UPDATE finance_entries SET customer = ?, biz = ?, title = ?, amount = ?, received = ?,
      entry_date = ?, due_date = ?, remind = ?, note = ? WHERE id = ?
  `).run(String(b.customer).trim(), b.biz || null, b.title || null, Number(b.amount),
    Number(b.received || 0), b.entry_date, b.due_date || null, b.remind ? 1 : 0, b.note || null, row.id);
  res.json({ ok: true });
});

// 快捷操作：登记收款/付款（累加+记流水）/ 切换催款（待付）标记
financeRouter.post('/finance/entries/:id/receive', requireRole(...FIN_EDIT), (req, res) => {
  const row = db.prepare('SELECT * FROM finance_entries WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '记录不存在' });
  const amt = Number(req.body?.amount);
  if (!(amt > 0)) return res.status(400).json({ error: '金额必须大于0' });
  const payDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.pay_date || '')) ? req.body.pay_date : today();
  const newReceived = round2(row.received + amt);
  const remind = newReceived >= row.amount - 0.005 ? 0 : row.remind;
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE finance_entries SET received = ?, remind = ? WHERE id = ?').run(newReceived, remind, row.id);
    db.prepare('INSERT INTO finance_payments (entry_id, kind, amount, pay_date, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(row.id, row.kind, amt, payDate, req.user.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json({ ok: true, received: newReceived });
});

financeRouter.post('/finance/entries/:id/remind', requireRole(...FIN_EDIT), (req, res) => {
  const row = db.prepare('SELECT id, remind FROM finance_entries WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '记录不存在' });
  const next = row.remind ? 0 : 1;
  db.prepare('UPDATE finance_entries SET remind = ? WHERE id = ?').run(next, row.id);
  res.json({ ok: true, remind: next });
});

financeRouter.delete('/finance/entries/:id', requireRole(...FIN_EDIT), (req, res) => {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM finance_payments WHERE entry_id = ?').run(req.params.id);
    db.prepare('DELETE FROM finance_entries WHERE id = ?').run(req.params.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json({ ok: true });
});

// ===== Excel 导入：解析预览 + 批量入账 =====
const xlsUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

financeRouter.post('/finance/parse-excel', requireRole(...FIN_EDIT), xlsUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择Excel文件' });
  try {
    const { sheets } = parseFinanceExcel(req.file.buffer);
    // 查重：同单位+同金额+同记账日期 已存在 → 标记疑似重复
    const dupStmt = db.prepare(`
      SELECT COUNT(*) AS n FROM finance_entries
      WHERE kind = ? AND replace(customer, ' ', '') = ? AND ABS(amount - ?) < 0.005 AND entry_date = ?
    `);
    const kind = normKind(req.query.kind);
    for (const sheet of sheets) {
      for (const l of sheet.lines || []) {
        l.duplicate = l.entry_date
          ? dupStmt.get(kind, l.customer.replace(/\s/g, ''), l.amount, l.entry_date).n > 0
          : false;
      }
    }
    res.json({ sheets, field_names: FIN_FIELD_NAMES });
  } catch (e) {
    console.error('财务Excel解析失败:', e);
    res.status(422).json({ error: 'Excel解析失败：' + e.message });
  }
});

financeRouter.post('/finance/import', requireRole(...FIN_EDIT), (req, res) => {
  const { entries, kind: rawKind } = req.body || {};
  if (!Array.isArray(entries) || !entries.length) return res.status(400).json({ error: '没有要导入的记录' });
  if (entries.length > 1000) return res.status(400).json({ error: '一次最多导入1000条' });
  const kind = normKind(rawKind);
  const errs = [];
  entries.forEach((e, i) => { const err = validEntry({ ...e, entry_date: e.entry_date || today() }); if (err) errs.push(`第${i + 1}条: ${err}`); });
  if (errs.length) return res.status(400).json({ error: errs.slice(0, 5).join('；') });

  db.exec('BEGIN');
  try {
    const ins = db.prepare(`
      INSERT INTO finance_entries (kind, customer, biz, title, amount, received, entry_date, due_date, remind, note, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `);
    const insPay = db.prepare('INSERT INTO finance_payments (entry_id, kind, amount, pay_date, created_by) VALUES (?, ?, ?, ?, ?)');
    let count = 0;
    for (const e of entries) {
      const entryDate = e.entry_date || today();
      const received = Math.min(Number(e.received || 0), Number(e.amount));
      const r = ins.run(kind, String(e.customer).trim(), e.biz || null, e.title || null, Number(e.amount),
        received, entryDate, e.due_date || null, e.note || null, req.user.id);
      if (received > 0) insPay.run(Number(r.lastInsertRowid), kind, received, entryDate, req.user.id);
      count++;
    }
    db.exec('COMMIT');
    res.json({ imported: count });
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
