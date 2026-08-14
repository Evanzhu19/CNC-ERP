// 双证核对：拆分兼容 / 防重复 / 串单检测
import fs from 'node:fs';
const BASE = 'http://localhost:' + (process.argv[2] || '3000');
const dir = 'C:/Users/52981/Desktop/APP/ERP/';
const XLS = dir + '客户交期明细表2026年.xlsx';
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${typeof e === 'string' ? e : JSON.stringify(e)}`); } };
const hasFiles = fs.existsSync(XLS) && fs.existsSync(dir + '瑞宏rh-PO260730014.pdf');
if (!hasFiles) { console.log('  (缺真实PDF/Excel样本，跳过；把样本放回 ERP 根目录可跑)'); process.exit(0); }

const login = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) }).then(r => r.json());
const auth = { Authorization: 'Bearer ' + login.token };
const send = async (pdfName, ep) => {
  const fd = new FormData();
  fd.append('pdf', new Blob([fs.readFileSync(dir + pdfName)]), pdfName);
  fd.append('excel', new Blob([fs.readFileSync(XLS)]), 'ledger.xlsx');
  const r = await fetch(BASE + '/api/orders/' + ep, { method: 'POST', headers: auth, body: fd });
  return { s: r.status, d: await r.json() };
};
const G = u => fetch(BASE + '/api' + u, { headers: auth }).then(r => r.json());

console.log('== 1. 完全一致的单：直接可录 ==');
let r = await send('瑞宏rh-PO260730014.pdf', 'reconcile');
ok('730014 身份对上', r.d.identity_ok);
ok('730014 完全一致(可直接录)', r.d.all_ok && !r.d.line_diff, JSON.stringify({ all_ok: r.d.all_ok, diff: r.d.line_diff }));
r = await send('瑞宏rh-PO260730014.pdf', 'reconcile-import');
ok('730014 录入成功', r.s === 200 && r.d.ok, JSON.stringify(r.d).slice(0, 80));

console.log('== 2. 防重复录入：同一张PO再录被硬拦 ==');
r = await send('瑞宏rh-PO260730014.pdf', 'reconcile');
ok('再核对时标记 duplicate', !!r.d.duplicate, JSON.stringify({ dup: r.d.duplicate }));
r = await send('瑞宏rh-PO260730014.pdf', 'reconcile-import');
ok('重复录入被后端硬拦(400)', r.s === 400 && /已经录过/.test(r.d.error), JSON.stringify(r.d));

console.log('== 3. 机架拆分：件数/图号有差异但身份对，可确认录入 ==');
r = await send('瑞宏rh-PO260806001.pdf', 'reconcile');
ok('806001 身份对、有差异(拆分)', r.d.identity_ok && r.d.line_diff && !r.d.duplicate);
// 客户PDF上有、台账这张单里没有的行必须列出来，而且要显示我们认得的图号
//（客户单把图号放在"规格"列、"物料编号"列放的是他们自编号，早期这里显示成客户编号没法追）
const miss = r.d.pdf_not_in_ledger || [];
ok('806001 列出"客户PDF有、台账没有"的行', miss.length > 0, `实际${miss.length}`);
ok('806001 这些行显示的是我们的图号(不是客户自编号)', miss.every(x => x.drawing_no && /^[A-Za-z]/.test(x.drawing_no)),
  JSON.stringify(miss.map(x => x.drawing_no)));
// 台账里其实有、但挂在别的PO下 = 串单，必须点名是哪张单
ok('806001 指出这些图号在台账里挂到了别的PO下', miss.some(x => (x.elsewhere || []).length > 0),
  JSON.stringify(miss.map(x => x.drawing_no + '→' + (x.elsewhere || []).map(e => e.customer_po).join(','))));
r = await send('瑞宏rh-PO260806001.pdf', 'reconcile-import');
ok('806001 拆分单确认后能录入(件数不拦)', r.s === 200 && r.d.ok, JSON.stringify(r.d).slice(0, 80));

console.log('== 4. 差异明细：台账有、PDF没有 的行会列出（人工判断拆分/串单）==');
r = await send('瑞宏rh-PO260806002.pdf', 'reconcile');
const missingInPdf = r.d.line_checks.filter(c => c.pdf_qty === 0);
ok('806002 列出"台账有PDF没有"的图号(3个错板)', missingInPdf.length >= 3, `实际${missingInPdf.length}`);
ok('806002 不误报(标准五金件等不会被当串单红字)', r.d.line_checks.every(c => !('mislog' in c)));

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
