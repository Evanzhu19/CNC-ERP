import nacl from 'tweetnacl';
import { api } from './api.js';

// 财务传输加密通道：x25519 握手协商会话密钥，之后 /finance/* 请求体与响应体全部密文。
// HTTP 明文链路上抓包只能看到密文（防局域网被动嗅探）。

let chanKey = null;

const toB64 = u8 => btoa(String.fromCharCode(...u8));
const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const utf8 = s => new TextEncoder().encode(s);
const unutf8 = b => new TextDecoder().decode(b);

async function ensureChannel() {
  if (chanKey) return;
  const kp = nacl.box.keyPair();
  const { data } = await api.post('/finance/handshake', { pub: toB64(kp.publicKey) });
  chanKey = nacl.box.before(fromB64(data.pub), kp.secretKey);
}

function enc(obj) {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const boxed = nacl.secretbox(utf8(JSON.stringify(obj)), nonce, chanKey);
  const out = new Uint8Array(nonce.length + boxed.length);
  out.set(nonce); out.set(boxed, nonce.length);
  return toB64(out);
}

function dec(x) {
  const raw = fromB64(x);
  const nonce = raw.slice(0, nacl.secretbox.nonceLength);
  const opened = nacl.secretbox.open(raw.slice(nacl.secretbox.nonceLength), nonce, chanKey);
  if (!opened) throw new Error('响应解密失败');
  return JSON.parse(unutf8(opened));
}

async function rawCall(method, url, params, data) {
  const r = await api.request({ method, url, params, data: data !== undefined ? { x: enc(data) } : undefined });
  return dec(r.data.x);
}

export async function finCall(method, url, { params, data } = {}) {
  await ensureChannel();
  try {
    return await rawCall(method, url, params, data);
  } catch (e) {
    if (e.response?.status === 428) { // 服务器重启等导致通道失效 → 重新握手一次
      chanKey = null;
      await ensureChannel();
      return await rawCall(method, url, params, data);
    }
    throw e;
  }
}

// 加密上传（Excel账本）：文件字节整体加密后再传
export async function finUpload(url, file, params) {
  await ensureChannel();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const boxed = nacl.secretbox(bytes, nonce, chanKey);
  const fd = new FormData();
  fd.append('file', new Blob([nonce, boxed]), file.name);
  try {
    const r = await api.post(url, fd, { params });
    return dec(r.data.x);
  } catch (e) {
    if (e.response?.status === 428) {
      chanKey = null;
      return finUpload(url, file, params);
    }
    throw e;
  }
}
