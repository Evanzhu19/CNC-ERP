import { Router } from 'express';
import { db, today } from './db.js';
import { requireRole, canSeePrice, ENTRY_ROLES } from './auth.js';

export const productionRouter = Router();

const MANUAL_STAGES = ['milling', 'cnc', 'grinding'];

function yymm(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  return `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function nextNo(table, col, prefix) {
  const row = db.prepare(`SELECT ${col} AS no FROM ${table} WHERE ${col} LIKE ? ORDER BY ${col} DESC LIMIT 1`).get(`${prefix}-%`);
  const next = row ? parseInt(row.no.split('-').pop(), 10) + 1 : 1;
  return `${prefix}-${String(next).padStart(3, '0')}`;
}

function getPieces(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const ph = ids.map(() => '?').join(',');
  return db.prepare(`SELECT * FROM pieces WHERE id IN (${ph})`).all(...ids);
}

function isShipped(pieceId) {
  return !!db.prepare('SELECT 1 FROM shipment_pieces WHERE piece_id = ?').get(pieceId);
}

function openOutsourcing(pieceId) {
  return db.prepare(`
    SELECT o.id, o.type, o.batch_no, o.status, v.name AS vendor_name
    FROM outsourcing_pieces op
    JOIN outsourcing o ON o.id = op.outsourcing_id
    JOIN vendors v ON v.id = o.vendor_id
    WHERE op.piece_id = ? AND op.returned_date IS NULL AND o.status IN ('draft', 'open')
  `).get(pieceId);
}

function upsertStage(pieceId, stage, doneDate, note, userId) {
  db.prepare(`
    INSERT INTO piece_stages (piece_id, stage, done_date, note, recorded_by)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(piece_id, stage) DO UPDATE SET
      done_date = excluded.done_date,
      note = excluded.note,
      recorded_by = excluded.recorded_by,
      recorded_at = datetime('now','localtime')
  `).run(pieceId, stage, doneDate, note || null, userId);
}

productionRouter.post('/progress', requireRole(...ENTRY_ROLES), (req, res) => {
  const { piece_ids, stage, done_date, note } = req.body || {};
  if (!MANUAL_STAGES.includes(stage)) return res.status(400).json({ error: '工序无效' });
  const pieces = getPieces(piece_ids);
  if (pieces.length === 0) return res.status(400).json({ error: '请至少选择一件' });
  const date = done_date || today();
  db.exec('BEGIN');
  try {
    for (const p of pieces) {
      if (isShipped(p.id)) throw new Error(`${p.piece_code} 已出货，不能改工序`);
      const out = openOutsourcing(p.id);
      if (out) throw new Error(`${p.piece_code} 正在外发（${out.vendor_name}），先登记回货`);
      upsertStage(p.id, stage, date, note, req.user.id);
      db.prepare(`UPDATE pieces SET wip_stage = NULL, wip_date = NULL, wip_by = NULL, wip_note = NULL WHERE id = ? AND wip_stage = ?`)
        .run(p.id, stage);
    }
    db.exec('COMMIT');
    res.json({ ok: true, count: pieces.length });
  } catch (e) {
    db.exec('ROLLBACK');
    res.status(400).json({ error: e.message });
  }
});

const WIP_NAMES = { milling: '铣磨', cnc: 'CNC', grinding: '精磨' };

productionRouter.post('/progress/start', requireRole(...ENTRY_ROLES), (req, res) => {
  const { piece_ids, stage, note, start_date } = req.body || {};
  if (!MANUAL_STAGES.includes(stage)) return res.status(400).json({ error: '工序无效' });
  const pieces = getPieces(piece_ids);
  if (pieces.length === 0) return res.status(400).json({ error: '请至少选择一件' });
  const date = start_date || today();
  db.exec('BEGIN');
  try {
    for (const p of pieces) {
      if (isShipped(p.id)) throw new Error(`${p.piece_code} 已出货`);
      const out = openOutsourcing(p.id);
      if (out) throw new Error(`${p.piece_code} 正在外发（${out.vendor_name}），不能标开工`);
      const done = db.prepare('SELECT 1 FROM piece_stages WHERE piece_id = ? AND stage = ?').get(p.id, stage);
      if (done) throw new Error(`${p.piece_code} 的${WIP_NAMES[stage]}已报完工，不用再标开工`);
      db.prepare('UPDATE pieces SET wip_stage = ?, wip_date = ?, wip_by = ?, wip_note = ? WHERE id = ?')
        .run(stage, date, req.user.id, note || null, p.id);
    }
    db.exec('COMMIT');
    res.json({ ok: true, count: pieces.length });
  } catch (e) {
    db.exec('ROLLBACK');
    res.status(400).json({ error: e.message });
  }
});

productionRouter.post('/progress/clear-wip', requireRole(...ENTRY_ROLES), (req, res) => {
  const pieces = getPieces(req.body?.piece_ids);
  if (pieces.length === 0) return res.status(400).json({ error: '请至少选择一件' });
  const ph = pieces.map(() => '?').join(',');
  db.prepare(`UPDATE pieces SET wip_stage = NULL, wip_date = NULL, wip_by = NULL, wip_note = NULL WHERE id IN (${ph})`)
    .run(...pieces.map(p => p.id));
  res.json({ ok: true });
});

productionRouter.post('/progress/undo', requireRole(...ENTRY_ROLES), (req, res) => {
  const { piece_ids, stage } = req.body || {};
  if (!MANUAL_STAGES.includes(stage)) return res.status(400).json({ error: '该工序不能在这里撤销' });
  const pieces = getPieces(piece_ids);
  if (pieces.length === 0) return res.status(400).json({ error: '请至少选择一件' });
  db.exec('BEGIN');
  try {
    for (const p of pieces) {
      if (isShipped(p.id)) throw new Error(`${p.piece_code} 已出货，不能改工序`);
      db.prepare('DELETE FROM piece_stages WHERE piece_id = ? AND stage = ?').run(p.id, stage);
    }
    db.exec('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    db.exec('ROLLBACK');
    res.status(400).json({ error: e.message });
  }
});

productionRouter.post('/outsourcing', requireRole(...ENTRY_ROLES), (req, res) => {
  const { type, vendor_id, sent_date, expected_date, note, piece_ids } = req.body || {};
  if (!['cnc', 'grinding', 'plating'].includes(type)) return res.status(400).json({ error: '外发类型无效' });
  if (!vendor_id) return res.status(400).json({ error: '请选择外协厂家' });
  const vendor = db.prepare('SELECT * FROM vendors WHERE id = ? AND active = 1').get(vendor_id);
  if (!vendor) return res.status(400).json({ error: '请选择外协厂家' });
  const pieces = getPieces(piece_ids);
  if (pieces.length === 0) return res.status(400).json({ error: '请至少选择一件' });
  const sdate = sent_date || today();
  db.exec('BEGIN');
  try {
    const batchNo = nextNo('outsourcing', 'batch_no', `W${yymm(sdate)}`);
    const r = db.prepare(`
      INSERT INTO outsourcing (batch_no, type, vendor_id, sent_date, expected_date, note, status, created_by)
      VALUES (?, ?, ?, ?, ?, ?, 'draft', ?)
    `).run(batchNo, type, vendor.id, sdate, expected_date || null, note || null, req.user.id);
    const oid = Number(r.lastInsertRowid);
    const ins = db.prepare('INSERT INTO outsourcing_pieces (outsourcing_id, piece_id) VALUES (?, ?)');
    for (const p of pieces) {
      if (isShipped(p.id)) throw new Error(`${p.piece_code} 已出货`);
      const out = openOutsourcing(p.id);
      if (out) throw new Error(`${p.piece_code} 已在外发单 ${out.batch_no} 里（${out.vendor_name}）`);
      ins.run(oid, p.id);
    }
    db.exec('COMMIT');
    res.json({ id: oid, batch_no: batchNo, status: 'draft' });
  } catch (e) {
    db.exec('ROLLBACK');
    res.status(400).json({ error: e.message });
  }
});

productionRouter.post('/outsourcing/:id/confirm', requireRole(...ENTRY_ROLES), (req, res) => {
  const batch = db.prepare('SELECT o.*, v.name AS vendor_name FROM outsourcing o JOIN vendors v ON v.id = o.vendor_id WHERE o.id = ?').get(req.params.id);
  if (!batch) return res.status(404).json({ error: '外发单不存在' });
  if (batch.status !== 'draft') return res.status(400).json({ error: '这张外发单已经确认过了' });
  db.exec('BEGIN');
  try {
    const pieceRows = db.prepare('SELECT piece_id FROM outsourcing_pieces WHERE outsourcing_id = ?').all(batch.id);
    for (const { piece_id } of pieceRows) {
      if (batch.type === 'plating') {
        upsertStage(piece_id, 'plating_sent', batch.sent_date, `外发电镀：${batch.vendor_name}`, req.user.id);
      }
      db.prepare('UPDATE pieces SET wip_stage = NULL, wip_date = NULL, wip_by = NULL, wip_note = NULL WHERE id = ?').run(piece_id);
    }
    db.prepare(`UPDATE outsourcing SET status = 'open' WHERE id = ?`).run(batch.id);
    db.exec('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    db.exec('ROLLBACK');
    res.status(400).json({ error: e.message });
  }
});

productionRouter.post('/outsourcing/:id/return', requireRole(...ENTRY_ROLES), (req, res) => {
  const batch = db.prepare('SELECT o.*, v.name AS vendor_name FROM outsourcing o JOIN vendors v ON v.id = o.vendor_id WHERE o.id = ?').get(req.params.id);
  if (!batch) return res.status(404).json({ error: '外发单不存在' });
  if (batch.status === 'draft') return res.status(400).json({ error: '这张外发单还没确认外发，不能登记回货（在打印页或外发管理里先确认）' });
  const { piece_ids, returned_date } = req.body || {};
  const rdate = returned_date || today();
  const pieces = getPieces(piece_ids);
  if (pieces.length === 0) return res.status(400).json({ error: '请至少选择一件' });
  db.exec('BEGIN');
  try {
    for (const p of pieces) {
      const op = db.prepare('SELECT * FROM outsourcing_pieces WHERE outsourcing_id = ? AND piece_id = ?').get(batch.id, p.id);
      if (!op) throw new Error(`${p.piece_code} 不在这张外发单里`);
      if (op.returned_date) continue;
      db.prepare('UPDATE outsourcing_pieces SET returned_date = ? WHERE outsourcing_id = ? AND piece_id = ?')
        .run(rdate, batch.id, p.id);
      if (batch.type === 'plating') {
        upsertStage(p.id, 'plating_back', rdate, `电镀回厂：${batch.vendor_name}`, req.user.id);
      } else if (batch.type === 'grinding') {
        upsertStage(p.id, 'grinding', rdate, `精磨外发回厂：${batch.vendor_name}`, req.user.id);
      } else {
        upsertStage(p.id, 'cnc', rdate, `CNC外发回厂：${batch.vendor_name}`, req.user.id);
      }
    }
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM outsourcing_pieces WHERE outsourcing_id = ? AND returned_date IS NULL').get(batch.id).n;
    if (remaining === 0) db.prepare(`UPDATE outsourcing SET status = 'done' WHERE id = ?`).run(batch.id);
    db.exec('COMMIT');
    res.json({ ok: true, all_returned: remaining === 0 });
  } catch (e) {
    db.exec('ROLLBACK');
    res.status(400).json({ error: e.message });
  }
});

productionRouter.post('/outsourcing/:id/remove', requireRole(...ENTRY_ROLES), (req, res) => {
  const batch = db.prepare('SELECT * FROM outsourcing WHERE id = ?').get(req.params.id);
  if (!batch) return res.status(404).json({ error: '外发单不存在' });
  const pieces = getPieces(req.body?.piece_ids);
  if (pieces.length === 0) return res.status(400).json({ error: '请至少选择一件' });
  db.exec('BEGIN');
  try {
    for (const p of pieces) {
      const op = db.prepare('SELECT * FROM outsourcing_pieces WHERE outsourcing_id = ? AND piece_id = ?').get(batch.id, p.id);
      if (!op) throw new Error(`${p.piece_code} 不在这张外发单里`);
      if (op.returned_date) throw new Error(`${p.piece_code} 已登记回货，不能撤件（如确实要改，先联系管理员核实）`);
      db.prepare('DELETE FROM outsourcing_pieces WHERE outsourcing_id = ? AND piece_id = ?').run(batch.id, p.id);
      if (batch.type === 'plating') {
        db.prepare(`DELETE FROM piece_stages WHERE piece_id = ? AND stage = 'plating_sent'`).run(p.id);
      }
    }
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM outsourcing_pieces WHERE outsourcing_id = ?').get(batch.id).n;
    let batchDeleted = false;
    if (remaining === 0) {
      db.prepare('DELETE FROM outsourcing WHERE id = ?').run(batch.id);
      batchDeleted = true;
    } else {
      const unreturned = db.prepare('SELECT COUNT(*) AS n FROM outsourcing_pieces WHERE outsourcing_id = ? AND returned_date IS NULL').get(batch.id).n;
      if (unreturned === 0) db.prepare(`UPDATE outsourcing SET status = 'done' WHERE id = ?`).run(batch.id);
    }
    db.exec('COMMIT');
    res.json({ ok: true, removed: pieces.length, batch_deleted: batchDeleted });
  } catch (e) {
    db.exec('ROLLBACK');
    res.status(400).json({ error: e.message });
  }
});

productionRouter.delete('/outsourcing/:id', requireRole(...ENTRY_ROLES), (req, res) => {
  const batch = db.prepare('SELECT * FROM outsourcing WHERE id = ?').get(req.params.id);
  if (!batch) return res.status(404).json({ error: '外发单不存在' });
  const returned = db.prepare('SELECT COUNT(*) AS n FROM outsourcing_pieces WHERE outsourcing_id = ? AND returned_date IS NOT NULL').get(batch.id).n;
  if (returned > 0) return res.status(400).json({ error: '已有回货记录的外发单不能删除' });
  db.exec('BEGIN');
  try {
    if (batch.type === 'plating') {
      const ids = db.prepare('SELECT piece_id FROM outsourcing_pieces WHERE outsourcing_id = ?').all(batch.id);
      for (const { piece_id } of ids) {
        db.prepare(`DELETE FROM piece_stages WHERE piece_id = ? AND stage = 'plating_sent'`).run(piece_id);
      }
    }
    db.prepare('DELETE FROM outsourcing WHERE id = ?').run(batch.id);
    db.exec('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    db.exec('ROLLBACK');
    res.status(400).json({ error: e.message });
  }
});

productionRouter.get('/outsourcing', (req, res) => {
  const { status, type } = req.query;
  const cond = [];
  const args = [];
  if (status && ['draft', 'open', 'done'].includes(status)) { cond.push('o.status = ?'); args.push(status); }
  if (type && ['cnc', 'grinding', 'plating'].includes(type)) { cond.push('o.type = ?'); args.push(type); }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT o.*, v.name AS vendor_name, u.name AS created_by_name,
      (SELECT COUNT(*) FROM outsourcing_pieces op WHERE op.outsourcing_id = o.id) AS piece_count,
      (SELECT COUNT(*) FROM outsourcing_pieces op WHERE op.outsourcing_id = o.id AND op.returned_date IS NOT NULL) AS returned_count,
      CAST(julianday(date('now','localtime')) - julianday(o.sent_date) AS INTEGER) AS days_out
    FROM outsourcing o
    JOIN vendors v ON v.id = o.vendor_id
    LEFT JOIN users u ON u.id = o.created_by
    ${where}
    ORDER BY o.status = 'draft' DESC, o.status = 'open' DESC, o.sent_date DESC
    LIMIT 300
  `).all(...args);
  res.json({ outsourcing: rows });
});

productionRouter.get('/outsourcing/:id', (req, res) => {
  const batch = db.prepare(`
    SELECT o.*, v.name AS vendor_name, v.contact AS vendor_contact, v.phone AS vendor_phone,
      u.name AS created_by_name
    FROM outsourcing o
    JOIN vendors v ON v.id = o.vendor_id
    LEFT JOIN users u ON u.id = o.created_by
    WHERE o.id = ?
  `).get(req.params.id);
  if (!batch) return res.status(404).json({ error: '外发单不存在' });
  const pieces = db.prepare(`
    SELECT op.piece_id, op.returned_date, p.piece_code, ord.order_no, c.name AS customer_name,
      i.part_no, i.drawing_no, i.name AS item_name, i.spec, i.material
    FROM outsourcing_pieces op
    JOIN pieces p ON p.id = op.piece_id
    JOIN order_items i ON i.id = p.item_id
    JOIN orders ord ON ord.id = p.order_id
    JOIN customers c ON c.id = ord.customer_id
    WHERE op.outsourcing_id = ?
    ORDER BY p.piece_code
  `).all(batch.id);
  res.json({ batch, pieces });
});

productionRouter.post('/shipments', requireRole(...ENTRY_ROLES), (req, res) => {
  const { order_id, ship_date, note, piece_ids } = req.body || {};
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(order_id);
  if (!order) return res.status(404).json({ error: '订单不存在' });
  if (order.status === 'void') return res.status(400).json({ error: '订单已作废' });
  const pieces = getPieces(piece_ids);
  if (pieces.length === 0) return res.status(400).json({ error: '请至少选择一件' });
  const sdate = ship_date || today();
  db.exec('BEGIN');
  try {
    const shipNo = nextNo('shipments', 'ship_no', `S${yymm(sdate)}`);
    const r = db.prepare('INSERT INTO shipments (ship_no, order_id, ship_date, note, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(shipNo, order.id, sdate, note || null, req.user.id);
    const sid = Number(r.lastInsertRowid);
    const ins = db.prepare('INSERT INTO shipment_pieces (shipment_id, piece_id) VALUES (?, ?)');
    for (const p of pieces) {
      if (p.order_id !== order.id) throw new Error(`${p.piece_code} 不属于这张订单`);
      if (isShipped(p.id)) throw new Error(`${p.piece_code} 已经出过货了`);
      const out = openOutsourcing(p.id);
      if (out) throw new Error(`${p.piece_code} 还在外发中（${out.vendor_name}），不能出货`);
      ins.run(sid, p.id);
      upsertStage(p.id, 'shipped', sdate, `送货单 ${shipNo}`, req.user.id);
    }
    const unshipped = db.prepare(`
      SELECT COUNT(*) AS n FROM pieces p WHERE p.order_id = ?
      AND NOT EXISTS (SELECT 1 FROM shipment_pieces sp WHERE sp.piece_id = p.id)
    `).get(order.id).n;
    let closed = false;
    if (unshipped === 0) {
      db.prepare(`UPDATE orders SET status = 'closed' WHERE id = ?`).run(order.id);
      closed = true;
    }
    db.exec('COMMIT');
    res.json({ id: sid, ship_no: shipNo, closed });
  } catch (e) {
    db.exec('ROLLBACK');
    res.status(400).json({ error: e.message });
  }
});

productionRouter.delete('/shipments/:id', requireRole(...ENTRY_ROLES), (req, res) => {
  const s = db.prepare('SELECT * FROM shipments WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: '送货单不存在' });
  db.exec('BEGIN');
  try {
    const ids = db.prepare('SELECT piece_id FROM shipment_pieces WHERE shipment_id = ?').all(s.id);
    for (const { piece_id } of ids) {
      db.prepare(`DELETE FROM piece_stages WHERE piece_id = ? AND stage = 'shipped'`).run(piece_id);
    }
    db.prepare('DELETE FROM shipments WHERE id = ?').run(s.id);
    db.prepare(`UPDATE orders SET status = 'active' WHERE id = ? AND status = 'closed'`).run(s.order_id);
    db.exec('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    db.exec('ROLLBACK');
    res.status(400).json({ error: e.message });
  }
});

productionRouter.get('/shipments/:id/print-data', (req, res) => {
  const s = db.prepare(`
    SELECT s.*, o.order_no, o.customer_po, c.name AS customer_name, c.contact, c.phone, c.address, u.name AS created_by_name
    FROM shipments s
    JOIN orders o ON o.id = s.order_id
    JOIN customers c ON c.id = o.customer_id
    LEFT JOIN users u ON u.id = s.created_by
    WHERE s.id = ?
  `).get(req.params.id);
  if (!s) return res.status(404).json({ error: '送货单不存在' });
  const lines = db.prepare(`
    SELECT i.part_no, i.drawing_no, i.name, i.spec, i.material, i.unit_price,
      COUNT(*) AS qty, GROUP_CONCAT(p.piece_code, '、') AS piece_codes
    FROM shipment_pieces sp
    JOIN pieces p ON p.id = sp.piece_id
    JOIN order_items i ON i.id = p.item_id
    WHERE sp.shipment_id = ?
    GROUP BY i.id
    ORDER BY i.line_no
  `).all(s.id);
  const showPrice = canSeePrice(req) && req.query.with_price === '1';
  const out = lines.map(l => {
    const row = { ...l };
    if (!showPrice) delete row.unit_price;
    else row.amount = l.unit_price != null ? l.unit_price * l.qty : null;
    return row;
  });
  res.json({ shipment: s, lines: out, with_price: showPrice });
});

productionRouter.get('/dashboard', (req, res) => {
  const activeOrders = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE status = 'active'`).get().n;
  const stagesAgg = db.prepare(`
    SELECT
      COUNT(*) AS total_pieces,
      SUM(CASE WHEN EXISTS (SELECT 1 FROM piece_stages s WHERE s.piece_id = p.id AND s.stage = 'milling') THEN 1 ELSE 0 END) AS milling,
      SUM(CASE WHEN EXISTS (SELECT 1 FROM piece_stages s WHERE s.piece_id = p.id AND s.stage = 'cnc') THEN 1 ELSE 0 END) AS cnc,
      SUM(CASE WHEN EXISTS (SELECT 1 FROM piece_stages s WHERE s.piece_id = p.id AND s.stage = 'grinding') THEN 1 ELSE 0 END) AS grinding,
      SUM(CASE WHEN EXISTS (SELECT 1 FROM piece_stages s WHERE s.piece_id = p.id AND s.stage = 'plating_back') THEN 1 ELSE 0 END) AS plating_back,
      SUM(CASE WHEN EXISTS (SELECT 1 FROM piece_stages s WHERE s.piece_id = p.id AND s.stage = 'shipped') THEN 1 ELSE 0 END) AS shipped
    FROM pieces p
    JOIN orders o ON o.id = p.order_id
    WHERE o.status = 'active'
  `).get();
  const outOpen = db.prepare(`
    SELECT o.type, COUNT(DISTINCT o.id) AS batches, COUNT(op.piece_id) AS pieces,
      SUM(CASE WHEN o.expected_date IS NOT NULL AND o.expected_date < date('now','localtime') THEN 1 ELSE 0 END) AS overdue_pieces
    FROM outsourcing o
    JOIN outsourcing_pieces op ON op.outsourcing_id = o.id AND op.returned_date IS NULL
    WHERE o.status = 'open'
    GROUP BY o.type
  `).all();
  const dueSoon = db.prepare(`
    SELECT o.id, o.order_no, o.due_date, c.name AS customer_name,
      (SELECT COUNT(*) FROM pieces p WHERE p.order_id = o.id) AS total,
      (SELECT COUNT(*) FROM pieces p WHERE p.order_id = o.id
        AND EXISTS (SELECT 1 FROM shipment_pieces sp WHERE sp.piece_id = p.id)) AS shipped
    FROM orders o JOIN customers c ON c.id = o.customer_id
    WHERE o.status = 'active' AND o.due_date IS NOT NULL
      AND o.due_date <= date('now','localtime', '+7 days')
    ORDER BY o.due_date
    LIMIT 20
  `).all();
  const stallDays = Math.max(1, Math.min(120, Number(req.query.stall_days) || 14));
  const stalled = db.prepare(`
    SELECT p.piece_code, p.id AS piece_id, ord.id AS order_id, ord.order_no, ord.due_date,
      c.name AS customer_name, i.part_no, i.drawing_no, i.name AS item_name, i.spec,
      MAX(
        COALESCE((SELECT MAX(s.recorded_at) FROM piece_stages s WHERE s.piece_id = p.id), ord.created_at),
        COALESCE((SELECT MAX(o3.created_at) FROM outsourcing_pieces op3 JOIN outsourcing o3 ON o3.id = op3.outsourcing_id WHERE op3.piece_id = p.id), ord.created_at),
        COALESCE(p.wip_date, ord.created_at)
      ) AS last_act,
      EXISTS (SELECT 1 FROM piece_stages s WHERE s.piece_id = p.id AND s.stage = 'milling') AS has_milling,
      EXISTS (SELECT 1 FROM piece_stages s WHERE s.piece_id = p.id AND s.stage = 'cnc') AS has_cnc,
      EXISTS (SELECT 1 FROM piece_stages s WHERE s.piece_id = p.id AND s.stage = 'grinding') AS has_grinding,
      EXISTS (SELECT 1 FROM piece_stages s WHERE s.piece_id = p.id AND s.stage = 'plating_back') AS has_plating_back
    FROM pieces p
    JOIN orders ord ON ord.id = p.order_id
    JOIN order_items i ON i.id = p.item_id
    JOIN customers c ON c.id = ord.customer_id
    WHERE ord.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM shipment_pieces sp WHERE sp.piece_id = p.id)
      AND NOT EXISTS (
        SELECT 1 FROM outsourcing_pieces op JOIN outsourcing o2 ON o2.id = op.outsourcing_id
        WHERE op.piece_id = p.id AND op.returned_date IS NULL AND o2.status = 'open'
      )
    GROUP BY p.id
    HAVING julianday(datetime('now','localtime')) - julianday(last_act) >= ?
    ORDER BY last_act
    LIMIT 100
  `).all(stallDays);
  for (const s of stalled) {
    s.days_idle = Math.floor((Date.now() - new Date(s.last_act.replace(' ', 'T')).getTime()) / 86400_000);
    s.next_stage = !s.has_milling ? '待铣磨' : !s.has_cnc ? '待CNC' : !s.has_grinding ? '待精磨' : !s.has_plating_back ? '待电镀' : '待出货';
  }

  res.json({ active_orders: activeOrders, stages: stagesAgg, outsourcing_open: outOpen, due_soon: dueSoon, stalled, stall_days: stallDays });
});
