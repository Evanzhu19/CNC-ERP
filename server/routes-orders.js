import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { db, UPLOAD_DIR, today, verifyPassword } from './db.js';
import { requireRole, canSeePrice, ENTRY_ROLES } from './auth.js';
import { parsePurchaseOrderPdf } from './pdf-parse.js';
import { parseOrdersExcel } from './excel-parse.js';

export const ordersRouter = Router();

function yymm(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  return `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function nextOrderNo(orderDate) {
  const prefix = yymm(orderDate);
  const row = db.prepare(
    `SELECT order_no FROM orders WHERE order_no LIKE ? ORDER BY order_no DESC LIMIT 1`
  ).get(`${prefix}-%`);
  const next = row ? parseInt(row.order_no.split('-')[1], 10) + 1 : 1;
  return `${prefix}-${String(next).padStart(4, '0')}`;
}

function nextPieceSeq(orderId) {
  const row = db.prepare('SELECT MAX(seq) AS m FROM pieces WHERE order_id = ?').get(orderId);
  return (row.m || 0) + 1;
}

function createPieces(orderId, orderNo, itemId, qty) {
  let seq = nextPieceSeq(orderId);
  const ins = db.prepare('INSERT INTO pieces (item_id, order_id, seq, piece_code) VALUES (?, ?, ?, ?)');
  for (let i = 0; i < qty; i++, seq++) {
    ins.run(itemId, orderId, seq, `${orderNo}-${String(seq).padStart(2, '0')}`);
  }
}

function validItems(items) {
  if (!Array.isArray(items) || items.length === 0) return '订单至少要有一行明细';
  for (const it of items) {
    const qty = Number(it.qty);
    if (!Number.isInteger(qty) || qty <= 0) return '明细行数量必须是正整数';
    if (qty > 500) return '单行数量过大，请检查';
    if (it.unit_price != null && it.unit_price !== '' && !(Number(it.unit_price) >= 0)) return '单价格式不对';
  }
  return null;
}

ordersRouter.post('/orders', requireRole(...ENTRY_ROLES), (req, res) => {
  const { customer_id, customer_po, order_date, due_date, remark, items } = req.body || {};
  if (!customer_id) return res.status(400).json({ error: '请选择客户' });
  const err = validItems(items);
  if (err) return res.status(400).json({ error: err });
  const odate = order_date || today();
  db.exec('BEGIN');
  try {
    const orderNo = nextOrderNo(odate);
    const r = db.prepare(
      `INSERT INTO orders (order_no, customer_id, customer_po, order_date, due_date, remark, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(orderNo, customer_id, customer_po || null, odate, due_date || null, remark || null, req.user.id);
    const orderId = Number(r.lastInsertRowid);
    const insItem = db.prepare(
      `INSERT INTO order_items (order_id, line_no, part_no, drawing_no, name, spec, material, qty, unit_price, remark)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    items.forEach((it, idx) => {
      const price = canSeePrice(req) && it.unit_price !== '' && it.unit_price != null ? Number(it.unit_price) : null;
      const ri = insItem.run(orderId, idx + 1, it.part_no || null, it.drawing_no || null, it.name || null,
        it.spec || null, it.material || null, Number(it.qty), price, it.remark || null);
      createPieces(orderId, orderNo, Number(ri.lastInsertRowid), Number(it.qty));
    });
    db.exec('COMMIT');
    res.json({ id: orderId, order_no: orderNo });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

const PIECE_SUMMARY_SQL = `
  SELECT p.order_id,
    COUNT(*) AS total,
    SUM(CASE WHEN EXISTS (SELECT 1 FROM piece_stages s WHERE s.piece_id = p.id AND s.stage = 'milling') THEN 1 ELSE 0 END) AS milling,
    SUM(CASE WHEN EXISTS (SELECT 1 FROM piece_stages s WHERE s.piece_id = p.id AND s.stage = 'cnc') THEN 1 ELSE 0 END) AS cnc,
    SUM(CASE WHEN EXISTS (SELECT 1 FROM piece_stages s WHERE s.piece_id = p.id AND s.stage = 'grinding') THEN 1 ELSE 0 END) AS grinding,
    SUM(CASE WHEN EXISTS (SELECT 1 FROM piece_stages s WHERE s.piece_id = p.id AND s.stage = 'plating_back') THEN 1 ELSE 0 END) AS plating_back,
    SUM(CASE WHEN EXISTS (SELECT 1 FROM piece_stages s WHERE s.piece_id = p.id AND s.stage = 'shipped') THEN 1 ELSE 0 END) AS shipped,
    SUM(CASE WHEN EXISTS (
      SELECT 1 FROM outsourcing_pieces op JOIN outsourcing o ON o.id = op.outsourcing_id
      WHERE op.piece_id = p.id AND op.returned_date IS NULL AND o.status = 'open'
    ) THEN 1 ELSE 0 END) AS out_now,
    SUM(CASE WHEN p.wip_stage IS NOT NULL THEN 1 ELSE 0 END) AS wip_now,
    SUM(CASE WHEN p.flag IS NOT NULL THEN 1 ELSE 0 END) AS flagged_now
  FROM pieces p GROUP BY p.order_id
`;

ordersRouter.get('/orders', (req, res) => {
  const { status, customer_id, q, month } = req.query;
  const cond = [];
  const args = [];
  if (status && ['active', 'closed', 'void'].includes(status)) { cond.push('o.status = ?'); args.push(status); }
  if (customer_id) { cond.push('o.customer_id = ?'); args.push(customer_id); }
  if (month) { cond.push(`substr(o.order_date, 1, 7) = ?`); args.push(month); }
  if (q) {
    cond.push(`(o.order_no LIKE ? OR o.customer_po LIKE ? OR EXISTS (
      SELECT 1 FROM order_items i WHERE i.order_id = o.id
        AND (i.part_no LIKE ? OR i.drawing_no LIKE ? OR i.name LIKE ? OR i.spec LIKE ? OR i.material LIKE ?)
    ) OR EXISTS (
      SELECT 1 FROM pieces pc WHERE pc.order_id = o.id AND pc.piece_code LIKE ?
    ))`);
    const like = `%${String(q).trim()}%`;
    args.push(like, like, like, like, like, like, like, like);
  }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
  const getSet = k => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value;
  const warnDays = Math.max(1, Number(getSet('stall_warn_days')) || 2);
  const alertDays = Math.max(warnDays, Number(getSet('stall_alert_days')) || 4);
  const stallExpr = `
    (SELECT COUNT(*) FROM pieces p2 WHERE p2.order_id = o.id AND o.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM shipment_pieces sp2 WHERE sp2.piece_id = p2.id)
      AND julianday(datetime('now','localtime')) - julianday(MAX(
        COALESCE((SELECT MAX(s2.recorded_at) FROM piece_stages s2 WHERE s2.piece_id = p2.id), o.created_at),
        COALESCE((SELECT MAX(o32.created_at) FROM outsourcing_pieces op32 JOIN outsourcing o32 ON o32.id = op32.outsourcing_id WHERE op32.piece_id = p2.id), o.created_at),
        COALESCE((SELECT MAX(op42.returned_date) FROM outsourcing_pieces op42 WHERE op42.piece_id = p2.id), o.created_at),
        COALESCE(p2.wip_date, o.created_at),
        COALESCE(p2.flag_date, o.created_at)
      )) >= ?)`;
  const rows = db.prepare(`
    SELECT o.id, o.order_no, o.customer_po, o.order_date, o.due_date, o.status, o.remark,
      c.name AS customer_name, o.customer_id,
      ${stallExpr} AS stall_warn_count,
      ${stallExpr} AS stall_alert_count,
      ps.total, ps.milling, ps.cnc, ps.grinding, ps.plating_back, ps.shipped, ps.out_now, ps.wip_now, ps.flagged_now,
      (SELECT SUM(i.qty * COALESCE(i.unit_price, 0)) FROM order_items i WHERE i.order_id = o.id) AS amount,
      (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id AND i.unit_price IS NULL) AS unpriced_lines
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    LEFT JOIN (${PIECE_SUMMARY_SQL}) ps ON ps.order_id = o.id
    ${where}
    ORDER BY o.order_no DESC
    LIMIT 500
  `).all(warnDays, alertDays, ...args);
  if (!canSeePrice(req)) rows.forEach(r => { delete r.amount; delete r.unpriced_lines; });
  res.json({ orders: rows });
});

ordersRouter.get('/pieces/search', (req, res) => {
  const { q, status, stage } = req.query;
  const cond = [];
  const args = [];
  if (q && String(q).trim()) {
    const like = `%${String(q).trim()}%`;
    cond.push(`(p.piece_code LIKE ? OR i.part_no LIKE ? OR i.drawing_no LIKE ? OR i.name LIKE ? OR i.spec LIKE ? OR i.material LIKE ? OR ord.order_no LIKE ? OR ord.customer_po LIKE ? OR c.name LIKE ? OR p.note LIKE ?)`);
    args.push(like, like, like, like, like, like, like, like, like, like);
  }
  if (status && ['active', 'closed', 'void'].includes(status)) { cond.push('ord.status = ?'); args.push(status); }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

  const getSet = k => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value;
  const warnDays = Math.max(1, Number(getSet('stall_warn_days')) || 2);
  const alertDays = Math.max(warnDays, Number(getSet('stall_alert_days')) || 4);

  const rows = db.prepare(`
    SELECT p.id, p.piece_code, p.order_id, p.note, p.wip_stage, p.wip_note, p.flag, p.flag_note,
      ord.order_no, ord.customer_po, ord.status AS order_status, ord.due_date,
      c.name AS customer_name,
      i.part_no, i.drawing_no, i.name AS item_name, i.spec, i.material,
      (SELECT MAX(s.done_date) FROM piece_stages s WHERE s.piece_id = p.id AND s.stage = 'milling') AS m_milling,
      (SELECT MAX(s.done_date) FROM piece_stages s WHERE s.piece_id = p.id AND s.stage = 'cnc') AS m_cnc,
      (SELECT MAX(s.done_date) FROM piece_stages s WHERE s.piece_id = p.id AND s.stage = 'grinding') AS m_grinding,
      (SELECT MAX(s.done_date) FROM piece_stages s WHERE s.piece_id = p.id AND s.stage = 'plating_back') AS m_plating_back,
      (SELECT MAX(s.done_date) FROM piece_stages s WHERE s.piece_id = p.id AND s.stage = 'shipped') AS m_shipped,
      (SELECT o5.type || '|' || o5.status || '|' || o5.batch_no || '|' || v5.name
        FROM outsourcing_pieces op5 JOIN outsourcing o5 ON o5.id = op5.outsourcing_id JOIN vendors v5 ON v5.id = o5.vendor_id
        WHERE op5.piece_id = p.id AND op5.returned_date IS NULL AND o5.status IN ('draft','open') LIMIT 1) AS out_info,
      MAX(
        COALESCE((SELECT MAX(s.recorded_at) FROM piece_stages s WHERE s.piece_id = p.id), ord.created_at),
        COALESCE((SELECT MAX(o3.created_at) FROM outsourcing_pieces op3 JOIN outsourcing o3 ON o3.id = op3.outsourcing_id WHERE op3.piece_id = p.id), ord.created_at),
        COALESCE((SELECT MAX(op4.returned_date) FROM outsourcing_pieces op4 WHERE op4.piece_id = p.id), ord.created_at),
        COALESCE(p.wip_date, ord.created_at),
        COALESCE(p.flag_date, ord.created_at)
      ) AS last_act
    FROM pieces p
    JOIN orders ord ON ord.id = p.order_id
    JOIN order_items i ON i.id = p.item_id
    JOIN customers c ON c.id = ord.customer_id
    ${where}
    GROUP BY p.id
    ORDER BY ord.order_no DESC, p.seq
    LIMIT 300
  `).all(...args);

  const WIP = { milling: '铣磨中', cnc: 'CNC加工中', grinding: '精磨中' };
  const FLAG = { repair: '维修中', rework: '返工中', redraw: '改图暂停' };
  const OUT_PROC = { milling: '铣磨', cnc: 'CNC', grinding: '精磨', plating: '电镀' };
  const result = [];
  for (const r of rows) {
    const shipped = !!r.m_shipped;
    let statusLabel, statusType;
    if (shipped) { statusLabel = '已出货'; statusType = 'success'; }
    else if (r.flag) { statusLabel = FLAG[r.flag] || r.flag; statusType = 'special'; }
    else if (r.out_info) {
      const [type, st, batch, vendor] = r.out_info.split('|');
      const label = String(type).split(',').map(t => OUT_PROC[t] || t).join('+');
      statusLabel = (st === 'draft' ? `${label}外发待确认·${vendor}` : (type === 'plating' ? `电镀中·${vendor}` : `${label}外发·${vendor}`));
      statusType = 'warning';
    }
    else if (r.wip_stage) { statusLabel = (WIP[r.wip_stage] || '') + (r.wip_note ? '·' + r.wip_note : ''); statusType = 'wip'; }
    else if (r.m_plating_back) { statusLabel = '待出货'; statusType = 'primary'; }
    else if (r.m_grinding) { statusLabel = '待电镀'; statusType = 'info'; }
    else if (r.m_cnc) { statusLabel = '待精磨'; statusType = 'info'; }
    else if (r.m_milling) { statusLabel = '待CNC'; statusType = 'info'; }
    else { statusLabel = '待铣磨'; statusType = 'info'; }

    const idleDays = shipped ? 0 : Math.max(0, Math.floor((Date.now() - new Date(String(r.last_act).replace(' ', 'T')).getTime()) / 86400_000));
    const stallLevel = shipped || r.order_status !== 'active' ? null : (idleDays >= alertDays ? 'alert' : idleDays >= warnDays ? 'warn' : null);

    if (stage) {
      const cur = shipped ? 'shipped'
        : r.out_info ? 'out'
        : r.m_plating_back ? 'plating_done'
        : r.m_grinding ? 'wait_plating'
        : r.m_cnc ? 'wait_grinding'
        : r.m_milling ? 'wait_cnc' : 'wait_milling';
      if (stage !== cur) continue;
    }

    result.push({
      id: r.id, piece_code: r.piece_code, order_id: r.order_id, order_no: r.order_no,
      customer_po: r.customer_po,
      order_status: r.order_status, customer_name: r.customer_name, due_date: r.due_date,
      part_no: r.part_no, drawing_no: r.drawing_no, item_name: r.item_name, spec: r.spec, material: r.material,
      note: r.note, status_label: statusLabel, status_type: statusType,
      idle_days: idleDays, stall_level: stallLevel,
      done: { milling: r.m_milling, cnc: r.m_cnc, grinding: r.m_grinding, plating_back: r.m_plating_back, shipped: r.m_shipped }
    });
  }
  res.json({ pieces: result, stall_warn_days: warnDays, stall_alert_days: alertDays });
});

ordersRouter.get('/orders/:id', (req, res) => {
  const order = db.prepare(`
    SELECT o.*, c.name AS customer_name, u.name AS created_by_name
    FROM orders o JOIN customers c ON c.id = o.customer_id
    LEFT JOIN users u ON u.id = o.created_by
    WHERE o.id = ?
  `).get(req.params.id);
  if (!order) return res.status(404).json({ error: '订单不存在' });

  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY line_no').all(order.id);
  const pieces = db.prepare(`
    SELECT p.*,
      MAX(
        COALESCE((SELECT MAX(s.recorded_at) FROM piece_stages s WHERE s.piece_id = p.id), o.created_at),
        COALESCE((SELECT MAX(o3.created_at) FROM outsourcing_pieces op3 JOIN outsourcing o3 ON o3.id = op3.outsourcing_id WHERE op3.piece_id = p.id), o.created_at),
        COALESCE((SELECT MAX(op4.returned_date) FROM outsourcing_pieces op4 WHERE op4.piece_id = p.id), o.created_at),
        COALESCE(p.wip_date, o.created_at),
        COALESCE(p.flag_date, o.created_at)
      ) AS last_act
    FROM pieces p JOIN orders o ON o.id = p.order_id
    WHERE p.order_id = ? GROUP BY p.id ORDER BY p.seq
  `).all(order.id);
  const stages = db.prepare(`
    SELECT s.piece_id, s.stage, s.done_date, s.note, s.recorded_at, u.name AS recorded_by_name
    FROM piece_stages s LEFT JOIN users u ON u.id = s.recorded_by
    WHERE s.piece_id IN (SELECT id FROM pieces WHERE order_id = ?)
  `).all(order.id);
  const outs = db.prepare(`
    SELECT op.piece_id, op.returned_date, o.id AS outsourcing_id, o.batch_no, o.type, o.sent_date, o.expected_date, o.status, v.name AS vendor_name, o.note
    FROM outsourcing_pieces op
    JOIN outsourcing o ON o.id = op.outsourcing_id
    JOIN vendors v ON v.id = o.vendor_id
    WHERE op.piece_id IN (SELECT id FROM pieces WHERE order_id = ?)
    ORDER BY o.sent_date
  `).all(order.id);
  const shipRows = db.prepare(`
    SELECT sp.piece_id, s.id AS shipment_id, s.ship_no, s.ship_date
    FROM shipment_pieces sp JOIN shipments s ON s.id = sp.shipment_id
    WHERE s.order_id = ?
  `).all(order.id);
  const attachments = db.prepare(`
    SELECT a.id, a.item_id, a.orig_name, a.size, a.uploaded_at, u.name AS uploaded_by_name
    FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
    WHERE a.order_id = ? ORDER BY a.id
  `).all(order.id);
  const shipments = db.prepare(`
    SELECT s.id, s.ship_no, s.ship_date, s.note, u.name AS created_by_name,
      (SELECT COUNT(*) FROM shipment_pieces sp WHERE sp.shipment_id = s.id) AS piece_count
    FROM shipments s LEFT JOIN users u ON u.id = s.created_by
    WHERE s.order_id = ? ORDER BY s.id
  `).all(order.id);

  const stageMap = {};
  for (const s of stages) {
    (stageMap[s.piece_id] ||= {})[s.stage] = { done_date: s.done_date, note: s.note, by: s.recorded_by_name, recorded_at: s.recorded_at };
  }
  const outMap = {};
  for (const o of outs) (outMap[o.piece_id] ||= []).push(o);
  const shipMap = {};
  for (const s of shipRows) shipMap[s.piece_id] = s;

  const showPrice = canSeePrice(req);
  const itemsOut = items.map(it => {
    const row = { ...it };
    if (!showPrice) { delete row.unit_price; }
    else { row.amount = it.unit_price != null ? it.unit_price * it.qty : null; }
    row.pieces = pieces.filter(p => p.item_id === it.id).map(p => ({
      id: p.id, seq: p.seq, piece_code: p.piece_code,
      wip_stage: p.wip_stage, wip_date: p.wip_date, wip_note: p.wip_note,
      note: p.note, flag: p.flag, flag_note: p.flag_note, flag_date: p.flag_date,
      idle_days: p.last_act && !shipMap[p.id]
        ? Math.max(0, Math.floor((Date.now() - new Date(String(p.last_act).replace(' ', 'T')).getTime()) / 86400_000))
        : 0,
      stages: stageMap[p.id] || {},
      outsourcing: (outMap[p.id] || []),
      shipment: shipMap[p.id] || null
    }));
    return row;
  });
  if (!showPrice) delete order.amount;
  const amount = showPrice
    ? items.reduce((s, it) => s + (it.unit_price != null ? it.unit_price * it.qty : 0), 0)
    : undefined;

  res.json({ order: { ...order, ...(showPrice ? { amount } : {}) }, items: itemsOut, attachments, shipments });
});

function pieceHasHistory(pieceId) {
  const a = db.prepare('SELECT COUNT(*) AS n FROM piece_stages WHERE piece_id = ?').get(pieceId).n;
  const b = db.prepare('SELECT COUNT(*) AS n FROM outsourcing_pieces WHERE piece_id = ?').get(pieceId).n;
  const c = db.prepare('SELECT COUNT(*) AS n FROM shipment_pieces WHERE piece_id = ?').get(pieceId).n;
  return a + b + c > 0;
}

ordersRouter.put('/orders/:id', requireRole(...ENTRY_ROLES), (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: '订单不存在' });
  if (order.status === 'void') return res.status(400).json({ error: '订单已作废' });
  const { customer_id, customer_po, order_date, due_date, remark, items } = req.body || {};
  if (!customer_id) return res.status(400).json({ error: '请选择客户' });
  const err = validItems(items);
  if (err) return res.status(400).json({ error: err });

  db.exec('BEGIN');
  try {
    db.prepare('UPDATE orders SET customer_id = ?, customer_po = ?, order_date = ?, due_date = ?, remark = ? WHERE id = ?')
      .run(customer_id, customer_po || null, order_date || order.order_date, due_date || null, remark || null, order.id);

    const existing = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
    const keptIds = new Set(items.filter(i => i.id).map(i => Number(i.id)));
    for (const ex of existing) {
      if (!keptIds.has(ex.id)) {
        const ps = db.prepare('SELECT id FROM pieces WHERE item_id = ?').all(ex.id);
        for (const p of ps) {
          if (pieceHasHistory(p.id)) throw new Error(`第${ex.line_no}行已有生产记录，不能删除`);
        }
        db.prepare('DELETE FROM pieces WHERE item_id = ?').run(ex.id);
        db.prepare('DELETE FROM order_items WHERE id = ?').run(ex.id);
      }
    }
    let lineNo = 0;
    for (const it of items) {
      lineNo++;
      const price = canSeePrice(req)
        ? (it.unit_price !== '' && it.unit_price != null ? Number(it.unit_price) : null)
        : undefined;
      if (it.id) {
        const ex = existing.find(e => e.id === Number(it.id));
        if (!ex) throw new Error('明细行不存在');
        const newQty = Number(it.qty);
        if (newQty !== ex.qty) {
          const ps = db.prepare('SELECT id, seq FROM pieces WHERE item_id = ? ORDER BY seq').all(ex.id);
          if (newQty > ex.qty) {
            createPieces(order.id, order.order_no, ex.id, newQty - ex.qty);
          } else {
            let toRemove = ex.qty - newQty;
            for (let i = ps.length - 1; i >= 0 && toRemove > 0; i--) {
              if (pieceHasHistory(ps[i].id)) throw new Error(`第${lineNo}行已有生产记录的板件不能减掉`);
              db.prepare('DELETE FROM pieces WHERE id = ?').run(ps[i].id);
              toRemove--;
            }
          }
        }
        if (price === undefined) {
          db.prepare(`UPDATE order_items SET line_no=?, part_no=?, drawing_no=?, name=?, spec=?, material=?, qty=?, remark=? WHERE id=?`)
            .run(lineNo, it.part_no || null, it.drawing_no || null, it.name || null, it.spec || null, it.material || null, newQty ?? ex.qty, it.remark || null, ex.id);
        } else {
          db.prepare(`UPDATE order_items SET line_no=?, part_no=?, drawing_no=?, name=?, spec=?, material=?, qty=?, unit_price=?, remark=? WHERE id=?`)
            .run(lineNo, it.part_no || null, it.drawing_no || null, it.name || null, it.spec || null, it.material || null, Number(it.qty), price, it.remark || null, ex.id);
        }
      } else {
        const ri = db.prepare(
          `INSERT INTO order_items (order_id, line_no, part_no, drawing_no, name, spec, material, qty, unit_price, remark)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(order.id, lineNo, it.part_no || null, it.drawing_no || null, it.name || null, it.spec || null,
          it.material || null, Number(it.qty), price === undefined ? null : price, it.remark || null);
        createPieces(order.id, order.order_no, Number(ri.lastInsertRowid), Number(it.qty));
      }
    }
    db.exec('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    db.exec('ROLLBACK');
    res.status(400).json({ error: e.message || '保存失败' });
  }
});

ordersRouter.post('/orders/:id/status', requireRole(...ENTRY_ROLES), (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: '订单不存在' });
  const { status } = req.body || {};
  if (!['active', 'closed', 'void'].includes(status)) return res.status(400).json({ error: '状态无效' });
  if (status === 'closed') {
    const unshipped = db.prepare(`
      SELECT COUNT(*) AS n FROM pieces p WHERE p.order_id = ?
      AND NOT EXISTS (SELECT 1 FROM shipment_pieces sp WHERE sp.piece_id = p.id)
    `).get(order.id).n;
    if (unshipped > 0 && req.user.role !== 'admin' && req.user.role !== 'cnc_manager') {
      return res.status(400).json({ error: `还有 ${unshipped} 件未出货，不能结案` });
    }
  }
  if (status === 'void') {
    const hasHistory = db.prepare(`
      SELECT COUNT(*) AS n FROM piece_stages s
      WHERE s.piece_id IN (SELECT id FROM pieces WHERE order_id = ?)
    `).get(order.id).n;
    if (hasHistory > 0) return res.status(400).json({ error: '已有生产记录的订单不能作废' });
  }
  if (status === 'void') {
    db.prepare(`UPDATE orders SET status = ?, voided_at = datetime('now','localtime') WHERE id = ?`).run(status, order.id);
  } else {
    db.prepare('UPDATE orders SET status = ?, voided_at = NULL WHERE id = ?').run(status, order.id);
  }
  res.json({ ok: true });
});

export function deleteOrderCompletely(orderId) {
  const files = db.prepare('SELECT stored_name FROM attachments WHERE order_id = ?').all(orderId);
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM outsourcing_pieces WHERE piece_id IN (SELECT id FROM pieces WHERE order_id = ?)').run(orderId);
    db.prepare('DELETE FROM outsourcing WHERE id NOT IN (SELECT DISTINCT outsourcing_id FROM outsourcing_pieces)').run();
    db.prepare('DELETE FROM shipment_pieces WHERE piece_id IN (SELECT id FROM pieces WHERE order_id = ?)').run(orderId);
    db.prepare('DELETE FROM shipments WHERE order_id = ?').run(orderId);
    db.prepare('DELETE FROM piece_stages WHERE piece_id IN (SELECT id FROM pieces WHERE order_id = ?)').run(orderId);
    db.prepare('DELETE FROM pieces WHERE order_id = ?').run(orderId);
    db.prepare('DELETE FROM order_items WHERE order_id = ?').run(orderId);
    db.prepare('DELETE FROM attachments WHERE order_id = ?').run(orderId);
    db.prepare('DELETE FROM orders WHERE id = ?').run(orderId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  for (const f of files) {
    try {
      const fp = path.join(UPLOAD_DIR, f.stored_name);
      if (existsSync(fp)) unlinkSync(fp);
    } catch {}
  }
}

export function purgeExpiredVoidedOrders() {
  const expired = db.prepare(`
    SELECT id, order_no FROM orders
    WHERE status = 'void' AND voided_at IS NOT NULL
      AND voided_at < datetime('now', 'localtime', '-15 days')
  `).all();
  for (const o of expired) {
    try {
      deleteOrderCompletely(o.id);
      console.log(`[清理] 作废订单 ${o.order_no} 已超15天，自动删除`);
    } catch (e) {
      console.error(`[清理] 删除作废订单 ${o.order_no} 失败:`, e.message);
    }
  }
  return expired.length;
}

ordersRouter.delete('/orders/:id', requireRole('admin', 'cnc_manager'), (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: '订单不存在' });

  if (order.status === 'void') {
    deleteOrderCompletely(order.id);
    return res.json({ ok: true });
  }

  if (order.status === 'closed') {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: '删除已结案订单需要总经理授权' });
    }
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: '请输入登录密码进行授权确认' });
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(String(password), row.password_hash)) {
      return res.status(400).json({ error: '密码不正确，删除已取消' });
    }
    deleteOrderCompletely(order.id);
    return res.json({ ok: true });
  }

  return res.status(400).json({ error: '进行中的订单不能直接删除（请先作废或结案）' });
});

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).slice(0, 10);
      cb(null, `${Date.now()}_${randomBytes(6).toString('hex')}${ext}`);
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 }
});

ordersRouter.post('/orders/:id/attachments', requireRole(...ENTRY_ROLES), upload.array('files', 10), (req, res) => {
  const order = db.prepare('SELECT id FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: '订单不存在' });
  const itemId = req.body.item_id ? Number(req.body.item_id) : null;
  const ins = db.prepare(
    'INSERT INTO attachments (order_id, item_id, orig_name, stored_name, size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const f of req.files || []) {
    const origName = Buffer.from(f.originalname, 'latin1').toString('utf8');
    ins.run(order.id, itemId, origName, f.filename, f.size, req.user.id);
  }
  res.json({ ok: true, count: (req.files || []).length });
});

const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 }
});

ordersRouter.post('/orders/parse-pdf', requireRole(...ENTRY_ROLES), pdfUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择PDF文件' });
  try {
    const result = await parsePurchaseOrderPdf(req.file.buffer);
    if (result.error) return res.status(422).json({ error: result.message, meta: result.meta || {} });
    const customerId = req.body.customer_id ? Number(req.body.customer_id) : null;
    if (customerId && result.headers) {
      const saved = db.prepare('SELECT mapping FROM pdf_mappings WHERE customer_id = ?').get(customerId);
      if (saved) {
        try {
          const map = JSON.parse(saved.mapping);
          result.guesses = result.headers.map((h, i) => {
            const key = String(h).replace(/\s/g, '');
            return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : result.guesses[i];
          });
        } catch {}
      }
    }
    res.json(result);
  } catch (e) {
    console.error('PDF解析失败:', e);
    res.status(422).json({ error: 'PDF解析失败：' + (e.message || '文件可能已损坏') });
  }
});

ordersRouter.post('/orders/parse-excel', requireRole(...ENTRY_ROLES), pdfUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择Excel文件' });
  let result;
  try {
    result = parseOrdersExcel(req.file.buffer);
  } catch (e) {
    console.error('Excel解析失败:', e);
    return res.status(422).json({ error: 'Excel解析失败：' + (e.message || '文件可能已损坏') });
  }
  const showPrice = canSeePrice(req);
  const custStmt = db.prepare('SELECT id FROM customers WHERE replace(name, \' \', \'\') = ?');
  const poStmt = db.prepare('SELECT o.order_no FROM orders o WHERE o.customer_po = ? LIMIT 1');
  for (const sheet of result.sheets) {
    for (const order of sheet.orders) {
      order.customer_exists = !!custStmt.get(order.customer_name.replace(/\s/g, ''));
      const dup = order.customer_po ? poStmt.get(order.customer_po) : null;
      order.po_exists = dup ? dup.order_no : null;
      if (showPrice) {
        order.amount = order.lines.reduce((s, l) => s + (l.unit_price != null ? l.unit_price * l.qty : 0), 0);
      } else {
        for (const l of order.lines) delete l.unit_price;
      }
    }
  }
  res.json(result);
});

ordersRouter.post('/orders/import-excel', requireRole(...ENTRY_ROLES), (req, res) => {
  const { orders } = req.body || {};
  if (!Array.isArray(orders) || orders.length === 0) return res.status(400).json({ error: '没有要导入的订单' });
  if (orders.length > 200) return res.status(400).json({ error: '一次最多导入200张订单' });

  const created = [];
  const skipped = [];
  const customersCreated = [];
  const showPrice = canSeePrice(req);

  db.exec('BEGIN');
  try {
    for (const o of orders) {
      const custName = String(o.customer_name || '').trim();
      if (!custName) { skipped.push({ customer_po: o.customer_po, reason: '缺客户名' }); continue; }
      const lines = (o.lines || []).filter(l => Number.isInteger(Number(l.qty)) && Number(l.qty) > 0 && Number(l.qty) <= 2000);
      if (!lines.length) { skipped.push({ customer_po: o.customer_po, reason: '没有有效明细行' }); continue; }
      if (o.customer_po) {
        const dup = db.prepare('SELECT id FROM orders WHERE customer_po = ?').get(o.customer_po);
        if (dup) { skipped.push({ customer_po: o.customer_po, reason: '客户单号已存在，跳过' }); continue; }
      }

      let cust = db.prepare(`SELECT id FROM customers WHERE replace(name, ' ', '') = ?`).get(custName.replace(/\s/g, ''));
      if (!cust) {
        const r = db.prepare('INSERT INTO customers (name) VALUES (?)').run(custName);
        cust = { id: Number(r.lastInsertRowid) };
        customersCreated.push(custName);
      }

      const odate = today();
      const orderNo = nextOrderNo(odate);
      const ro = db.prepare(
        `INSERT INTO orders (order_no, customer_id, customer_po, order_date, due_date, remark, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(orderNo, cust.id, o.customer_po || null, odate, o.due_date || null, 'Excel台账导入', req.user.id);
      const orderId = Number(ro.lastInsertRowid);
      let pieceCount = 0;
      lines.forEach((l, idx) => {
        const price = showPrice && l.unit_price != null && l.unit_price !== '' ? Number(l.unit_price) : null;
        const ri = db.prepare(
          `INSERT INTO order_items (order_id, line_no, part_no, drawing_no, name, spec, material, qty, unit_price, remark)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(orderId, idx + 1, l.part_no || null, l.drawing_no || null, l.name || null, l.spec || null,
          l.material || null, Number(l.qty), price, l.remark || null);
        createPieces(orderId, orderNo, Number(ri.lastInsertRowid), Number(l.qty));
        pieceCount += Number(l.qty);
      });
      created.push({ order_no: orderNo, customer_name: custName, customer_po: o.customer_po, lines: lines.length, pieces: pieceCount });
    }
    db.exec('COMMIT');
    res.json({ created, skipped, customers_created: customersCreated });
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('Excel导入失败:', e);
    res.status(400).json({ error: '导入失败，已全部回滚：' + e.message });
  }
});

ordersRouter.post('/pdf-mappings', requireRole(...ENTRY_ROLES), (req, res) => {
  const { customer_id, headers, fields } = req.body || {};
  if (!customer_id || !Array.isArray(headers) || !Array.isArray(fields)) {
    return res.status(400).json({ error: '参数不完整' });
  }
  const map = {};
  headers.forEach((h, i) => {
    const key = String(h).replace(/\s/g, '');
    if (key && fields[i]) map[key] = fields[i];
  });
  db.prepare(`
    INSERT INTO pdf_mappings (customer_id, mapping) VALUES (?, ?)
    ON CONFLICT(customer_id) DO UPDATE SET mapping = excluded.mapping, updated_at = datetime('now','localtime')
  `).run(customer_id, JSON.stringify(map));
  res.json({ ok: true });
});

ordersRouter.get('/attachments/:id/download', (req, res) => {
  const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: '附件不存在' });
  const fp = path.join(UPLOAD_DIR, a.stored_name);
  if (!existsSync(fp)) return res.status(404).json({ error: '文件已丢失' });
  res.download(fp, a.orig_name);
});

ordersRouter.delete('/attachments/:id', requireRole(...ENTRY_ROLES), (req, res) => {
  const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: '附件不存在' });
  db.prepare('DELETE FROM attachments WHERE id = ?').run(a.id);
  const fp = path.join(UPLOAD_DIR, a.stored_name);
  try { if (existsSync(fp)) unlinkSync(fp); } catch {}
  res.json({ ok: true });
});
