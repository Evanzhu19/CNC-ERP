import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { db, DATA_DIR, hashPassword, verifyPassword } from './db.js';
import { requireRole, BASICS_ROLES, createSession, login, logout } from './auth.js';

function getSetting(key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
}

function setSetting(key, value) {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

export const authRouter = Router();

authRouter.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = login(String(username || '').trim(), String(password || ''));
  if (!user) return res.status(401).json({ error: '用户名或密码错误' });
  const token = createSession(user.id);
  res.json({ token, user: { id: user.id, username: user.username, name: user.name, role: user.role } });
});

export const basicsRouter = Router();

basicsRouter.post('/logout', (req, res) => {
  logout(req.token);
  res.json({ ok: true });
});

basicsRouter.get('/me', (req, res) => res.json({ user: req.user }));

basicsRouter.post('/me/password', (req, res) => {
  const { old_password, new_password } = req.body || {};
  if (!new_password || String(new_password).length < 6) {
    return res.status(400).json({ error: '新密码至少6位' });
  }
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(String(old_password || ''), row.password_hash)) {
    return res.status(400).json({ error: '原密码不正确' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(new_password)), req.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.token);
  res.json({ ok: true });
});

basicsRouter.get('/settings', (req, res) => {
  res.json({
    company_name: getSetting('company_name') || '',
    has_logo: !!getSetting('logo_file'),
    stall_warn_days: Number(getSetting('stall_warn_days')) || 2,
    stall_alert_days: Number(getSetting('stall_alert_days')) || 4,
    out_contact_name: getSetting('out_contact_name') || '',
    out_contact_phone: getSetting('out_contact_phone') || '',
    out_deliver_address: getSetting('out_deliver_address') || '',
    out_requirements: getSetting('out_requirements') || ''
  });
});

basicsRouter.put('/settings', requireRole('admin', 'cnc_manager'), (req, res) => {
  const { company_name, stall_warn_days, stall_alert_days,
    out_contact_name, out_contact_phone, out_deliver_address, out_requirements } = req.body || {};
  if (!company_name || !String(company_name).trim()) return res.status(400).json({ error: '公司名称不能为空' });
  const warn = Number(stall_warn_days);
  const alert = Number(stall_alert_days);
  if (!Number.isInteger(warn) || warn < 1 || warn > 60) return res.status(400).json({ error: '提示天数需为1-60的整数' });
  if (!Number.isInteger(alert) || alert < warn || alert > 90) return res.status(400).json({ error: '报警天数需≥提示天数且不超过90' });
  setSetting('company_name', String(company_name).trim());
  setSetting('stall_warn_days', String(warn));
  setSetting('stall_alert_days', String(alert));
  setSetting('out_contact_name', String(out_contact_name || '').trim());
  setSetting('out_contact_phone', String(out_contact_phone || '').trim());
  setSetting('out_deliver_address', String(out_deliver_address || '').trim());
  setSetting('out_requirements', String(out_requirements || '').trim());
  res.json({ ok: true });
});

const logoUpload = multer({
  storage: multer.diskStorage({
    destination: DATA_DIR,
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.png').toLowerCase();
      cb(null, `logo${ext}`);
    }
  }),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(png|jpg|jpeg|gif|webp)$/i.test(file.originalname);
    cb(ok ? null : new Error('只支持 PNG/JPG/GIF/WEBP 图片'), ok);
  }
});

basicsRouter.post('/settings/logo', requireRole('admin', 'cnc_manager'), logoUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择图片文件' });
  const old = getSetting('logo_file');
  if (old && old !== req.file.filename) {
    try { const fp = path.join(DATA_DIR, old); if (existsSync(fp)) unlinkSync(fp); } catch {}
  }
  setSetting('logo_file', req.file.filename);
  res.json({ ok: true });
});

basicsRouter.get('/settings/logo', (req, res) => {
  const file = getSetting('logo_file');
  if (!file) return res.status(404).json({ error: '还没有上传LOGO' });
  const fp = path.join(DATA_DIR, file);
  if (!existsSync(fp)) return res.status(404).json({ error: 'LOGO文件丢失' });
  res.sendFile(fp);
});

basicsRouter.delete('/settings/logo', requireRole('admin', 'cnc_manager'), (req, res) => {
  const file = getSetting('logo_file');
  if (file) {
    try { const fp = path.join(DATA_DIR, file); if (existsSync(fp)) unlinkSync(fp); } catch {}
    setSetting('logo_file', null);
  }
  res.json({ ok: true });
});

basicsRouter.get('/customers', (req, res) => {
  const rows = db.prepare('SELECT * FROM customers ORDER BY active DESC, name').all();
  res.json({ customers: rows });
});

basicsRouter.post('/customers', requireRole(...BASICS_ROLES), (req, res) => {
  const { name, contact, phone, address } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: '客户名称不能为空' });
  try {
    const r = db.prepare('INSERT INTO customers (name, contact, phone, address) VALUES (?, ?, ?, ?)')
      .run(String(name).trim(), contact || null, phone || null, address || null);
    res.json({ id: Number(r.lastInsertRowid) });
  } catch {
    res.status(400).json({ error: '客户名称已存在' });
  }
});

basicsRouter.put('/customers/:id', requireRole(...BASICS_ROLES), (req, res) => {
  const { name, contact, phone, address, active } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: '客户名称不能为空' });
  try {
    db.prepare('UPDATE customers SET name = ?, contact = ?, phone = ?, address = ?, active = ? WHERE id = ?')
      .run(String(name).trim(), contact || null, phone || null, address || null, active ? 1 : 0, req.params.id);
    res.json({ ok: true });
  } catch {
    res.status(400).json({ error: '客户名称已存在' });
  }
});

basicsRouter.get('/vendors', (req, res) => {
  const rows = db.prepare('SELECT * FROM vendors ORDER BY active DESC, type, name').all();
  res.json({ vendors: rows });
});

function normVendorTypes(input) {
  const valid = ['milling', 'cnc', 'grinding', 'plating', 'other'];
  const arr = Array.isArray(input) ? input : String(input || '').split(',');
  const set = [...new Set(arr.map(s => String(s).trim()).filter(Boolean))];
  if (!set.length || set.some(t => !valid.includes(t))) return null;
  return set.join(',');
}

basicsRouter.post('/vendors', requireRole(...BASICS_ROLES), (req, res) => {
  const { name, type, contact, phone, address } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: '厂家名称不能为空' });
  const types = normVendorTypes(type);
  if (!types) return res.status(400).json({ error: '请至少选择一种厂家类型' });
  try {
    const r = db.prepare('INSERT INTO vendors (name, type, contact, phone, address) VALUES (?, ?, ?, ?, ?)')
      .run(String(name).trim(), types, contact || null, phone || null, address || null);
    res.json({ id: Number(r.lastInsertRowid) });
  } catch {
    res.status(400).json({ error: '厂家名称已存在' });
  }
});

basicsRouter.put('/vendors/:id', requireRole(...BASICS_ROLES), (req, res) => {
  const { name, type, contact, phone, address, active } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: '厂家名称不能为空' });
  const types = normVendorTypes(type);
  if (!types) return res.status(400).json({ error: '请至少选择一种厂家类型' });
  try {
    db.prepare('UPDATE vendors SET name = ?, type = ?, contact = ?, phone = ?, address = ?, active = ? WHERE id = ?')
      .run(String(name).trim(), types, contact || null, phone || null, address || null, active ? 1 : 0, req.params.id);
    res.json({ ok: true });
  } catch {
    res.status(400).json({ error: '厂家名称已存在' });
  }
});

basicsRouter.get('/users', requireRole('admin'), (req, res) => {
  const rows = db.prepare('SELECT id, username, name, role, active, created_at FROM users ORDER BY id').all();
  res.json({ users: rows });
});

const VALID_ROLES = ['admin', 'finance', 'cnc_manager', 'clerk', 'follower', 'programmer', 'outsourcer'];

basicsRouter.post('/users', requireRole('admin'), (req, res) => {
  const { username, password, name, role } = req.body || {};
  if (!username || !String(username).trim()) return res.status(400).json({ error: '用户名不能为空' });
  if (!password || String(password).length < 6) return res.status(400).json({ error: '密码至少6位' });
  if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: '角色无效' });
  if (!name || !String(name).trim()) return res.status(400).json({ error: '姓名不能为空' });
  try {
    const r = db.prepare('INSERT INTO users (username, password_hash, name, role) VALUES (?, ?, ?, ?)')
      .run(String(username).trim(), hashPassword(String(password)), String(name).trim(), role);
    res.json({ id: Number(r.lastInsertRowid) });
  } catch {
    res.status(400).json({ error: '用户名已存在' });
  }
});

basicsRouter.put('/users/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const { name, role, active, password } = req.body || {};
  if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: '角色无效' });
  if (!name || !String(name).trim()) return res.status(400).json({ error: '姓名不能为空' });
  if (id === req.user.id && (!active || role !== 'admin')) {
    return res.status(400).json({ error: '不能停用或降级自己的账号' });
  }
  db.prepare('UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?')
    .run(String(name).trim(), role, active ? 1 : 0, id);
  if (password) {
    if (String(password).length < 6) return res.status(400).json({ error: '密码至少6位' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(password)), id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }
  if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  res.json({ ok: true });
});
