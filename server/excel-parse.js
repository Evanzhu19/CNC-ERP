import * as XLSX from 'xlsx';
import { guessField } from './pdf-parse.js';

function excelSerialToDate(n) {
  const ms = Math.round((n - 25569) * 86400 * 1000);
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function parseDueDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v)) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  if (typeof v === 'number') {
    if (v > 20000 && v < 60000) return excelSerialToDate(v);
    return null;
  }
  const s = String(v).trim();
  const num = Number(s);
  if (!isNaN(num) && num > 20000 && num < 60000) return excelSerialToDate(num);
  let m = s.match(/(\d{4})[/\-年.](\d{1,2})[/\-月.](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/(\d{1,2})[/\-](\d{1,2})[/\-](\d{2})(?!\d)/);
  if (m) return `20${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

function cellText(v) {
  if (v == null) return '';
  if (v instanceof Date) return parseDueDate(v) || '';
  return String(v).trim();
}

function parseQty(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 ? v : null;
  const m = String(v).replace(/,/g, '').match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

function parsePrice(v) {
  if (typeof v === 'number') return v >= 0 ? v : null;
  const m = String(v).replace(/[¥￥$,\s]/g, '').match(/\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const row = rows[i];
    const map = {};
    let hits = 0;
    for (let c = 0; c < row.length; c++) {
      const text = cellText(row[c]);
      if (!text || text.length > 14) continue;
      const f = guessField(text);
      if (f) {
        hits++;
        if (!(f in map)) map[f] = c;
      }
    }
    if (hits >= 4 && ('qty' in map) && ('_customer' in map || 'drawing_no' in map)) {
      if (!('_customer' in map)) {
        const used = new Set(Object.values(map));
        const left = '_index' in map ? map._index : -1;
        const right = '_po' in map ? map._po : ('name' in map ? map.name : row.length);
        for (let c = left + 1; c < right; c++) {
          if (!used.has(c)) { map._customer = c; break; }
        }
      }
      return { index: i, map };
    }
  }
  return null;
}

export function parseOrdersExcel(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheets = [];

  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
    const header = findHeader(rows);
    if (!header) {
      sheets.push({ name, error: '没有识别到表头行', orders: [] });
      continue;
    }
    const col = header.map;
    const groups = new Map();
    let currentCustomer = '';
    let currentPo = '';

    for (let i = header.index + 1; i < rows.length; i++) {
      const row = rows[i] || [];
      const get = f => (f in col ? cellText(row[col[f]]) : '');
      const getRaw = f => (f in col ? row[col[f]] : null);

      const rowText = row.map(cellText).join('');
      if (!rowText) continue;
      if (/合计|总计|大写/.test(rowText) && !get('drawing_no')) continue;

      const cust = get('_customer');
      if (cust) currentCustomer = cust.replace(/\s+/g, '');
      const po = get('_po');
      if (po) currentPo = po;

      const qty = parseQty(getRaw('qty'));
      if (!qty || qty <= 0 || qty > 2000) continue;
      if (!get('drawing_no') && !get('name') && !get('part_no')) continue;
      if (!currentCustomer) continue;

      const remarkParts = [get('_surface'), get('_outsource'), get('remark')].filter(Boolean);
      const line = {
        part_no: get('part_no') || null,
        drawing_no: get('drawing_no') || null,
        name: get('name') || null,
        spec: get('spec') || null,
        material: get('material') || null,
        qty,
        unit_price: 'unit_price' in col ? parsePrice(getRaw('unit_price')) : null,
        remark: remarkParts.length ? [...new Set(remarkParts)].join('；') : null,
        due: '_due' in col ? parseDueDate(getRaw('_due')) : null
      };

      const key = `${currentCustomer}||${currentPo}`;
      if (!groups.has(key)) {
        groups.set(key, { customer_name: currentCustomer, customer_po: currentPo || null, lines: [] });
      }
      groups.get(key).lines.push(line);
    }

    const orders = [...groups.values()].map(g => {
      const dues = g.lines.map(l => l.due).filter(Boolean).sort();
      return {
        customer_name: g.customer_name,
        customer_po: g.customer_po,
        due_date: dues[0] || null,
        lines: g.lines.map(({ due, ...rest }) => rest),
        total_qty: g.lines.reduce((s, l) => s + l.qty, 0)
      };
    });
    sheets.push({ name, orders });
  }
  return { sheets };
}
