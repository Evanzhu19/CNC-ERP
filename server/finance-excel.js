import * as XLSX from 'xlsx';

// 财务台账 Excel 导入：表头关键词识别（适配现成账本，列名对不上可在前端预览里手动改）
const FIN_FIELDS = {
  customer: ['客户', '单位', '供应商', '公司', '客户名称', '单位名称', '供应商名称', '往来单位'],
  biz: ['业务', '业务类型', '类型', '类别', '款项类型'],
  title: ['事由', '摘要', '内容', '说明', '品名', '款项', '项目', '货物'],
  amount: ['金额', '应收金额', '应付金额', '应收', '应付', '合计', '总额', '价款', '货款'],
  received: ['已收', '已付', '回款', '已收金额', '已付金额', '实收', '实付', '收款', '付款'],
  entry_date: ['日期', '记账日期', '开单日期', '时间', '账期'],
  due_date: ['约定', '到期', '约定收款', '约定付款', '收款日', '付款日', '到期日', '账期日'],
  note: ['备注', '注', '说明备注']
};

export const FIN_FIELD_NAMES = {
  customer: '客户/单位', biz: '业务类型', title: '事由', amount: '金额',
  received: '已收/已付', entry_date: '记账日期', due_date: '约定日期', note: '备注'
};

function guessFinField(text) {
  const t = String(text || '').replace(/\s/g, '');
  if (!t) return null;
  let best = null, bestLen = 0;
  for (const [field, keys] of Object.entries(FIN_FIELDS)) {
    for (const k of keys) {
      if (t.includes(k) && k.length > bestLen) { best = field; bestLen = k.length; }
    }
  }
  return best;
}

function excelSerialToDate(n) {
  const d = new Date(Math.round((n - 25569) * 86400 * 1000));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function coerceDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v)) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  if (typeof v === 'number' && v > 20000 && v < 60000) return excelSerialToDate(v);
  const s = String(v).trim();
  const num = Number(s);
  if (!isNaN(num) && num > 20000 && num < 60000) return excelSerialToDate(num);
  let m = s.match(/(\d{4})[/\-年.](\d{1,2})[/\-月.](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[/\-](\d{1,2})$/);
  if (m) return `${new Date().getFullYear()}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

function coerceMoney(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const m = String(v).replace(/[¥￥$,，\s]/g, '').match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

const cellText = v => {
  if (v == null) return '';
  if (v instanceof Date) return coerceDate(v) || '';
  return String(v).trim();
};

export function parseFinanceExcel(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheets = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
    // 找表头：命中≥2个字段且含 customer 或 amount
    let headerIdx = -1, map = {};
    for (let i = 0; i < Math.min(rows.length, 15); i++) {
      const m = {};
      let hits = 0;
      for (let c = 0; c < (rows[i] || []).length; c++) {
        const f = guessFinField(cellText(rows[i][c]));
        if (f && !(f in m)) { m[f] = c; hits++; }
      }
      if (hits >= 2 && ('amount' in m) && ('customer' in m || 'title' in m)) { headerIdx = i; map = m; break; }
    }
    if (headerIdx < 0) { sheets.push({ name, error: '没有识别到表头（需要含 客户/单位 和 金额 之类的列名）', headers: [], lines: [] }); continue; }

    const headers = (rows[headerIdx] || []).map(cellText);
    const lines = [];
    const skipped = [];
    let lastCustomer = '';
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i] || [];
      const get = f => (f in map ? row[map[f]] : null);
      const rowText = row.map(cellText).join('');
      if (!rowText) continue;
      if (/合计|总计|小计/.test(rowText) && !cellText(get('customer'))) continue;

      const customer = cellText(get('customer')) || lastCustomer; // 合并单元格式留空 → 沿用上一行
      if (cellText(get('customer'))) lastCustomer = cellText(get('customer'));
      const amount = coerceMoney(get('amount'));
      if (!customer && amount == null) continue;
      if (!customer) { skipped.push({ row: i + 1, reason: '缺客户/单位' }); continue; }
      if (amount == null || amount <= 0) { skipped.push({ row: i + 1, reason: '缺金额或金额无效' }); continue; }

      lines.push({
        customer,
        biz: cellText(get('biz')) || null,
        title: cellText(get('title')) || null,
        amount: Math.round(amount * 100) / 100,
        received: Math.max(0, Math.round((coerceMoney(get('received')) || 0) * 100) / 100),
        entry_date: coerceDate(get('entry_date')),
        due_date: coerceDate(get('due_date')),
        note: cellText(get('note')) || null
      });
    }
    sheets.push({ name, headers, map, lines, skipped });
  }
  return { sheets };
}
