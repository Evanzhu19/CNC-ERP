// 渗透+健壮性实测：越权 / 信息泄露 / 崩溃
const BASE = 'http://localhost:' + (process.argv[2] || '3000');
let issues = [];
const bad = (sev, n, e = '') => { issues.push({ sev, n, e }); console.log(`  ${sev === 'HIGH' ? '🔴' : sev === 'MED' ? '🟡' : '🔵'} ${n} ${e}`); };
const good = n => console.log(`  ✓ ${n}`);

const loginAs = (u, p) => fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) }).then(r => r.json());
const admin = await loginAs('admin', 'admin123');
const AH = { Authorization: 'Bearer ' + admin.token, 'Content-Type': 'application/json' };
const AJ = (u, b) => fetch(BASE + '/api' + u, { method: 'POST', headers: AH, body: JSON.stringify(b) }).then(async r => ({ s: r.status, d: await r.json().catch(() => ({})) }));

// 建全角色账号
const roles = { finance: 'fin1', cnc_manager: 'cnc1', clerk: 'clk1', follower: 'fol1', programmer: 'prg1', outsourcer: 'out1', procurement: 'pro1' };
const tok = {};
for (const [role, u] of Object.entries(roles)) {
  await AJ('/users', { username: u, password: u + '123456', name: u, role });
  tok[role] = (await loginAs(u, u + '123456')).token;
}
const call = (t, m, u, b) => fetch(BASE + '/api' + u, { method: m, headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }).then(async r => ({ s: r.status, d: await r.json().catch(() => ({})), raw: await Promise.resolve('') }));

// 造基础数据
const cust = (await AJ('/customers', { name: '渗透测试客户' })).d;
const ord = (await AJ('/orders', { customer_id: cust.id, customer_po: 'PT-1', items: [{ name: '板', drawing_no: 'PT-A', qty: 2, unit_price: 999 }] })).d;

console.log('\n===== 1. 价格越权（不可见价格的角色）=====');
for (const role of ['clerk', 'follower', 'programmer', 'outsourcer']) {
  const r = await call(tok[role], 'GET', '/orders?status=active');
  const leak = JSON.stringify(r.d).includes('999');
  if (leak) bad('HIGH', `${role} 从订单列表看到价格`); else good(`${role} 订单列表无价格`);
  const d = await call(tok[role], 'GET', '/orders/' + ord.id);
  const leak2 = JSON.stringify(d.d).includes('999');
  if (leak2) bad('HIGH', `${role} 从订单详情看到价格`, JSON.stringify(d.d).slice(0, 100)); else good(`${role} 订单详情无价格`);
  const p = await call(tok[role], 'GET', `/orders/${ord.id}/pieces`);
  if (JSON.stringify(p.d).includes('999')) bad('HIGH', `${role} 从板件接口看到价格`); else good(`${role} 板件接口无价格`);
}

console.log('\n===== 2. 写权限越权 =====');
for (const role of ['programmer', 'outsourcer']) {
  let r = await call(tok[role], 'POST', '/orders', { customer_id: cust.id, items: [{ name: 'x', qty: 1 }] });
  if (r.s === 200) bad('HIGH', `${role}(只读角色) 能建订单`); else good(`${role} 建订单被拒(${r.s})`);
  r = await call(tok[role], 'POST', '/progress', { piece_ids: [1], stage: 'milling' });
  if (r.s === 200) bad('HIGH', `${role} 能报工`); else good(`${role} 报工被拒(${r.s})`);
}
let r = await call(tok.clerk, 'POST', '/users', { username: 'hack', password: 'hack123456', name: 'h', role: 'admin' });
if (r.s === 200) bad('HIGH', '文员能创建管理员账号！'); else good('文员建号被拒(' + r.s + ')');
r = await call(tok.cnc_manager, 'POST', '/users', { username: 'hack2', password: 'hack123456', name: 'h', role: 'admin' });
if (r.s === 200) bad('HIGH', 'CNC主管能创建管理员！'); else good('CNC主管建号被拒(' + r.s + ')');

console.log('\n===== 3. 财务数据泄露 =====');
for (const role of ['cnc_manager', 'clerk', 'procurement', 'programmer']) {
  const r = await call(tok[role], 'GET', '/finance/accounts?kind=receivable');
  if (r.s !== 403) bad('HIGH', `${role} 能访问财务账户(${r.s})`); else good(`${role} 财务被拒`);
}
r = await call(tok.finance, 'GET', '/orders?status=active');
if (r.s !== 403) bad('MED', `财务能看订单(${r.s}) —— 财务板块围栏破了`); else good('财务看订单被拒');

console.log('\n===== 4. 越权改他人密码 / 提权 =====');
r = await call(tok.clerk, 'PUT', '/users/1', { name: 'hacked', role: 'admin', active: 1 });
if (r.s === 200) bad('HIGH', '文员能改admin账号！'); else good('文员改用户被拒(' + r.s + ')');
// 自己给自己提权
const meId = (await call(tok.clerk, 'GET', '/me')).d?.user?.id;
r = await call(tok.clerk, 'PUT', `/users/${meId}`, { name: 'x', role: 'admin', active: 1 });
if (r.s === 200) bad('HIGH', '文员能给自己提权成admin！'); else good('文员自我提权被拒(' + r.s + ')');

console.log('\n===== 5. 无/坏 token =====');
r = await fetch(BASE + '/api/orders').then(x => x.status);
if (r !== 401) bad('HIGH', `无token能访问订单(${r})`); else good('无token被拒401');
r = await fetch(BASE + '/api/orders', { headers: { Authorization: 'Bearer ' + 'x'.repeat(64) } }).then(x => x.status);
if (r !== 401) bad('HIGH', `伪造token能访问(${r})`); else good('伪造token被拒401');
r = await fetch(BASE + '/api/orders', { headers: { Authorization: 'Bearer ' } }).then(x => x.status);
if (r !== 401) bad('MED', `空token异常(${r})`); else good('空token被拒401');

console.log('\n===== 6. SQL注入 =====');
const inj = ["' OR '1'='1", "'; DROP TABLE orders;--", "1' UNION SELECT password_hash FROM users--", "%' OR 1=1--"];
for (const p of inj) {
  const r = await call(admin.token, 'GET', '/orders?q=' + encodeURIComponent(p));
  if (r.s >= 500) bad('MED', `注入串致500: ${p}`);
}
const stillOk = await call(admin.token, 'GET', '/orders?status=active');
if (stillOk.s === 200) good('注入串无效，orders表健在'); else bad('HIGH', 'orders表可能被破坏！');
const pw = await call(admin.token, 'GET', '/pieces/search?q=' + encodeURIComponent("' UNION SELECT password_hash FROM users--"));
if (JSON.stringify(pw.d).includes('scrypt') || JSON.stringify(pw.d).includes(':')) {
  const hasHash = /[0-9a-f]{32}:[0-9a-f]{128}/.test(JSON.stringify(pw.d));
  if (hasHash) bad('HIGH', '注入泄露密码哈希！'); else good('板件搜索注入无泄露');
} else good('板件搜索注入无泄露');

console.log('\n===== 7. 愚蠢用户：畸形/极端输入 =====');
const crashTests = [
  ['超长字符串(1MB)', 'POST', '/customers', { name: 'A'.repeat(1024 * 1024) }],
  ['负数量', 'POST', '/orders', { customer_id: cust.id, items: [{ name: 'x', qty: -5 }] }],
  ['天文数字', 'POST', '/orders', { customer_id: cust.id, items: [{ name: 'x', qty: 999999999999 }] }],
  ['小数数量', 'POST', '/orders', { customer_id: cust.id, items: [{ name: 'x', qty: 1.5 }] }],
  ['NaN数量', 'POST', '/orders', { customer_id: cust.id, items: [{ name: 'x', qty: 'abc' }] }],
  ['null items', 'POST', '/orders', { customer_id: cust.id, items: null }],
  ['items不是数组', 'POST', '/orders', { customer_id: cust.id, items: 'oops' }],
  ['空body', 'POST', '/orders', {}],
  ['customer_id乱来', 'POST', '/orders', { customer_id: 'DROP', items: [{ name: 'x', qty: 1 }] }],
  ['不存在的customer', 'POST', '/orders', { customer_id: 999999, items: [{ name: 'x', qty: 1 }] }],
  ['piece_ids非数组', 'POST', '/progress', { piece_ids: 'x', stage: 'milling' }],
  ['piece_ids超大数组', 'POST', '/progress', { piece_ids: Array(50000).fill(1), stage: 'milling' }],
  ['stage乱来', 'POST', '/progress', { piece_ids: [1], stage: '../../etc/passwd' }],
  ['价格负数', 'POST', '/orders', { customer_id: cust.id, items: [{ name: 'x', qty: 1, unit_price: -100 }] }],
  ['日期乱来', 'POST', '/orders', { customer_id: cust.id, order_date: 'not-a-date', items: [{ name: 'x', qty: 1 }] }],
  ['空名客户', 'POST', '/customers', { name: '   ' }],
  ['数组当name', 'POST', '/customers', { name: ['a', 'b'] }],
  ['对象当name', 'POST', '/customers', { name: { evil: 1 } }],
];
for (const [name, m, u, b] of crashTests) {
  try {
    const r = await call(admin.token, m, u, b);
    if (r.s >= 500) bad('MED', `${name} → 500服务器错误`, JSON.stringify(r.d).slice(0, 80));
    else good(`${name} → 优雅拒绝(${r.s})`);
  } catch (e) {
    bad('HIGH', `${name} → 连接断开！服务可能崩了`, e.message);
  }
}
// 服务还活着吗
const alive = await fetch(BASE + '/api/orders?status=active', { headers: AH }).then(x => x.status).catch(() => 'DEAD');
if (alive === 200) good('❤ 一轮畸形输入后服务仍存活'); else bad('HIGH', '服务已挂！' + alive);

console.log('\n===== 8. 信息泄露：错误信息 =====');
r = await call(admin.token, 'POST', '/customers', { name: '渗透测试客户' }); // 重复名
if (/SQLITE|constraint|UNIQUE|table/i.test(JSON.stringify(r.d))) bad('MED', '错误信息泄露数据库结构', JSON.stringify(r.d).slice(0, 80));
else good('重复名错误信息干净');

console.log(`\n================ 汇总 ================`);
console.log(`发现问题 ${issues.length} 个：HIGH ${issues.filter(i => i.sev === 'HIGH').length}，MED ${issues.filter(i => i.sev === 'MED').length}`);
for (const i of issues) console.log(`  [${i.sev}] ${i.n} ${i.e}`);
