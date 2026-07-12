import { Router } from 'express';
import { db, today, lastActExpr } from './db.js';
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

const STAGE_ORDER = ['milling', 'cnc', 'grinding', 'plating_sent', 'plating_back', 'shipped'];
const STAGE_CN = { milling: '铣磨', cnc: 'CNC', grinding: '精磨', plating_sent: '电镀外发', plating_back: '电镀回厂', shipped: '出货' };
const PREREQ = { milling: null, cnc: 'milling', grinding: 'cnc', plating: 'grinding' };
const PROC_CHAIN = ['milling', 'cnc', 'grinding'];

function hasStage(pieceId, stage) {
  return !!db.prepare('SELECT 1 FROM piece_stages WHERE piece_id = ? AND stage = ?').get(pieceId, stage);
}

function laterDoneStage(pieceId, stage) {
  const idx = STAGE_ORDER.indexOf(stage);
  for (let i = STAGE_ORDER.length - 1; i > idx; i--) {
    if (hasStage(pieceId, STAGE_ORDER[i])) return STAGE_ORDER[i];
  }
  return null;
}

function checkPrereq(piece, proc) {
  const need = PREREQ[proc];
  if (need && !hasStage(piece.id, need)) {
    throw new Error(`${piece.piece_code} 还没完成「${STAGE_CN[need]}」，不能跳到「${proc === 'plating' ? '电镀' : STAGE_CN[proc]}」（顺序：铣磨→CNC→精磨→电镀→出货）`);
  }
}

function parseProcs(type) {
  const procs = String(type || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!procs.length) return null;
  if (procs.includes('plating')) {
    return procs.length === 1 ? ['plating'] : null;
  }
  const idxs = procs.map(p => PROC_CHAIN.indexOf(p));
  if (idxs.some(i => i < 0)) return null;
  idxs.sort((a, b) => a - b);
  if (new Set(idxs).size !== idxs.length) return null;
  for (let i = 1; i < idxs.length; i++) {
    if (idxs[i] !== idxs[i - 1] + 1) return null;
  }
  return idxs.map(i => PROC_CHAIN[i]);
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
      checkPrereq(p, stage);
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
      checkPrereq(p, stage);
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
      if (isShipped(p.id)) throw new Error(`${p.piece_code} 已出货，请先撤销送货单`);
      const out = openOutsourcing(p.id);
      if (out) throw new Error(`${p.piece_code} 在外发单 ${out.batch_no} 里（${out.vendor_name}），外发中不能撤工序`);
      if (!hasStage(p.id, stage)) throw new Error(`${p.piece_code} 的「${STAGE_CN[stage]}」本来就没报过，无需撤销`);
      const later = laterDoneStage(p.id, stage);
      if (later) {
        const hint = later === 'plating_sent' ? '先到外发管理撤销电镀外发单'
          : later === 'plating_back' ? '先到外发管理撤销电镀回货'
          : later === 'shipped' ? '先撤销送货单'
          : `先撤销「${STAGE_CN[later]}」`;
        throw new Error(`${p.piece_code} 后面的「${STAGE_CN[later]}」已完成，撤销必须逆序：${hint}`);
      }
      db.prepare('DELETE FROM piece_stages WHERE piece_id = ? AND stage = ?').run(p.id, stage);
    }
    db.exec('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    db.exec('ROLLBACK');
    res.status(400).json({ error: e.message });
  }
});

const PIECE_FLAGS = { repair: '维修', rework: '返工', redraw: '改图' };

productionRouter.post('/pieces/flag', requireRole(...ENTRY_ROLES), (req, res) => {
  const { piece_ids, flag, note } = req.body || {};
  if (flag != null && !PIECE_FLAGS[flag]) return res.status(400).json({ error: '特殊状态无效' });
  const pieces = getPieces(piece_ids);
  if (pieces.length === 0) return res.status(400).json({ error: '请至少选择一件' });
  db.exec('BEGIN');
  try {
    for (const p of pieces) {
      if (isShipped(p.id)) throw new Error(`${p.piece_code} 已出货，不能打特殊状态`);
      if (flag) {
        db.prepare(`UPDATE pieces SET flag = ?, flag_note = ?, flag_date = ?, flag_by = ? WHERE id = ?`)
          .run(flag, note || null, today(), req.user.id, p.id);
      } else {
        db.prepare(`UPDATE pieces SET flag = NULL, flag_note = NULL, flag_date = NULL, flag_by = NULL WHERE id = ?`).run(p.id);
      }
    }
    db.exec('COMMIT');
    res.json({ ok: true, count: pieces.length });
  } catch (e) {
    db.exec('ROLLBACK');
    res.status(400).json({ error: e.message });
  }
});

productionRouter.post('/pieces/note', requireRole(...ENTRY_ROLES), (req, res) => {
  const { piece_id, note } = req.body || {};
  const p = db.prepare('SELECT id FROM pieces WHERE id = ?').get(piece_id);
  if (!p) return res.status(404).json({ error: '板件不存在' });
  db.prepare('UPDATE pieces SET note = ? WHERE id = ?').run(String(note || '').trim() || null, p.id);
  res.json({ ok: true });
});

productionRouter.post('/outsourcing', requireRole(...ENTRY_ROLES), (req, res) => {
  const { type, vendor_id, sent_date, expected_date, note, piece_ids } = req.body || {};
  const procs = parseProcs(type);
  if (!procs) return res.status(400).json({ error: '外发工序无效（加工外发可组合相邻工序如CNC+精磨，电镀只能单独外发）' });
  if (!vendor_id) return res.status(400).json({ error: '请选择外协厂家' });
  const vendor = db.prepare('SELECT * FROM vendors WHERE id = ? AND active = 1').get(vendor_id);
  if (!vendor) return res.status(400).json({ error: '请选择外协厂家' });
  const vTypes = String(vendor.type).split(',');
  if (!vTypes.includes('other')) {
    for (const proc of procs) {
      if (!vTypes.includes(proc)) {
        return res.status(400).json({ error: `厂家「${vendor.name}」没有「${proc === 'plating' ? '电镀' : STAGE_CN[proc]}」能力，请先到客户与厂家里给它勾上` });
      }
    }
  }
  const pieces = getPieces(piece_ids);
  if (pieces.length === 0) return res.status(400).json({ error: '请至少选择一件' });
  const sdate = sent_date || today();
  // 预计回厂必填：看板超期提醒按它判断，不填就没人盯着这批货
  if (!expected_date || !/^\d{4}-\d{2}-\d{2}$/.test(String(expected_date))) {
    return res.status(400).json({ error: '请填写预计回厂日期（看板按它提醒超期，必填）' });
  }
  if (String(expected_date) < sdate) {
    return res.status(400).json({ error: '预计回厂日期不能早于发出日期' });
  }
  db.exec('BEGIN');
  try {
    const batchNo = nextNo('outsourcing', 'batch_no', `W${yymm(sdate)}`);
    const r = db.prepare(`
      INSERT INTO outsourcing (batch_no, type, vendor_id, sent_date, expected_date, note, status, created_by)
      VALUES (?, ?, ?, ?, ?, ?, 'draft', ?)
    `).run(batchNo, procs.join(','), vendor.id, sdate, expected_date || null, note || null, req.user.id);
    const oid = Number(r.lastInsertRowid);
    const ins = db.prepare('INSERT INTO outsourcing_pieces (outsourcing_id, piece_id) VALUES (?, ?)');
    for (const p of pieces) {
      if (isShipped(p.id)) throw new Error(`${p.piece_code} 已出货`);
      const out = openOutsourcing(p.id);
      if (out) throw new Error(`${p.piece_code} 已在外发单 ${out.batch_no} 里（${out.vendor_name}）`);
      checkPrereq(p, procs[0]);
      for (const proc of procs) {
        const st = proc === 'plating' ? 'plating_back' : proc;
        if (hasStage(p.id, st)) throw new Error(`${p.piece_code} 的「${proc === 'plating' ? '电镀' : STAGE_CN[proc]}」已经完成了，不用再外发这道工序`);
      }
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
      if (String(batch.type).includes('plating')) {
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
      const procs = parseProcs(batch.type) || [];
      for (const proc of procs) {
        if (proc === 'plating') {
          upsertStage(p.id, 'plating_back', rdate, `电镀回厂：${batch.vendor_name}`, req.user.id);
        } else {
          upsertStage(p.id, proc, rdate, `${STAGE_CN[proc]}外发回厂：${batch.vendor_name}`, req.user.id);
        }
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

productionRouter.post('/outsourcing/:id/unreturn', requireRole(...ENTRY_ROLES), (req, res) => {
  const batch = db.prepare('SELECT o.*, v.name AS vendor_name FROM outsourcing o JOIN vendors v ON v.id = o.vendor_id WHERE o.id = ?').get(req.params.id);
  if (!batch) return res.status(404).json({ error: '外发单不存在' });
  const pieces = getPieces(req.body?.piece_ids);
  if (pieces.length === 0) return res.status(400).json({ error: '请至少选择一件' });
  const procs = parseProcs(batch.type) || [];
  const stagesMarked = procs.map(proc => (proc === 'plating' ? 'plating_back' : proc));
  const lastMarked = stagesMarked[stagesMarked.length - 1];
  db.exec('BEGIN');
  try {
    for (const p of pieces) {
      const op = db.prepare('SELECT * FROM outsourcing_pieces WHERE outsourcing_id = ? AND piece_id = ?').get(batch.id, p.id);
      if (!op) throw new Error(`${p.piece_code} 不在这张外发单里`);
      if (!op.returned_date) throw new Error(`${p.piece_code} 还没登记过回货`);
      const other = openOutsourcing(p.id);
      if (other) throw new Error(`${p.piece_code} 回货后已再次外发（${other.batch_no}），先处理那张单`);
      const later = laterDoneStage(p.id, lastMarked);
      if (later) {
        const hint = later === 'shipped' ? '先撤销送货单' : later === 'plating_sent' ? '先撤销后续的电镀外发' : `先撤销「${STAGE_CN[later]}」`;
        throw new Error(`${p.piece_code} 回货后已有后续记录，撤销必须逆序：${hint}`);
      }
      db.prepare('UPDATE outsourcing_pieces SET returned_date = NULL WHERE outsourcing_id = ? AND piece_id = ?').run(batch.id, p.id);
      for (const st of stagesMarked) {
        db.prepare('DELETE FROM piece_stages WHERE piece_id = ? AND stage = ?').run(p.id, st);
      }
    }
    db.prepare(`UPDATE outsourcing SET status = 'open' WHERE id = ?`).run(batch.id);
    db.exec('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    db.exec('ROLLBACK');
    res.status(400).json({ error: e.message });
  }
});

productionRouter.post('/outsourcing/:id/direct-ship', requireRole(...ENTRY_ROLES), (req, res) => {
  const batch = db.prepare('SELECT o.*, v.name AS vendor_name FROM outsourcing o JOIN vendors v ON v.id = o.vendor_id WHERE o.id = ?').get(req.params.id);
  if (!batch) return res.status(404).json({ error: '外发单不存在' });
  if (!String(batch.type).includes('plating')) return res.status(400).json({ error: '只有电镀外发单支持直送客户' });
  if (batch.status !== 'open') return res.status(400).json({ error: batch.status === 'draft' ? '外发单还未确认外发' : '外发单已完结' });
  const { piece_ids, ship_date, note } = req.body || {};
  const pieces = getPieces(piece_ids);
  if (pieces.length === 0) return res.status(400).json({ error: '请至少选择一件' });
  const sdate = ship_date || today();
  db.exec('BEGIN');
  try {
    const byOrder = new Map();
    for (const p of pieces) {
      const op = db.prepare('SELECT * FROM outsourcing_pieces WHERE outsourcing_id = ? AND piece_id = ?').get(batch.id, p.id);
      if (!op) throw new Error(`${p.piece_code} 不在这张外发单里`);
      if (op.returned_date) throw new Error(`${p.piece_code} 已登记回货，回厂的板请走正常出货`);
      if (isShipped(p.id)) throw new Error(`${p.piece_code} 已经出过货了`);
      const flagged = db.prepare('SELECT flag FROM pieces WHERE id = ?').get(p.id);
      if (flagged?.flag) throw new Error(`${p.piece_code} 有特殊状态标记，处理完才能出货`);
      if (!byOrder.has(p.order_id)) byOrder.set(p.order_id, []);
      byOrder.get(p.order_id).push(p);
    }
    const shipments = [];
    for (const [orderId, ps] of byOrder) {
      const shipNo = nextNo('shipments', 'ship_no', `S${yymm(sdate)}`);
      const rs = db.prepare('INSERT INTO shipments (ship_no, order_id, ship_date, note, created_by) VALUES (?, ?, ?, ?, ?)')
        .run(shipNo, orderId, sdate, `电镀厂直送（${batch.vendor_name}）${note ? '：' + note : ''}`, req.user.id);
      const sid = Number(rs.lastInsertRowid);
      for (const p of ps) {
        db.prepare('UPDATE outsourcing_pieces SET returned_date = ? WHERE outsourcing_id = ? AND piece_id = ?').run(sdate, batch.id, p.id);
        upsertStage(p.id, 'plating_back', sdate, `电镀完成，${batch.vendor_name}直送客户`, req.user.id);
        db.prepare('INSERT INTO shipment_pieces (shipment_id, piece_id) VALUES (?, ?)').run(sid, p.id);
        upsertStage(p.id, 'shipped', sdate, `送货单 ${shipNo}（电镀厂直送）`, req.user.id);
      }
      const unshipped = db.prepare(`
        SELECT COUNT(*) AS n FROM pieces px WHERE px.order_id = ?
        AND NOT EXISTS (SELECT 1 FROM shipment_pieces sp WHERE sp.piece_id = px.id)
      `).get(orderId).n;
      if (unshipped === 0) db.prepare(`UPDATE orders SET status = 'closed' WHERE id = ?`).run(orderId);
      shipments.push({ id: sid, ship_no: shipNo, order_id: orderId, closed: unshipped === 0 });
    }
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM outsourcing_pieces WHERE outsourcing_id = ? AND returned_date IS NULL').get(batch.id).n;
    if (remaining === 0) db.prepare(`UPDATE outsourcing SET status = 'done' WHERE id = ?`).run(batch.id);
    db.exec('COMMIT');
    res.json({ ok: true, shipments });
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
      if (String(batch.type).includes('plating')) {
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
    if (String(batch.type).includes('plating')) {
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
  if (type && ['milling', 'cnc', 'grinding', 'plating'].includes(type)) {
    cond.push(`(',' || o.type || ',') LIKE ?`);
    args.push(`%,${type},%`);
  }
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
    SELECT o.*, v.name AS vendor_name, v.contact AS vendor_contact, v.phone AS vendor_phone, v.address AS vendor_address,
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
      if (!hasStage(p.id, 'plating_back')) throw new Error(`${p.piece_code} 还没电镀回厂，不能出货（顺序：铣磨→CNC→精磨→电镀→出货）`);
      if (p.flag) throw new Error(`${p.piece_code} 有特殊状态标记（${p.flag}），处理完并解除标记才能出货`);
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

productionRouter.get('/shipments', (req, res) => {
  const { q, month } = req.query;
  const cond = [];
  const args = [];
  if (month) { cond.push(`substr(s.ship_date, 1, 7) = ?`); args.push(month); }
  if (q) {
    const like = `%${String(q).trim()}%`;
    cond.push(`(s.ship_no LIKE ? OR o.order_no LIKE ? OR o.customer_po LIKE ? OR c.name LIKE ?)`);
    args.push(like, like, like, like);
  }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
  const showPrice = canSeePrice(req);
  const rows = db.prepare(`
    SELECT s.id, s.ship_no, s.ship_date, s.note, s.order_id,
      o.order_no, o.customer_po, c.name AS customer_name, u.name AS created_by_name,
      (SELECT COUNT(*) FROM shipment_pieces sp WHERE sp.shipment_id = s.id) AS piece_count,
      (SELECT COALESCE(SUM(i.unit_price), 0) FROM shipment_pieces sp
        JOIN pieces p ON p.id = sp.piece_id JOIN order_items i ON i.id = p.item_id
        WHERE sp.shipment_id = s.id) AS amount
    FROM shipments s
    JOIN orders o ON o.id = s.order_id
    JOIN customers c ON c.id = o.customer_id
    LEFT JOIN users u ON u.id = s.created_by
    ${where}
    ORDER BY s.ship_date DESC, s.id DESC
    LIMIT 500
  `).all(...args);
  if (!showPrice) rows.forEach(r => delete r.amount);
  res.json({ shipments: rows });
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
  const outRows = db.prepare(`
    SELECT o.type, COUNT(op.piece_id) AS pieces,
      SUM(CASE WHEN o.expected_date IS NOT NULL AND o.expected_date < date('now','localtime') THEN 1 ELSE 0 END) AS overdue_pieces
    FROM outsourcing o
    JOIN outsourcing_pieces op ON op.outsourcing_id = o.id AND op.returned_date IS NULL
    WHERE o.status = 'open'
    GROUP BY o.type
  `).all();
  const outOpen = [
    { type: 'work', pieces: 0, overdue_pieces: 0 },
    { type: 'plating', pieces: 0, overdue_pieces: 0 }
  ];
  for (const r of outRows) {
    const target = String(r.type).includes('plating') ? outOpen[1] : outOpen[0];
    target.pieces += r.pieces;
    target.overdue_pieces += r.overdue_pieces || 0;
  }
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
  const getSet = k => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value;
  const warnDays = Math.max(1, Number(getSet('stall_warn_days')) || 2);
  const alertDays = Math.max(warnDays, Number(getSet('stall_alert_days')) || 4);

  const stalled = db.prepare(`
    SELECT p.piece_code, p.id AS piece_id, ord.id AS order_id, ord.order_no, ord.due_date,
      c.name AS customer_name, i.part_no, i.drawing_no, i.name AS item_name, i.spec,
      ${lastActExpr('p', 'ord')} AS last_act,
      (SELECT o5.batch_no || '·' || v5.name FROM outsourcing_pieces op5
        JOIN outsourcing o5 ON o5.id = op5.outsourcing_id
        JOIN vendors v5 ON v5.id = o5.vendor_id
        WHERE op5.piece_id = p.id AND op5.returned_date IS NULL AND o5.status = 'open' LIMIT 1) AS out_at,
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
    GROUP BY p.id
    HAVING julianday(date('now','localtime')) - julianday(date(last_act)) >= ?
    ORDER BY last_act
    LIMIT 150
  `).all(warnDays);
  for (const s of stalled) {
    s.days_idle = Math.max(0, Math.round((Date.parse(today()) - Date.parse(String(s.last_act).slice(0, 10))) / 86400_000));
    s.level = s.days_idle >= alertDays ? 'alert' : 'warn';
    s.next_stage = s.out_at ? `在外·${s.out_at}`
      : !s.has_milling ? '待铣磨' : !s.has_cnc ? '待CNC' : !s.has_grinding ? '待精磨' : !s.has_plating_back ? '待电镀' : '待出货';
  }

  const flagged = db.prepare(`
    SELECT COUNT(*) AS n FROM pieces p JOIN orders o ON o.id = p.order_id
    WHERE p.flag IS NOT NULL AND o.status = 'active'
  `).get().n;

  res.json({
    active_orders: activeOrders, stages: stagesAgg, outsourcing_open: outOpen, due_soon: dueSoon,
    stalled, stall_warn_days: warnDays, stall_alert_days: alertDays, flagged_pieces: flagged
  });
});
