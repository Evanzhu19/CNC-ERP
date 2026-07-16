// 破坏性测试：模拟真实车间里会发生的"人祸"——
// 网络卡了猛点几下、两个人同时操作同一批板、乱序点按钮、拿旧页面提交。
// 判据不是"接口没报错"，而是"数据有没有错"：账实必须永远相符。
const BASE = 'http://localhost:' + (process.argv[2] || '3000');
const RUN = Date.now().toString().slice(-6);
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  🔴 ${n} ${typeof e === 'string' ? e : JSON.stringify(e)}`); } };
const D = n => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);

const login = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) }).then(r => r.json());
const H = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };
const J = (u, b) => fetch(BASE + '/api' + u, { method: 'POST', headers: H, body: JSON.stringify(b) }).then(async r => ({ s: r.status, d: await r.json().catch(() => ({})) }));
const G = u => fetch(BASE + '/api' + u, { headers: H }).then(r => r.json());

const cust = (await J('/customers', { name: '混沌客户' + RUN })).d;
const vCnc = (await J('/vendors', { name: '混沌CNC厂' + RUN, type: 'cnc,grinding' })).d;
const vPlate = (await J('/vendors', { name: '混沌电镀厂' + RUN, type: 'plating' })).d;

async function newOrder(qty = 10) {
  const o = (await J('/orders', {
    customer_id: cust.id, customer_po: `CH-${RUN}-${Math.random().toString(36).slice(2, 7)}`,
    due_date: D(30), items: [{ name: '大板', drawing_no: 'CH-' + RUN, spec: '850*520*30', qty, unit_price: 100 }]
  })).d;
  const pcs = (await G(`/orders/${o.id}/pieces`)).pieces;
  return { o, ids: pcs.map(p => p.id) };
}
const advance = async (ids, ...stages) => { for (const s of stages) await J('/progress', { piece_ids: ids, stage: s }); };
const platingDone = async ids => {
  const b = (await J('/outsourcing', { type: 'plating', vendor_id: vPlate.id, piece_ids: ids, expected_date: D(7) })).d;
  await J(`/outsourcing/${b.id}/confirm`);
  await J(`/outsourcing/${b.id}/return`, { piece_ids: ids });
};

console.log('\n===== 1. 网络卡了猛点N下（重复提交）=====');
{
  const { o, ids } = await newOrder(5);
  // 同一报工请求并发打10次
  const rs = await Promise.all(Array(10).fill(0).map(() => J('/progress', { piece_ids: ids, stage: 'milling' })));
  const okCount = rs.filter(r => r.s === 200).length;
  const pcs = (await G(`/orders/${o.id}/pieces`)).pieces;
  const milled = pcs.filter(p => p.stages.milling).length;
  ok(`报工猛点10次：${okCount}次返回成功，但5块板各只有1条铣磨记录`, milled === 5, `实际标记${milled}件`);

  // 同一出货请求并发打5次
  await advance(ids, 'cnc', 'grinding');
  await platingDone(ids);
  const ships = await Promise.all(Array(5).fill(0).map(() => J('/shipments', { order_id: o.id, piece_ids: ids })));
  const shipOk = ships.filter(r => r.s === 200).length;
  const pcs2 = (await G(`/orders/${o.id}/pieces`)).pieces;
  const shipped = pcs2.filter(p => p.stages.shipped).length;
  ok(`出货猛点5次：只有1次成功(${shipOk}次)`, shipOk === 1, `${shipOk}次成功——可能重复发货！`);
  ok('出货件数仍是5（没重复发货）', shipped === 5, `实际${shipped}`);
  const shipDocs = (await G('/shipments')).shipments.filter(s => s.order_id === o.id);
  ok(`没有产生多余送货单（${shipDocs.length}张）`, shipDocs.length === 1, `${shipDocs.length}张送货单`);
}

console.log('\n===== 2. 两个人同时抢同一批板开外发单 =====');
{
  const { ids } = await newOrder(6);
  await advance(ids, 'milling');
  // 两人同时把同一批板加入不同的外发单
  const [r1, r2] = await Promise.all([
    J('/outsourcing', { type: 'cnc', vendor_id: vCnc.id, piece_ids: ids, expected_date: D(7), note: 'A单' }),
    J('/outsourcing', { type: 'cnc', vendor_id: vCnc.id, piece_ids: ids, expected_date: D(7), note: 'B单' })
  ]);
  const winners = [r1, r2].filter(r => r.s === 200);
  ok(`同抢同一批板：只有1张单成功（成功${winners.length}张）`, winners.length === 1, `${winners.length}张都成功了——板件被重复开单！`);
  // 验证板件确实只在一张单里
  const all = (await G('/outsourcing')).outsourcing;
  let inBatches = 0;
  for (const b of all) {
    const det = await G('/outsourcing/' + b.id);
    if (det.pieces.some(p => ids.includes(p.piece_id))) inBatches++;
  }
  ok('这批板只出现在1张外发单里', inBatches === 1, `出现在${inBatches}张单里`);
}

console.log('\n===== 3. 两个人同时对同一块板做冲突操作 =====');
{
  const { o, ids } = await newOrder(4);
  await advance(ids, 'milling', 'cnc', 'grinding');
  await platingDone(ids);
  // 一人出货，另一人同时标返工
  const [shipR, flagR] = await Promise.all([
    J('/shipments', { order_id: o.id, piece_ids: [ids[0]] }),
    J('/pieces/flag', { piece_ids: [ids[0]], flag: 'rework', note: '同时标记' })
  ]);
  const pcs = (await G(`/orders/${o.id}/pieces`)).pieces;
  const p = pcs.find(x => x.id === ids[0]);
  const shipped = !!p.stages.shipped;
  const flagged = !!p.flag;
  // 两者都成功也可接受（先出货后标记≈发现问题），但数据必须自洽、不能崩
  ok('同时出货+标返工：数据自洽未崩溃', shipped || flagged, JSON.stringify({ shipped, flagged }));
  ok('  状态可解释（已出货或已标记，不是半截）', typeof p.statusTag?.label === 'string');
}

console.log('\n===== 4. 乱序点按钮（拿旧页面操作）=====');
{
  const { o, ids } = await newOrder(3);
  await advance(ids, 'milling', 'cnc', 'grinding');
  await platingDone(ids);
  await J('/shipments', { order_id: o.id, piece_ids: ids });
  // 出货后还想报工/外发/撤工序（旧页面残留按钮）
  ok('已出货的板再报工 被拒', (await J('/progress', { piece_ids: ids, stage: 'milling' })).s === 400);
  ok('已出货的板开外发单 被拒', (await J('/outsourcing', { type: 'cnc', vendor_id: vCnc.id, piece_ids: ids, expected_date: D(7) })).s === 400);
  ok('已出货的板撤精磨 被拒', (await J('/progress/undo', { piece_ids: ids, stage: 'grinding' })).s === 400);
  ok('已出货的板标开工 被拒', (await J('/progress/start', { piece_ids: ids, stage: 'cnc' })).s === 400);
}

console.log('\n===== 5. 同时删除与操作（脏引用）=====');
{
  const { ids } = await newOrder(3);
  await advance(ids, 'milling');
  const b = (await J('/outsourcing', { type: 'cnc', vendor_id: vCnc.id, piece_ids: ids, expected_date: D(7) })).d;
  // 一人撤销外发单，另一人同时确认
  const [delR, confR] = await Promise.all([
    fetch(BASE + `/api/outsourcing/${b.id}`, { method: 'DELETE', headers: H }).then(r => r.status),
    J(`/outsourcing/${b.id}/confirm`)
  ]);
  ok('撤单与确认并发：没有500崩溃', delR < 500 && confR.s < 500, `del=${delR} conf=${confR.s}`);
  // 已删除的单再操作
  const after = await J(`/outsourcing/${b.id}/return`, { piece_ids: ids });
  ok('对已消失的外发单登记回货：优雅报错非500', after.s === 404 || after.s === 400, `状态${after.s}`);
}

console.log('\n===== 6. 混合并发洪水（20个操作同时打）=====');
{
  const { o, ids } = await newOrder(20);
  await advance(ids, 'milling');
  const ops = [];
  // 10个人各自报工不同的板 + 同时有人查询
  for (let i = 0; i < 10; i++) ops.push(J('/progress', { piece_ids: [ids[i]], stage: 'cnc' }));
  for (let i = 0; i < 5; i++) ops.push(G('/dashboard'));
  for (let i = 0; i < 5; i++) ops.push(G(`/orders/${o.id}/pieces`));
  ops.push(J('/outsourcing', { type: 'cnc', vendor_id: vCnc.id, piece_ids: ids.slice(10, 15), expected_date: D(7) }));
  ops.push(J('/pieces/flag', { piece_ids: [ids[19]], flag: 'repair', note: '洪水' }));
  const t0 = Date.now();
  const results = await Promise.allSettled(ops);
  const rejected = results.filter(r => r.status === 'rejected').length;
  const errs = results.filter(r => r.status === 'fulfilled' && r.value?.s >= 500).length;
  ok(`22个并发操作：无连接断开(${rejected})、无500(${errs})，耗时${Date.now() - t0}ms`, rejected === 0 && errs === 0);
  const pcs = (await G(`/orders/${o.id}/pieces`)).pieces;
  ok('并发后数据一致：10件CNC完成', pcs.filter(p => p.stages.cnc).length === 10, `实际${pcs.filter(p => p.stages.cnc).length}`);
  ok('并发后数据一致：5件在外', pcs.filter(p => p.statusTag.label.includes('外发')).length === 5);
  ok('并发后数据一致：1件维修中', pcs.filter(p => p.flag === 'repair').length === 1);
  ok('并发后板件总数仍是20（没丢没多）', pcs.length === 20);
}

console.log('\n===== 7. 事务回滚（一批里有一件非法，整批不入库）=====');
{
  const { o, ids } = await newOrder(5);
  await advance(ids, 'milling', 'cnc', 'grinding');
  await platingDone(ids.slice(0, 3));   // 只有3件电镀回厂
  // 5件一起出货：其中2件没电镀 → 整批应失败
  const r = await J('/shipments', { order_id: o.id, piece_ids: ids });
  ok('混合批次出货(3件合格2件不合格) 整批被拒', r.s === 400, `状态${r.s}`);
  const pcs = (await G(`/orders/${o.id}/pieces`)).pieces;
  const shipped = pcs.filter(p => p.stages.shipped).length;
  ok('合格的3件也没被偷偷出货（事务完整回滚）', shipped === 0, `已出${shipped}件——事务没回滚干净！`);
  const ships = (await G('/shipments')).shipments.filter(s => s.order_id === o.id);
  ok('没有生成半截送货单', ships.length === 0, `${ships.length}张`);
}

console.log('\n===== 8. 服务健康度终检 =====');
{
  const checks = await Promise.all([
    G('/dashboard').then(d => !!d.stages).catch(() => false),
    G('/orders?status=active').then(d => Array.isArray(d.orders)).catch(() => false),
    G('/pieces/search?q=CH').then(d => Array.isArray(d.pieces)).catch(() => false),
    G('/outsourcing').then(d => Array.isArray(d.outsourcing)).catch(() => false),
    G('/shipments').then(d => Array.isArray(d.shipments)).catch(() => false)
  ]);
  ok('经历全部破坏后：5个核心接口全部正常', checks.every(Boolean), JSON.stringify(checks));
}

console.log(`\n${'='.repeat(40)}\n破坏性测试：${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
