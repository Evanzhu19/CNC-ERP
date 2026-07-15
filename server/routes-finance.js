import { Router } from 'express';
import { db, today } from './db.js';
import { requireRole, canSeePrice, PRICE_ROLES, BASICS_ROLES } from './auth.js';

export const financeRouter = Router();

// 回款登记/删除权限：管钱的三个角色
const PAY_ROLES = ['admin', 'procurement', 'finance'];

// ===== 应收账款：按客户汇总 已出货金额 - 已回款 = 余额 =====
financeRouter.get('/receivables', requireRole(...PRICE_ROLES), (req, res) => {
  const rows = db.prepare(`
    SELECT c.id AS customer_id, c.name AS customer_name,
      COALESCE(sh.shipped_amount, 0) AS shipped_amount,
      COALESCE(sh.shipped_pieces, 0) AS shipped_pieces,
      COALESCE(sh.unpriced_pieces, 0) AS unpriced_pieces,
      sh.last_ship_date,
      COALESCE(pay.paid_amount, 0) AS paid_amount,
      pay.last_pay_date
    FROM customers c
    LEFT JOIN (
      SELECT o.customer_id,
        SUM(COALESCE(i.unit_price, 0)) AS shipped_amount,
        COUNT(*) AS shipped_pieces,
        SUM(CASE WHEN i.unit_price IS NULL THEN 1 ELSE 0 END) AS unpriced_pieces,
        MAX(s.ship_date) AS last_ship_date
      FROM shipment_pieces sp
      JOIN shipments s ON s.id = sp.shipment_id
      JOIN pieces p ON p.id = sp.piece_id
      JOIN order_items i ON i.id = p.item_id
      JOIN orders o ON o.id = p.order_id
      WHERE o.status != 'void'
      GROUP BY o.customer_id
    ) sh ON sh.customer_id = c.id
    LEFT JOIN (
      SELECT customer_id, SUM(amount) AS paid_amount, MAX(pay_date) AS last_pay_date
      FROM payments GROUP BY customer_id
    ) pay ON pay.customer_id = c.id
    WHERE sh.customer_id IS NOT NULL OR pay.customer_id IS NOT NULL
  `).all();
  const out = rows.map(r => ({
    ...r,
    shipped_amount: Math.round(r.shipped_amount * 100) / 100,
    paid_amount: Math.round(r.paid_amount * 100) / 100,
    balance: Math.round((r.shipped_amount - r.paid_amount) * 100) / 100
  })).sort((a, b) => b.balance - a.balance);
  const totals = {
    shipped: Math.round(out.reduce((s, r) => s + r.shipped_amount, 0) * 100) / 100,
    paid: Math.round(out.reduce((s, r) => s + r.paid_amount, 0) * 100) / 100,
    balance: Math.round(out.reduce((s, r) => s + r.balance, 0) * 100) / 100
  };
  res.json({ receivables: out, totals });
});

// 单客户明细：按订单的出货金额 + 回款流水
financeRouter.get('/receivables/:customerId', requireRole(...PRICE_ROLES), (req, res) => {
  const cust = db.prepare('SELECT id, name FROM customers WHERE id = ?').get(req.params.customerId);
  if (!cust) return res.status(404).json({ error: '客户不存在' });
  const orders = db.prepare(`
    SELECT o.id AS order_id, o.order_no, o.customer_po, o.status,
      COUNT(*) AS shipped_pieces,
      SUM(COALESCE(i.unit_price, 0)) AS shipped_amount,
      SUM(CASE WHEN i.unit_price IS NULL THEN 1 ELSE 0 END) AS unpriced_pieces,
      MIN(s.ship_date) AS first_ship, MAX(s.ship_date) AS last_ship
    FROM shipment_pieces sp
    JOIN shipments s ON s.id = sp.shipment_id
    JOIN pieces p ON p.id = sp.piece_id
    JOIN order_items i ON i.id = p.item_id
    JOIN orders o ON o.id = p.order_id
    WHERE o.customer_id = ? AND o.status != 'void'
    GROUP BY o.id
    ORDER BY o.order_no DESC
  `).all(cust.id).map(r => ({ ...r, shipped_amount: Math.round(r.shipped_amount * 100) / 100 }));
  const payments = db.prepare(`
    SELECT pm.id, pm.amount, pm.pay_date, pm.method, pm.note, u.name AS created_by_name
    FROM payments pm LEFT JOIN users u ON u.id = pm.created_by
    WHERE pm.customer_id = ? ORDER BY pm.pay_date DESC, pm.id DESC
  `).all(cust.id);
  res.json({ customer: cust, orders, payments });
});

financeRouter.post('/payments', requireRole(...PAY_ROLES), (req, res) => {
  const { customer_id, amount, pay_date, method, note } = req.body || {};
  const cust = db.prepare('SELECT id FROM customers WHERE id = ?').get(customer_id);
  if (!cust) return res.status(400).json({ error: '请选择客户' });
  const amt = Number(amount);
  if (!(amt > 0)) return res.status(400).json({ error: '回款金额必须大于0' });
  if (!pay_date || !/^\d{4}-\d{2}-\d{2}$/.test(String(pay_date))) return res.status(400).json({ error: '请选择回款日期' });
  const r = db.prepare(
    'INSERT INTO payments (customer_id, amount, pay_date, method, note, created_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(cust.id, amt, pay_date, method || null, note || null, req.user.id);
  res.json({ id: Number(r.lastInsertRowid) });
});

financeRouter.delete('/payments/:id', requireRole(...PAY_ROLES), (req, res) => {
  const row = db.prepare('SELECT id FROM payments WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '回款记录不存在' });
  db.prepare('DELETE FROM payments WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

// ===== 车辆：年检 / 商业保险 到期提醒（提前30天） =====
function vehicleDue(dateStr) {
  if (!dateStr) return null;
  const days = Math.round((Date.parse(dateStr) - Date.parse(today())) / 86400_000);
  return { date: dateStr, days_left: days, level: days < 0 ? 'overdue' : days <= 30 ? 'warn' : 'ok' };
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
