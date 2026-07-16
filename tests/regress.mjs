// 核心业务回归：确认安全加固没有碰坏正常流程
const BASE = 'http://localhost:' + (process.argv[2] || '3000');
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };
const D = n => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
const RUN = Date.now().toString().slice(-6); // 每次跑用唯一后缀，可反复执行

const login = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) }).then(r => r.json());
const H = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };
const J = (u, b) => fetch(BASE + '/api' + u, { method: 'POST', headers: H, body: JSON.stringify(b) }).then(async r => ({ s: r.status, d: await r.json().catch(() => ({})) }));
const G = u => fetch(BASE + '/api' + u, { headers: H }).then(r => r.json());

console.log('== 全流程：录单→报工→外发→回货→出货→结案 ==');
const c = (await J('/customers', { name: '回归客户' + RUN, contact: '陈生', phone: '13800000000', address: '东莞' })).d;
ok('建客户', !!c.id);
const vc = (await J('/vendors', { name: '回归CNC厂' + RUN, type: 'cnc,grinding', contact: '李工', address: '惠州' })).d;
const vp = (await J('/vendors', { name: '回归电镀厂' + RUN, type: 'plating' })).d;
ok('建厂家(多类型+地址)', !!vc.id && !!vp.id);

const o = (await J('/orders', { customer_id: c.id, customer_po: 'HG-PO-' + RUN, due_date: D(20), remark: '回归测试单', items: [
  { name: '大板', drawing_no: 'HG-A' + RUN, spec: '850*520*30', material: 'A7075', qty: 4, unit_price: 1000, remark: '行备注' },
  { name: '拼块', drawing_no: 'HG-B' + RUN, spec: '300*200*25', material: 'S50C', qty: 2, unit_price: 500 }
] })).d;
ok('建订单(6件)', !!o.id && o.order_no);
let pcs = (await G(`/orders/${o.id}/pieces`)).pieces;
ok('板件生成6件+编号', pcs.length === 6 && pcs[0].piece_code.includes('-01'));
ok('同图号序号(1/4)', pcs[0].group_seq === 1 && pcs[0].group_total === 4);
ok('刃长提示(30厚→35)', pcs[0].blade_tip?.blade === 35);
const det = await G('/orders/' + o.id);
ok('订单金额=5000', det.order.amount === 5000);

const ids = pcs.map(p => p.id);
ok('跳工序被拒(未铣磨直接CNC)', (await J('/progress', { piece_ids: ids, stage: 'cnc' })).s === 400);
ok('开工标记', (await J('/progress/start', { piece_ids: ids, stage: 'milling', note: '6米机' })).s === 200);
ok('铣磨报工', (await J('/progress', { piece_ids: ids, stage: 'milling' })).s === 200);
pcs = (await G(`/orders/${o.id}/pieces`)).pieces;
ok('报工后wip自动清除', !pcs[0].wip_stage);
ok('状态=待CNC', pcs[0].statusTag.label === '待CNC');

// 组合外发 CNC+精磨
ok('外发缺预计回厂被拒', (await J('/outsourcing', { type: 'cnc,grinding', vendor_id: vc.id, piece_ids: ids.slice(0, 4) })).s === 400);
const b1 = (await J('/outsourcing', { type: 'cnc,grinding', vendor_id: vc.id, piece_ids: ids.slice(0, 4), expected_date: D(7), requirements: '盲孔按图' })).d;
ok('组合外发单(draft)', b1.status === 'draft');
ok('draft不能登记回货', (await J(`/outsourcing/${b1.id}/return`, { piece_ids: ids.slice(0, 4) })).s === 400);
ok('确认外发', (await J(`/outsourcing/${b1.id}/confirm`)).s === 200);
ok('在外时撤工序被拒', (await J('/progress/undo', { piece_ids: [ids[0]], stage: 'milling' })).s === 400);
ok('撤件(没拉走的)', (await J(`/outsourcing/${b1.id}/remove`, { piece_ids: [ids[3]] })).s === 200);
ok('回货登记', (await J(`/outsourcing/${b1.id}/return`, { piece_ids: ids.slice(0, 3) })).s === 200);
pcs = (await G(`/orders/${o.id}/pieces`)).pieces;
const p0 = pcs.find(p => p.id === ids[0]);
ok('回货自动标CNC+精磨完成', !!p0.stages.cnc && !!p0.stages.grinding);
ok('外协「外」标记', p0.stages.cnc.ext === true);
ok('撤回货(批量)', (await J(`/outsourcing/${b1.id}/unreturn`, { piece_ids: [ids[2]] })).s === 200);
await J(`/outsourcing/${b1.id}/return`, { piece_ids: [ids[2]] });

// 电镀
const b2 = (await J('/outsourcing', { type: 'plating', vendor_id: vp.id, piece_ids: ids.slice(0, 3), expected_date: D(5) })).d;
await J(`/outsourcing/${b2.id}/confirm`);
ok('电镀外发', !!b2.id);
ok('未回厂不能出货', (await J('/shipments', { order_id: o.id, piece_ids: ids.slice(0, 3) })).s === 400);
await J(`/outsourcing/${b2.id}/return`, { piece_ids: ids.slice(0, 3) });
// 特殊状态
ok('标记返工', (await J('/pieces/flag', { piece_ids: [ids[0]], flag: 'rework', note: '崩角' })).s === 200);
ok('特殊状态禁止出货', (await J('/shipments', { order_id: o.id, piece_ids: [ids[0]] })).s === 400);
ok('解除标记', (await J('/pieces/flag', { piece_ids: [ids[0]], flag: null })).s === 200);
const sh = (await J('/shipments', { order_id: o.id, piece_ids: ids.slice(0, 3), note: '第一批' })).d;
ok('出货成功', !!sh.ship_no);
const shipList = await G('/shipments');
ok('送货单列表可见', shipList.shipments.some(s => s.ship_no === sh.ship_no));

console.log('== 看板/查询 ==');
const dash = await G('/dashboard');
ok('看板正常', dash.active_orders >= 1 && dash.stages);
const search = await G('/pieces/search?q=HG-A' + RUN + '');
ok('板件全局查询', search.pieces.length === 4 && search.pieces[0].customer_po === 'HG-PO-' + RUN);
const filtered = await G(`/orders/${o.id}/pieces?status=` + encodeURIComponent('已出货'));
ok('订单内状态筛选', filtered.pieces.length === 3);

console.log('== 附件（含图号归属）==');
const fd = new FormData();
fd.append('item_id', String(det.items[0].id));
fd.append('files', new Blob(['fake']), 'HG-A图纸' + RUN + '.pdf');
const up = await fetch(BASE + `/api/orders/${o.id}/attachments`, { method: 'POST', headers: { Authorization: 'Bearer ' + login.token }, body: fd });
ok('按图号传图纸', up.status === 200);
const det2 = await G('/orders/' + o.id);
ok('附件挂在图号下', det2.attachments[0]?.item_id === det.items[0].id);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
