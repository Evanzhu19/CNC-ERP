import { randomBytes } from 'node:crypto';
import { db, verifyPassword } from './db.js';

// procurement（采购主管）：与刀具系统打通的角色，在ERP拥有全部权限
export const PRICE_ROLES = ['admin', 'procurement', 'finance', 'cnc_manager'];
export const ENTRY_ROLES = ['admin', 'procurement', 'cnc_manager', 'clerk', 'follower'];
export const BASICS_ROLES = ['admin', 'procurement', 'cnc_manager', 'clerk', 'follower', 'finance'];

const SESSION_DAYS = 30;

export function createSession(userId) {
  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  return token;
}

export function login(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
  if (!user || !verifyPassword(password, user.password_hash)) return null;
  return user;
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.query.token || '');
  if (!token) return res.status(401).json({ error: '未登录' });
  const row = db.prepare(`
    SELECT u.id, u.username, u.name, u.role, s.token, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND u.active = 1
  `).get(token);
  if (!row || new Date(row.expires_at) < new Date()) {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
  req.user = { id: row.id, username: row.username, name: row.name, role: row.role };
  req.token = token;
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: '没有权限进行此操作' });
    }
    next();
  };
}

export function canSeePrice(req) {
  return PRICE_ROLES.includes(req.user.role);
}

export function logout(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}
