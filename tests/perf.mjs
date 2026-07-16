// 性能实测：造真实规模数据，测热点接口耗时
const BASE = 'http://localhost:' + (process.argv[2] || '3000');
const login = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) }).then(r => r.json());
const H = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };
const J = (u, b) => fetch(BASE + '/api' + u, { method: 'POST', headers: H, body: JSON.stringify(b) }).then(async r => ({ s: r.status, d: await r.json().catch(() => ({})) }));
const G = u => fetch(BASE + '/api' + u, { headers: H }).then(r => r.json());
const timeIt = async (name, fn) => {
  const t0 = performance.now();
  const r = await fn();
  const ms = Math.round(performance.now() - t0);
  const flag = ms > 1000 ? '🔴' : ms > 400 ? '🟡' : '✓';
  console.log(`  ${flag} ${name}: ${ms}ms`);
  return { ms, r };
};

console.log('== 造数据：100张订单 / 约3000块板 ==');
const t0 = performance.now();
const custs = [];
for (let i = 0; i < 10; i++) custs.push((await J('/customers', { name: '压测客户' + i })).d.id);
const vendors = [];
for (const [n, t] of [['压测CNC厂', 'cnc'], ['压测电镀厂', 'plating']]) vendors.push((await J('/vendors', { name: n, type: t })).d.id);

const orderIds = [];
for (let i = 0; i < 100; i++) {
  const items = [];
  for (let j = 0; j < 3; j++) items.push({ name: '大板', drawing_no: `PF-${i}-${j}`, spec: '850*520*30', material: 'A7075', qty: 10, unit_price: 1000 + j });
  const o = await J('/orders', { customer_id: custs[i % 10], customer_po: 'PF-PO-' + i, due_date: '2026-08-15', items });
  if (o.d.id) orderIds.push(o.d.id);
}
console.log(`  订单创建完成 ${orderIds.length} 张，耗时 ${Math.round(performance.now() - t0)}ms`);

// 给一半订单推进工序，制造真实的 stages/outsourcing/shipments 数据
let staged = 0;
for (const oid of orderIds.slice(0, 50)) {
  const pcs = (await G(`/orders/${oid}/pieces`)).pieces;
  const ids = pcs.map(p => p.id);
  await J('/progress', { piece_ids: ids, stage: 'milling' });
  await J('/progress', { piece_ids: ids.slice(0, 20), stage: 'cnc' });
  await J('/progress', { piece_ids: ids.slice(0, 10), stage: 'grinding' });
  if (staged < 20) {
    const b = await J('/outsourcing', { type: 'plating', vendor_id: vendors[1], piece_ids: ids.slice(0, 10), expected_date: '2026-08-01' });
    if (b.d.id) await J(`/outsourcing/${b.d.id}/confirm`);
  }
  staged++;
}
const total = (await G('/orders?status=active')).orders.reduce((s, o) => s + (o.total || 0), 0);
console.log(`  数据规模：${orderIds.length} 张订单 / ${total} 块板 / 50张已报工 / 20张在外`);

console.log('\n== 热点接口耗时（>400ms黄 >1s红）==');
await timeIt('看板 /dashboard', () => G('/dashboard'));
await timeIt('订单列表(全部100张+滞留统计)', () => G('/orders?status=active'));
await timeIt('订单列表+关键词搜索', () => G('/orders?q=PF-50'));
await timeIt('板件全局查询(300上限)', () => G('/pieces/search?q=大板'));
await timeIt('板件查询+状态筛选', () => G('/pieces/search?q=&stage=wait_cnc'));
await timeIt('订单详情', () => G('/orders/' + orderIds[0]));
await timeIt('订单板件表(30件)', () => G(`/orders/${orderIds[0]}/pieces`));
await timeIt('外发列表', () => G('/outsourcing'));
await timeIt('送货单列表', () => G('/shipments'));

console.log('\n== 并发（10个用户同时刷看板）==');
const t1 = performance.now();
await Promise.all(Array(10).fill(0).map(() => G('/dashboard')));
console.log(`  10并发看板总耗时: ${Math.round(performance.now() - t1)}ms`);

const t2 = performance.now();
await Promise.all([G('/dashboard'), G('/orders?status=active'), G('/pieces/search?q=大板'), G('/outsourcing'), G('/shipments')]);
console.log(`  5个不同重接口并发: ${Math.round(performance.now() - t2)}ms`);

console.log('\n== 并发写入（10人同时报工，测锁冲突）==');
const pcs = (await G(`/orders/${orderIds[60]}/pieces`)).pieces.map(p => p.id);
const t3 = performance.now();
const writes = await Promise.all(pcs.slice(0, 10).map(id => J('/progress', { piece_ids: [id], stage: 'milling' })));
const okCount = writes.filter(w => w.s === 200).length;
console.log(`  10并发写入: ${okCount}/10 成功, ${Math.round(performance.now() - t3)}ms ${okCount === 10 ? '✓ 无锁冲突丢失' : '🔴 有失败!'}`);
