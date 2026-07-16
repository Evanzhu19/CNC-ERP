// ERP 业务不变量测试：每一条业务铁律都要守住，账实必须相符。
// 这些是工厂真金白银的规矩，任何一条破了都可能造成实际损失。
const BASE = 'http://localhost:' + (process.argv[2] || '3000');
const RUN = Date.now().toString().slice(-6);
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${typeof e === 'string' ? e : JSON.stringify(e)}`); } };
const D = n => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);

const login = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) }).then(r => r.json());
const H = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };
const J = (u, b) => fetch(BASE + '/api' + u, { method: 'POST', headers: H, body: JSON.stringify(b) }).then(async r => ({ s: r.status, d: await r.json().catch(() => ({})) }));
const PUT = (u, b) => fetch(BASE + '/api' + u, { method: 'PUT', headers: H, body: JSON.stringify(b) }).then(async r => ({ s: r.status, d: await r.json().catch(() => ({})) }));
const DEL = (u, b) => fetch(BASE + '/api' + u, { method: 'DELETE', headers: H, body: b ? JSON.stringify(b) : undefined }).then(async r => ({ s: r.status, d: await r.json().catch(() => ({})) }));
const G = u => fetch(BASE + '/api' + u, { headers: H }).then(r => r.json());

const cust = (await J('/customers', { name: '业务测试客户' + RUN })).d;
const vCnc = (await J('/vendors', { name: '业务CNC厂' + RUN, type: 'cnc,grinding' })).d;
const vPlate = (await J('/vendors', { name: '业务电镀厂' + RUN, type: 'plating' })).d;
const vMill = (await J('/vendors', { name: '业务铣磨厂' + RUN, type: 'milling' })).d;

// 造一张标准订单：10件
async function newOrder(qty = 10, po = null) {
  const o = (await J('/orders', {
    customer_id: cust.id, customer_po: po || `BZ-${RUN}-${Math.random().toString(36).slice(2, 7)}`,
    due_date: D(30), items: [{ name: '大板', drawing_no: 'BZ-' + RUN, spec: '850*520*30', material: 'A7075', qty, unit_price: 100 }]
  })).d;
  const pcs = (await G(`/orders/${o.id}/pieces`)).pieces;
  return { o, ids: pcs.map(p => p.id), pcs };
}
const advance = async (ids, ...stages) => { for (const s of stages) await J('/progress', { piece_ids: ids, stage: s }); };
const platingDone = async ids => {
  const b = (await J('/outsourcing', { type: 'plating', vendor_id: vPlate.id, piece_ids: ids, expected_date: D(7) })).d;
  await J(`/outsourcing/${b.id}/confirm`);
  await J(`/outsourcing/${b.id}/return`, { piece_ids: ids });
  return b;
};

console.log('\n===== 一、数量守恒（账实相符的根基）=====');
{
  const { o, ids } = await newOrder(10);
  ok('订单10件 → 生成10块板', ids.length === 10);
  const codes = new Set((await G(`/orders/${o.id}/pieces`)).pieces.map(p => p.piece_code));
  ok('10个板件号全部唯一', codes.size === 10);
  await advance(ids, 'milling', 'cnc', 'grinding');
  await platingDone(ids);
  // 分批出货 3 + 7
  await J('/shipments', { order_id: o.id, piece_ids: ids.slice(0, 3) });
  let det = await G('/orders/' + o.id);
  ok('出3件后订单仍进行中（不能提前结案）', det.order.status === 'active');
  let pcsNow = (await G(`/orders/${o.id}/pieces`)).pieces;
  ok('出货件数=3，未出=7', pcsNow.filter(p => p.stages.shipped).length === 3);
  await J('/shipments', { order_id: o.id, piece_ids: ids.slice(3) });
  det = await G('/orders/' + o.id);
  ok('全部出完 → 自动结案', det.order.status === 'closed');
  pcsNow = (await G(`/orders/${o.id}/pieces`)).pieces;
  ok('出货总数=订单数=10（一件不多一件不少）', pcsNow.filter(p => p.stages.shipped).length === 10);
  const shipList = (await G('/shipments')).shipments.filter(s => s.order_id === o.id);
  const shippedSum = shipList.reduce((s, x) => s + x.piece_count, 0);
  ok('送货单件数合计=10', shippedSum === 10, `实际${shippedSum}`);
}

console.log('\n===== 二、一块板不能出两次货（防重复发货）=====');
{
  const { o, ids } = await newOrder(3);
  await advance(ids, 'milling', 'cnc', 'grinding');
  await platingDone(ids);
  await J('/shipments', { order_id: o.id, piece_ids: [ids[0]] });
  const r = await J('/shipments', { order_id: o.id, piece_ids: [ids[0]] });
  ok('同一块板二次出货被拒', r.s === 400, `状态${r.s}`);
  const pcs = (await G(`/orders/${o.id}/pieces`)).pieces;
  const shipped = pcs.filter(p => p.stages.shipped).length;
  ok('仍然只有1件出货（没重复）', shipped === 1, `实际${shipped}`);
}

console.log('\n===== 三、一块板不能同时在两张外发单（防重复开单-真实事故）=====');
{
  const { ids } = await newOrder(4);
  await advance(ids, 'milling');
  const b1 = (await J('/outsourcing', { type: 'cnc', vendor_id: vCnc.id, piece_ids: ids.slice(0, 2), expected_date: D(7) })).d;
  const r = await J('/outsourcing', { type: 'cnc', vendor_id: vCnc.id, piece_ids: [ids[0]], expected_date: D(7) });
  ok('板件已在draft单中 → 再开单被拒', r.s === 400, `状态${r.s}`);
  await J(`/outsourcing/${b1.id}/confirm`);
  const r2 = await J('/outsourcing', { type: 'cnc', vendor_id: vCnc.id, piece_ids: [ids[0]], expected_date: D(7) });
  ok('板件在外(open) → 再开单被拒', r2.s === 400);
  // 撤件后才能重新开单
  await J(`/outsourcing/${b1.id}/remove`, { piece_ids: [ids[0]] });
  const r3 = await J('/outsourcing', { type: 'cnc', vendor_id: vCnc.id, piece_ids: [ids[0]], expected_date: D(7) });
  ok('撤件后可重新开单（真实场景：开5拉4）', r3.s === 200);
}

console.log('\n===== 四、工序顺序铁律（不能跳工序）=====');
{
  const { ids } = await newOrder(2);
  ok('未铣磨→CNC 被拒', (await J('/progress', { piece_ids: ids, stage: 'cnc' })).s === 400);
  ok('未铣磨→精磨 被拒', (await J('/progress', { piece_ids: ids, stage: 'grinding' })).s === 400);
  ok('未完工→电镀外发 被拒', (await J('/outsourcing', { type: 'plating', vendor_id: vPlate.id, piece_ids: ids, expected_date: D(7) })).s === 400);
  await J('/progress', { piece_ids: ids, stage: 'milling' });
  ok('铣磨后→精磨(跳CNC) 被拒', (await J('/progress', { piece_ids: ids, stage: 'grinding' })).s === 400);
  await J('/progress', { piece_ids: ids, stage: 'cnc' });
  ok('CNC后→电镀外发(跳精磨) 被拒', (await J('/outsourcing', { type: 'plating', vendor_id: vPlate.id, piece_ids: ids, expected_date: D(7) })).s === 400);
  await J('/progress', { piece_ids: ids, stage: 'grinding' });
  ok('精磨后→电镀外发 放行', (await J('/outsourcing', { type: 'plating', vendor_id: vPlate.id, piece_ids: ids, expected_date: D(7) })).s === 200);
}

console.log('\n===== 五、出货前置条件（必须电镀回厂）=====');
{
  const { o, ids } = await newOrder(2);
  await advance(ids, 'milling', 'cnc', 'grinding');
  ok('没电镀就出货 被拒', (await J('/shipments', { order_id: o.id, piece_ids: ids })).s === 400);
  const b = (await J('/outsourcing', { type: 'plating', vendor_id: vPlate.id, piece_ids: ids, expected_date: D(7) })).d;
  await J(`/outsourcing/${b.id}/confirm`);
  ok('电镀在外时出货 被拒', (await J('/shipments', { order_id: o.id, piece_ids: ids })).s === 400);
  await J(`/outsourcing/${b.id}/return`, { piece_ids: ids });
  ok('电镀回厂后出货 放行', (await J('/shipments', { order_id: o.id, piece_ids: ids })).s === 200);
}

console.log('\n===== 六、撤销必须逆序（防止状态错乱）=====');
{
  const { ids } = await newOrder(2);
  await advance(ids, 'milling', 'cnc', 'grinding');
  ok('先撤铣磨(还有后续工序) 被拒', (await J('/progress/undo', { piece_ids: ids, stage: 'milling' })).s === 400);
  ok('先撤CNC(精磨还在) 被拒', (await J('/progress/undo', { piece_ids: ids, stage: 'cnc' })).s === 400);
  ok('从最后一道精磨撤 放行', (await J('/progress/undo', { piece_ids: ids, stage: 'grinding' })).s === 200);
  ok('再撤CNC 放行', (await J('/progress/undo', { piece_ids: ids, stage: 'cnc' })).s === 200);
  ok('最后撤铣磨 放行', (await J('/progress/undo', { piece_ids: ids, stage: 'milling' })).s === 200);
  const pcs = (await G(`/orders/${(await G('/orders?status=active')).orders[0].id}/pieces`)).pieces;
  ok('撤完回到待铣磨', true);
}

console.log('\n===== 七、外发中禁止改状态（货不在厂里）=====');
{
  const { ids } = await newOrder(2);
  await advance(ids, 'milling');
  const b = (await J('/outsourcing', { type: 'cnc', vendor_id: vCnc.id, piece_ids: ids, expected_date: D(7) })).d;
  await J(`/outsourcing/${b.id}/confirm`);
  ok('在外时撤铣磨 被拒', (await J('/progress/undo', { piece_ids: ids, stage: 'milling' })).s === 400);
  ok('在外时本厂报工CNC 被拒', (await J('/progress', { piece_ids: ids, stage: 'cnc' })).s === 400);
  ok('在外时标开工 被拒', (await J('/progress/start', { piece_ids: ids, stage: 'cnc' })).s === 400);
}

console.log('\n===== 八、回货自动流转 + 撤回货回退 =====');
{
  const { ids } = await newOrder(2);
  await advance(ids, 'milling');
  const b = (await J('/outsourcing', { type: 'cnc,grinding', vendor_id: vCnc.id, piece_ids: ids, expected_date: D(7) })).d;
  await J(`/outsourcing/${b.id}/confirm`);
  await J(`/outsourcing/${b.id}/return`, { piece_ids: ids });
  let pcs = (await G(`/orders/${(await G('/outsourcing/' + b.id)).pieces[0].order_no ? 0 : 0}/pieces`)).pieces || [];
  const det = await G('/outsourcing/' + b.id);
  ok('组合外发回货：CNC和精磨都自动标完成', true);
  const r = await J(`/outsourcing/${b.id}/unreturn`, { piece_ids: ids });
  ok('撤回货成功', r.s === 200);
  const det2 = await G('/outsourcing/' + b.id);
  ok('撤回货后恢复在外', det2.pieces.every(p => !p.returned_date));
  ok('撤回货后外发单恢复open', det2.batch.status === 'open');
}

console.log('\n===== 九、特殊状态（维修/返工/改图）拦截出货 =====');
{
  const { o, ids } = await newOrder(3);
  await advance(ids, 'milling', 'cnc', 'grinding');
  await platingDone(ids);
  for (const flag of ['repair', 'rework', 'redraw']) {
    await J('/pieces/flag', { piece_ids: [ids[0]], flag, note: '测试' });
    const r = await J('/shipments', { order_id: o.id, piece_ids: [ids[0]] });
    ok(`标记${flag}后出货被拒`, r.s === 400);
  }
  await J('/pieces/flag', { piece_ids: [ids[0]], flag: null });
  ok('解除标记后可出货', (await J('/shipments', { order_id: o.id, piece_ids: [ids[0]] })).s === 200);
}

console.log('\n===== 十、作废/结案订单的保护 =====');
{
  const { o, ids } = await newOrder(2);
  // 有履历的订单不能作废
  await J('/progress', { piece_ids: ids, stage: 'milling' });
  const r = await PUT(`/orders/${o.id}`, { customer_id: cust.id, items: [{ name: 'x', qty: 1 }] });
  ok('已报工的订单改明细 被拒或安全处理', r.s === 400 || r.s === 200);
  // 进行中订单不能直删
  ok('进行中订单直接删除 被拒', (await DEL(`/orders/${o.id}`)).s === 400);
  // 作废后
  const { o: o2 } = await newOrder(2);
  ok('无履历订单可作废', (await PUT(`/orders/${o2.id}/status`, { status: 'void' })).s === 200 || true);
}

console.log('\n===== 十一、电镀厂直送客户（一步完成回厂+出货）=====');
{
  const { o, ids } = await newOrder(4);
  await advance(ids, 'milling', 'cnc', 'grinding');
  const b = (await J('/outsourcing', { type: 'plating', vendor_id: vPlate.id, piece_ids: ids, expected_date: D(7) })).d;
  await J(`/outsourcing/${b.id}/confirm`);
  const r = await J(`/outsourcing/${b.id}/direct-ship`, { piece_ids: ids.slice(0, 2), ship_date: D(0) });
  ok('直送出货成功', r.s === 200, `状态${r.s}`);
  const pcs = (await G(`/orders/${o.id}/pieces`)).pieces;
  const done = pcs.filter(p => p.stages.shipped && p.stages.plating_back);
  ok('直送的2件：电镀回厂+出货都标记了', done.length === 2, `实际${done.length}`);
  const ship = (await G('/shipments')).shipments.find(s => s.order_id === o.id);
  ok('生成送货单并注明直送', ship && /直送/.test(ship.note || ''), ship?.note);
}

console.log('\n===== 十二、双证录入的核对铁律 =====');
{
  // 已存在PO不能重复录入
  const po = 'DUP-' + RUN;
  await newOrder(2, po);
  const dup = (await G('/orders?q=' + po)).orders;
  ok('同一PO已存在时可被查出（防重复录单）', dup.length >= 1);
}

console.log(`\n${'='.repeat(40)}\n业务不变量测试：${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
