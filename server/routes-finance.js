import { Router } from 'express';
import { db, today } from './db.js';
import { requireRole, BASICS_ROLES } from './auth.js';

export const financeRouter = Router();

// 财务台账：独立手工账（含模具钢材等CNC之外的业务），与订单/出货数据完全无关
// 权限锁死：财务=看+操作；总经理=只读；其余角色（含采购主管）一律不可见不可操作。
// 所有校验都在服务端逐接口强制，前端只是隐藏入口。
const FIN_VIEW = ['admin', 'finance'];
const FIN_EDIT = ['finance'];

const round2 = v => Math.round(Number(v || 0) * 100) / 100;

financeRouter.get('/finance/entries', requireRole(...FIN_VIEW), (req, res) => {
  const rows = db.prepare(`
    SELECT f.*, u.name AS created_by_name
    FROM finance_entries f LEFT JOIN users u ON u.id = f.created_by
    ORDER BY f.remind DESC, f.entry_date DESC, f.id DESC
  `).all();
  const entries = rows.map(r => ({
    ...r,
    amount: round2(r.amount),
    received: round2(r.received),
    balance: round2(r.amount - r.received)
  }));
  const owed = entries.filter(e => e.balance > 0.005);
  const totals = {
    amount: round2(entries.reduce((s, e) => s + e.amount, 0)),
    received: round2(entries.reduce((s, e) => s + e.received, 0)),
    balance: round2(entries.reduce((s, e) => s + e.balance, 0)),
    owed_count: owed.length,
    remind_count: owed.filter(e => e.remind).length,
    remind_balance: round2(owed.filter(e => e.remind).reduce((s, e) => s + e.balance, 0))
  };
  res.json({ entries, totals });
});

function validEntry(body) {
  const { customer, amount, entry_date } = body || {};
  if (!customer || !String(customer).trim()) return '请填写客户/单位名称';
  if (!(Number(amount) > 0)) return '应收金额必须大于0';
  if (!entry_date || !/^\d{4}-\d{2}-\d{2}$/.test(String(entry_date))) return '请选择记账日期';
  if (body.received != null && Number(body.received) < 0) return '已收金额不能为负';
  return null;
}

financeRouter.post('/finance/entries', requireRole(...FIN_EDIT), (req, res) => {
  const err = validEntry(req.body);
  if (err) return res.status(400).json({ error: err });
  const b = req.body;
  const r = db.prepare(`
    INSERT INTO finance_entries (customer, biz, title, amount, received, entry_date, due_date, remind, note, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(String(b.customer).trim(), b.biz || null, b.title || null, Number(b.amount),
    Number(b.received || 0), b.entry_date, b.due_date || null, b.remind ? 1 : 0, b.note || null, req.user.id);
  res.json({ id: Number(r.lastInsertRowid) });
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

// 快捷操作：登记收款（累加）/ 切换催款标记
financeRouter.post('/finance/entries/:id/receive', requireRole(...FIN_EDIT), (req, res) => {
  const row = db.prepare('SELECT * FROM finance_entries WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '记录不存在' });
  const amt = Number(req.body?.amount);
  if (!(amt > 0)) return res.status(400).json({ error: '收款金额必须大于0' });
  const newReceived = round2(row.received + amt);
  // 收清后自动取消催款标记
  const remind = newReceived >= row.amount - 0.005 ? 0 : row.remind;
  db.prepare('UPDATE finance_entries SET received = ?, remind = ? WHERE id = ?').run(newReceived, remind, row.id);
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
  db.prepare('DELETE FROM finance_entries WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
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
