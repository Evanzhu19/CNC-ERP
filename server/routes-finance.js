import { Router } from 'express';
import multer from 'multer';
import { db, today } from './db.js';
import { requireRole, BASICS_ROLES } from './auth.js';
import { parseFinanceExcel } from './finance-excel.js';
import { encRecord, decRecord, handshake, getSession, encPayload, decPayload, decPayloadBytes } from './finance-crypto.js';

export const financeRouter = Router();

// 财务台账：独立手工账（应收+应付两本，含模具钢材等CNC之外的业务），与订单/出货数据完全无关
// 权限锁死：财务=看+操作；总经理=只读；其余角色（含采购主管）一律不可见不可操作。
// 数据安全：敏感字段落盘加密（enc列）；/finance/* 传输全报文加密（x25519会话密钥）。
const FIN_VIEW = ['admin', 'finance'];
const FIN_EDIT = ['finance'];

const KINDS = ['receivable', 'payable'];
const round2 = v => Math.round(Number(v || 0) * 100) / 100;
const normKind = k => (KINDS.includes(k) ? k : 'receivable');
const normName = s => String(s || '').replace(/\s/g, '');

// ===== 启动迁移：历史明文行 → 加密 =====
(function migrateLegacy() {
  const legacyE = db.prepare(`SELECT * FROM finance_entries WHERE enc IS NULL`).all();
  const legacyP = db.prepare(`SELECT * FROM finance_payments WHERE enc IS NULL`).all();
  if (!legacyE.length && !legacyP.length) return;
  db.exec('BEGIN');
  try {
    const upE = db.prepare(`UPDATE finance_entries SET enc = ?, customer = '*', biz = NULL, title = NULL, amount = 0, received = 0, entry_date = '', due_date = NULL, note = NULL WHERE id = ?`);
    for (const r of legacyE) {
      upE.run(encRecord({ customer: r.customer, biz: r.biz, title: r.title, amount: r.amount, received: r.received, entry_date: r.entry_date, due_date: r.due_date, note: r.note }), r.id);
    }
    const upP = db.prepare(`UPDATE finance_payments SET enc = ?, amount = 0, pay_date = '' WHERE id = ?`);
    for (const r of legacyP) {
      upP.run(encRecord({ amount: r.amount, pay_date: r.pay_date }), r.id);
    }
    db.exec('COMMIT');
    console.log(`[财务加密] 已加密历史数据：台账 ${legacyE.length} 条、流水 ${legacyP.length} 条`);
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('[财务加密] 历史数据迁移失败:', e.message);
  }
})();

// ===== 解密读取 =====
function readEntries(kind) {
  const rows = db.prepare(`
    SELECT f.id, f.kind, f.remind, f.enc, u.name AS created_by_name
    FROM finance_entries f LEFT JOIN users u ON u.id = f.created_by
    WHERE f.kind = ?
  `).all(kind);
  return rows.map(r => {
    const d = decRecord(r.enc);
    return {
      id: r.id, kind: r.kind, remind: r.remind, created_by_name: r.created_by_name,
      ...d, amount: round2(d.amount), received: round2(d.received),
      balance: round2(d.amount - d.received)
    };
  }).sort((a, b) => (b.remind - a.remind) || String(b.entry_date).localeCompare(String(a.entry_date)) || (b.id - a.id));
}

function readPayments() {
  return db.prepare('SELECT id, kind, enc FROM finance_payments').all()
    .map(r => ({ kind: r.kind, ...decRecord(r.enc) }));
}

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

function writeEntry(id, d, remind) {
  db.prepare('UPDATE finance_entries SET enc = ?, remind = ? WHERE id = ?')
    .run(encRecord({ customer: d.customer, biz: d.biz, title: d.title, amount: d.amount, received: d.received, entry_date: d.entry_date, due_date: d.due_date, note: d.note }), remind ? 1 : 0, id);
}

function insertEntry(kind, d, remind, userId) {
  const r = db.prepare(`
    INSERT INTO finance_entries (kind, customer, biz, title, amount, received, entry_date, due_date, remind, note, created_by, enc)
    VALUES (?, '*', NULL, NULL, 0, 0, '', NULL, ?, NULL, ?, ?)
  `).run(kind, remind ? 1 : 0, userId,
    encRecord({ customer: d.customer, biz: d.biz, title: d.title, amount: d.amount, received: d.received, entry_date: d.entry_date, due_date: d.due_date, note: d.note }));
  return Number(r.lastInsertRowid);
}

function insertPayment(entryId, kind, amount, payDate, userId) {
  db.prepare(`INSERT INTO finance_payments (entry_id, kind, amount, pay_date, created_by, enc) VALUES (?, ?, 0, '', ?, ?)`)
    .run(entryId, kind, userId, encRecord({ amount, pay_date: payDate }));
}

// ===== 传输加密通道 =====
// 握手（本身不加密，只交换公钥）
financeRouter.post('/finance/handshake', requireRole(...FIN_VIEW), (req, res) => {
  try {
    res.json({ pub: handshake(req.token, req.body?.pub) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 其余 /finance/* 一律走加密信封：请求体 {x} 解密，响应用 res.finSend 加密
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

// ===== 台账 =====
financeRouter.get('/finance/entries', requireRole(...FIN_VIEW), (req, res) => {
  const entries = readEntries(normKind(req.query.kind));
  res.finSend({ entries, totals: entryTotals(entries) });
});

// 总账：当前余额 + 按业务类型小计 + 按月/季/年盈亏
financeRouter.get('/finance/summary', requireRole(...FIN_VIEW), (req, res) => {
  const g = ['month', 'quarter', 'year'].includes(req.query.granularity) ? req.query.granularity : 'month';
  const periodOf = d => {
    if (!d) return null;
    if (g === 'month') return d.slice(0, 7);
    if (g === 'year') return d.slice(0, 4);
    return `${d.slice(0, 4)}Q${Math.ceil(Number(d.slice(5, 7)) / 3)}`;
  };

  const all = { receivable: readEntries('receivable'), payable: readEntries('payable') };
  const balances = {
    receivable: entryTotals(all.receivable),
    payable: entryTotals(all.payable)
  };
  balances.net = round2(balances.receivable.balance - balances.payable.balance);

  const byBiz = {};
  for (const kind of KINDS) {
    const m = new Map();
    for (const e of all[kind]) {
      const biz = (e.biz || '').trim() || '未分类';
      const o = m.get(biz) || { biz, amount: 0, received: 0, balance: 0, cnt: 0 };
      o.amount += e.amount; o.received += e.received; o.balance += e.balance; o.cnt++;
      m.set(biz, o);
    }
    byBiz[kind] = [...m.values()].map(o => ({ ...o, amount: round2(o.amount), received: round2(o.received), balance: round2(o.balance) }))
      .sort((a, b) => b.balance - a.balance);
  }

  const periodMap = new Map();
  const P = p => { if (!periodMap.has(p)) periodMap.set(p, { period: p, income: 0, expense: 0, profit: 0, cash_in: 0, cash_out: 0, net_cash: 0 }); return periodMap.get(p); };
  for (const kind of KINDS) {
    for (const e of all[kind]) {
      const p = periodOf(e.entry_date);
      if (!p) continue;
      const o = P(p);
      if (kind === 'receivable') o.income += e.amount; else o.expense += e.amount;
    }
  }
  for (const pm of readPayments()) {
    const p = periodOf(pm.pay_date);
    if (!p) continue;
    const o = P(p);
    if (pm.kind === 'receivable') o.cash_in += pm.amount; else o.cash_out += pm.amount;
  }
  let periods = [...periodMap.values()].map(o => ({
    period: o.period,
    income: round2(o.income), expense: round2(o.expense), profit: round2(o.income - o.expense),
    cash_in: round2(o.cash_in), cash_out: round2(o.cash_out), net_cash: round2(o.cash_in - o.cash_out)
  })).sort((a, b) => b.period.localeCompare(a.period));
  periods = periods.slice(0, g === 'month' ? 12 : g === 'quarter' ? 8 : 20);

  res.finSend({ balances, by_biz: byBiz, periods, granularity: g });
});

function validEntry(body) {
  const { customer, amount, entry_date } = body || {};
  if (!customer || !String(customer).trim()) return '请填写客户/单位名称';
  if (!(Number(amount) > 0)) return '金额必须大于0';
  if (!entry_date || !/^\d{4}-\d{2}-\d{2}$/.test(String(entry_date))) return '请选择记账日期';
  if (body.received != null && Number(body.received) < 0) return '已收/已付金额不能为负';
  return null;
}

const cleanEntry = b => ({
  customer: String(b.customer).trim(), biz: b.biz || null, title: b.title || null,
  amount: round2(b.amount), received: round2(b.received || 0),
  entry_date: b.entry_date, due_date: b.due_date || null, note: b.note || null
});

financeRouter.post('/finance/entries', requireRole(...FIN_EDIT), (req, res) => {
  const err = validEntry(req.body);
  if (err) return res.status(400).json({ error: err });
  const d = cleanEntry(req.body);
  const kind = normKind(req.body.kind);
  db.exec('BEGIN');
  try {
    const id = insertEntry(kind, d, req.body.remind, req.user.id);
    if (d.received > 0) insertPayment(id, kind, d.received, d.entry_date, req.user.id);
    db.exec('COMMIT');
    res.finSend({ id });
  } catch (e) { db.exec('ROLLBACK'); throw e; }
});

financeRouter.put('/finance/entries/:id', requireRole(...FIN_EDIT), (req, res) => {
  const row = db.prepare('SELECT id FROM finance_entries WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '记录不存在' });
  const err = validEntry(req.body);
  if (err) return res.status(400).json({ error: err });
  writeEntry(row.id, cleanEntry(req.body), req.body.remind);
  res.finSend({ ok: true });
});

// 快捷操作：登记收款/付款（累加+记流水）/ 切换催款（待付）标记
financeRouter.post('/finance/entries/:id/receive', requireRole(...FIN_EDIT), (req, res) => {
  const row = db.prepare('SELECT * FROM finance_entries WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '记录不存在' });
  const amt = Number(req.body?.amount);
  if (!(amt > 0)) return res.status(400).json({ error: '金额必须大于0' });
  const payDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.pay_date || '')) ? req.body.pay_date : today();
  const d = decRecord(row.enc);
  d.received = round2(d.received + amt);
  const remind = d.received >= d.amount - 0.005 ? 0 : row.remind;
  db.exec('BEGIN');
  try {
    writeEntry(row.id, d, remind);
    insertPayment(row.id, row.kind, amt, payDate, req.user.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.finSend({ ok: true, received: d.received });
});

financeRouter.post('/finance/entries/:id/remind', requireRole(...FIN_EDIT), (req, res) => {
  const row = db.prepare('SELECT id, remind FROM finance_entries WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '记录不存在' });
  const next = row.remind ? 0 : 1;
  db.prepare('UPDATE finance_entries SET remind = ? WHERE id = ?').run(next, row.id);
  res.finSend({ ok: true, remind: next });
});

financeRouter.delete('/finance/entries/:id', requireRole(...FIN_EDIT), (req, res) => {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM finance_payments WHERE entry_id = ?').run(req.params.id);
    db.prepare('DELETE FROM finance_entries WHERE id = ?').run(req.params.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.finSend({ ok: true });
});

// ===== Excel 导入：解析预览 + 批量入账（含矩阵账本先进先出冲账） =====
const xlsUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

financeRouter.post('/finance/parse-excel', requireRole(...FIN_EDIT), xlsUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择Excel文件' });
  try {
    const buf = decPayloadBytes(req.finKey, req.file.buffer); // 上传的文件也是加密的
    const { sheets } = parseFinanceExcel(buf);
    const kind = normKind(req.query.kind);
    const existing = new Set(readEntries(kind).map(e => `${normName(e.customer)}|${e.amount.toFixed(2)}|${e.entry_date}`));
    for (const sheet of sheets) {
      for (const l of sheet.lines || []) {
        l.duplicate = l.entry_date ? existing.has(`${normName(l.customer)}|${round2(l.amount).toFixed(2)}|${l.entry_date}`) : false;
      }
    }
    res.finSend({ sheets });
  } catch (e) {
    console.error('财务Excel解析失败:', e);
    res.status(422).json({ error: 'Excel解析失败：' + e.message });
  }
});

financeRouter.post('/finance/import', requireRole(...FIN_EDIT), (req, res) => {
  const { entries, payments, kind: rawKind } = req.body || {};
  if (!Array.isArray(entries) || !entries.length) return res.status(400).json({ error: '没有要导入的记录' });
  if (entries.length > 2000) return res.status(400).json({ error: '一次最多导入2000条' });
  const kind = normKind(rawKind);
  const errs = [];
  entries.forEach((e, i) => { const err = validEntry({ ...e, entry_date: e.entry_date || today() }); if (err) errs.push(`第${i + 1}条: ${err}`); });
  if (errs.length) return res.status(400).json({ error: errs.slice(0, 5).join('；') });

  // 现有未结清记录（供收付款冲账时衔接旧账）
  const existingOpen = readEntries(kind).filter(e => e.balance > 0.005);

  db.exec('BEGIN');
  try {
    const batch = []; // {id, d(解密态), remind}
    for (const e of entries) {
      const d = cleanEntry({ ...e, entry_date: e.entry_date || today() });
      d.received = Math.min(d.received, d.amount);
      const id = insertEntry(kind, d, 0, req.user.id);
      if (d.received > 0) insertPayment(id, kind, d.received, d.entry_date, req.user.id);
      batch.push({ id, d, remind: 0 });
    }

    // 矩阵账本的收付款：按单位先进先出冲账（旧账优先，再冲本批）
    let allocated = 0;
    const unmatched = [];
    const touched = new Map(); // id -> {d, remind, isExisting}
    if (Array.isArray(payments) && payments.length) {
      const candidatesOf = name => {
        const n = normName(name);
        const ex = existingOpen.filter(e => normName(e.customer) === n)
          .map(e => ({ id: e.id, d: e, remind: e.remind, isExisting: true }));
        const nb = batch.filter(b => normName(b.d.customer) === n)
          .map(b => ({ id: b.id, d: b.d, remind: 0, isExisting: false }));
        return [...ex, ...nb].sort((a, b) => String(a.d.entry_date).localeCompare(String(b.d.entry_date)));
      };
      const candCache = new Map();
      for (const p of payments) {
        const amt = round2(p.amount);
        if (!(amt > 0)) continue;
        const payDate = /^\d{4}-\d{2}-\d{2}$/.test(String(p.pay_date || '')) ? p.pay_date : today();
        const n = normName(p.customer);
        if (!candCache.has(n)) candCache.set(n, candidatesOf(p.customer));
        const cands = candCache.get(n);
        if (!cands.length) { unmatched.push({ customer: p.customer, amount: amt, pay_date: payDate }); continue; }
        let remaining = amt;
        for (const c of cands) {
          if (remaining <= 0.005) break;
          const room = round2(c.d.amount - c.d.received);
          if (room <= 0.005) continue;
          const take = Math.min(room, remaining);
          c.d.received = round2(c.d.received + take);
          remaining = round2(remaining - take);
          insertPayment(c.id, kind, take, payDate, req.user.id);
          touched.set(c.id, c);
        }
        if (remaining > 0.005) { // 多付/预收：挂到该单位最后一条上
          const last = cands[cands.length - 1];
          last.d.received = round2(last.d.received + remaining);
          insertPayment(last.id, kind, remaining, payDate, req.user.id);
          touched.set(last.id, last);
        }
        allocated++;
      }
      for (const c of touched.values()) {
        const remind = c.d.received >= c.d.amount - 0.005 ? 0 : c.remind;
        writeEntry(c.id, c.d, remind);
      }
    }
    db.exec('COMMIT');
    res.finSend({ imported: batch.length, payments_allocated: allocated, unmatched });
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
