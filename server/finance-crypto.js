import nacl from 'tweetnacl';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './db.js';

// ============ 财务数据加密 ============
// 落盘：finance_entries/finance_payments 的敏感字段整体加密存 enc 列（xsalsa20-poly1305）。
// 传输：前端每次会话用 x25519 握手协商共享密钥，之后 /finance/* 的请求体与响应体全部密文，
//       HTTP 明文链路上抓包只能看到密文（防被动嗅探；无 HTTPS 无法防主动中间人，见 README）。

// ---- 落盘密钥：优先环境变量 FINANCE_KEY(64位hex)，否则 data/finance.key 自动生成 ----
function loadAtRestKey() {
  const env = process.env.FINANCE_KEY;
  if (env && /^[0-9a-fA-F]{64}$/.test(env.trim())) {
    return Uint8Array.from(Buffer.from(env.trim(), 'hex'));
  }
  const fp = path.join(DATA_DIR, 'finance.key');
  if (existsSync(fp)) {
    const hex = readFileSync(fp, 'utf8').trim();
    if (/^[0-9a-fA-F]{64}$/.test(hex)) return Uint8Array.from(Buffer.from(hex, 'hex'));
  }
  const key = randomBytes(32);
  writeFileSync(fp, key.toString('hex'), { mode: 0o600 });
  console.log('[财务加密] 已生成落盘密钥 data/finance.key —— 备份数据库时务必一并备份此文件，丢了财务数据无法解密！');
  return Uint8Array.from(key);
}
const atRestKey = loadAtRestKey();

const utf8 = s => new TextEncoder().encode(s);
const unutf8 = b => new TextDecoder().decode(b);
const toB64 = u8 => Buffer.from(u8).toString('base64');
const fromB64 = s => Uint8Array.from(Buffer.from(s, 'base64'));
const concat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };

// 记录级加密：obj -> base64(nonce|cipher)
export function encRecord(obj) {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const boxed = nacl.secretbox(utf8(JSON.stringify(obj)), nonce, atRestKey);
  return toB64(concat(nonce, boxed));
}

export function decRecord(s) {
  const raw = fromB64(s);
  const nonce = raw.slice(0, nacl.secretbox.nonceLength);
  const opened = nacl.secretbox.open(raw.slice(nacl.secretbox.nonceLength), nonce, atRestKey);
  if (!opened) throw new Error('财务数据解密失败（密钥不匹配？检查 data/finance.key 或 FINANCE_KEY）');
  return JSON.parse(unutf8(opened));
}

// ---- 传输会话：token -> 共享密钥 ----
const sessions = new Map(); // token -> { key: Uint8Array(32), exp: ms }
const SESSION_TTL = 8 * 3600 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) if (s.exp < now) sessions.delete(t);
}, 600_000).unref();

export function handshake(token, clientPubB64) {
  const clientPub = fromB64(String(clientPubB64 || ''));
  if (clientPub.length !== nacl.box.publicKeyLength) throw new Error('公钥格式不对');
  const kp = nacl.box.keyPair();
  const shared = nacl.box.before(clientPub, kp.secretKey);
  sessions.set(token, { key: shared, exp: Date.now() + SESSION_TTL });
  return toB64(kp.publicKey);
}

export function getSession(token) {
  const s = sessions.get(token);
  if (!s || s.exp < Date.now()) return null;
  return s;
}

export function encPayload(key, obj) {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const boxed = nacl.secretbox(utf8(JSON.stringify(obj)), nonce, key);
  return toB64(concat(nonce, boxed));
}

export function decPayload(key, s) {
  const raw = fromB64(s);
  const nonce = raw.slice(0, nacl.secretbox.nonceLength);
  const opened = nacl.secretbox.open(raw.slice(nacl.secretbox.nonceLength), nonce, key);
  if (!opened) throw new Error('传输解密失败');
  return JSON.parse(unutf8(opened));
}

// 二进制解密（加密上传的Excel文件：nonce|cipher）
export function decPayloadBytes(key, buf) {
  const raw = Uint8Array.from(buf);
  const nonce = raw.slice(0, nacl.secretbox.nonceLength);
  const opened = nacl.secretbox.open(raw.slice(nacl.secretbox.nonceLength), nonce, key);
  if (!opened) throw new Error('文件解密失败');
  return Buffer.from(opened);
}
