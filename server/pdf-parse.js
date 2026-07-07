import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const require2 = createRequire(import.meta.url);
const PDFJS_DIR = path.dirname(require2.resolve('pdfjs-dist/package.json'));
export const PDF_OPEN_OPTS = {
  useSystemFonts: true,
  isEvalSupported: false,
  cMapUrl: path.join(PDFJS_DIR, 'cmaps').replace(/\\/g, '/') + '/',
  cMapPacked: true,
  standardFontDataUrl: path.join(PDFJS_DIR, 'standard_fonts').replace(/\\/g, '/') + '/'
};

export const FIELD_KEYWORDS = {
  part_no: ['编号', '零件编号', '料号', '物料编号', '物料号', '品号', '编码', '物料编码', 'PART NO', 'P/N', 'PN', 'ITEM NO'],
  drawing_no: ['图号', '图纸号', '图面号', '图番', '品番', 'DWG', 'DRAWING'],
  name: ['品名', '名称', '零件名称', '产品名称', '物料名称', '货品名称', '材料名称', 'DESCRIPTION', 'NAME'],
  spec: ['规格', '尺寸', '规格型号', '规格尺寸', '型号规格', '外形尺寸', 'SIZE', 'SPEC'],
  material: ['材质', '材料', '材质要求', 'MATERIAL', 'MAT'],
  qty: ['数量', '订购数量', '采购数量', '订单数量', 'QTY', 'PCS', '件数', '数 量'],
  unit_price: ['单价', '未税单价', '含税单价', '单 价', 'UNIT PRICE', 'PRICE'],
  amount: ['金额', '总价', '小计', '合计金额', '总金额', 'AMOUNT', 'TOTAL'],
  remark: ['备注', '交期备注', '说明', 'REMARK', 'REMARKS', 'NOTE'],
  _index: ['序号', '序 号', '项次', '项目', 'NO', 'NO.', '#'],
  _due: ['交货日期', '交货期', '交期', '纳期', '要求交期', '到货日期', '客户交期', 'DELIVERY DATE', 'DELIVERY'],
  _customer: ['客户', '客户名称', '客户名'],
  _po: ['客户单号', '客项订单号', '客户订单号', '客户PO', 'PO号', '订单号', '采购单号'],
  _surface: ['表面处理'],
  _outsource: ['有无外发'],
  _ignore: [
    '客户项目编号', '客项内部编码', '内部下料单号', '内部下料订单号', '内部下料订单编号',
    '优先级别', '单位', '材料来源', '送货地址', '加工状态', '出货备注', '未出货', '已出货',
    '有无出货', '铣磨进度', '电镀进度', '电脑锣进度', '有无拿材料', '外发有无拿料',
    '订单金额', '总金额'
  ]
};

const ITEM_FIELDS = ['part_no', 'drawing_no', 'name', 'spec', 'material', 'qty', 'unit_price', 'remark'];

export function guessField(header) {
  const h = String(header).replace(/\s/g, '').toUpperCase();
  if (!h) return null;
  let best = null;
  let bestLen = 0;
  for (const [field, keys] of Object.entries(FIELD_KEYWORDS)) {
    for (const k of keys) {
      const kk = k.replace(/\s/g, '').toUpperCase();
      if ((h === kk || h.includes(kk)) && kk.length > bestLen) {
        best = field;
        bestLen = kk.length;
      }
    }
  }
  return best;
}

async function extractTextItems(buffer) {
  const loadingTask = getDocument({ data: new Uint8Array(buffer), ...PDF_OPEN_OPTS });
  const doc = await loadingTask.promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const items = content.items
      .filter(it => it.str && it.str.trim() !== '')
      .map(it => ({
        text: it.str,
        x: it.transform[4],
        y: it.transform[5],
        w: it.width || 0
      }));
    pages.push(items);
    page.cleanup();
  }
  await loadingTask.destroy();
  return pages;
}

function groupRows(items, yTol = 3) {
  const rows = [];
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  for (const it of sorted) {
    const row = rows.find(r => Math.abs(r.y - it.y) <= yTol);
    if (row) {
      row.items.push(it);
      row.y = (row.y * (row.items.length - 1) + it.y) / row.items.length;
    } else {
      rows.push({ y: it.y, items: [it] });
    }
  }
  for (const r of rows) r.items.sort((a, b) => a.x - b.x);
  return rows;
}

function mergeCells(rowItems, gapTol = 6) {
  const cells = [];
  for (const it of rowItems) {
    const last = cells[cells.length - 1];
    if (last && it.x - (last.x + last.w) < gapTol) {
      last.text += it.text;
      last.w = it.x + it.w - last.x;
    } else {
      cells.push({ text: it.text, x: it.x, w: it.w });
    }
  }
  return cells.map(c => ({ ...c, text: c.text.trim() }));
}

function isNumeric(s) {
  return /^[¥￥$]?\s*[\d,]+(\.\d+)?$/.test(String(s).trim());
}

function findHeaderRow(rows) {
  let best = null;
  let bestScore = 0;
  for (let i = 0; i < rows.length; i++) {
    const cells = mergeCells(rows[i].items);
    if (cells.length < 3) continue;
    let score = 0;
    for (const c of cells) {
      const f = guessField(c.text);
      if (f && c.text.length <= 12) score++;
    }
    if (score >= 3 && score > bestScore) {
      best = { index: i, cells };
      bestScore = score;
    }
  }
  return best;
}

function extractMeta(rows) {
  const all = rows.map(r => mergeCells(r.items).map(c => c.text).join(' ')).join('\n');
  const meta = {};
  const po = all.match(/(?:采购(?:订)?单号|订单编号|订单号|PO\s*(?:NO|号|#)?)\s*[:：.]?\s*([A-Za-z0-9][A-Za-z0-9\-_\/]{2,30})/i);
  if (po) meta.customer_po = po[1];
  const due = all.match(/(?:交货?(?:货)?(?:日)?期|交期|纳期|要求到货日期?|DELIVERY\s*DATE)\s*[:：.]?\s*(\d{4}[-\/年.]\s?\d{1,2}[-\/月.]\s?\d{1,2}日?)/i);
  if (due) {
    const m = due[1].match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
    if (m) meta.due_date = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  }
  const od = all.match(/(?:下单日期?|订单日期?|开单日期?|日期|DATE)\s*[:：.]?\s*(\d{4}[-\/年.]\s?\d{1,2}[-\/月.]\s?\d{1,2}日?)/i);
  if (od) {
    const m = od[1].match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
    if (m) meta.order_date = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  }
  return meta;
}

const STOP_WORDS = ['合计', '总计', '总 计', '合 计', '备注', '税额', '价税合计', 'TOTAL', '大写', '审核', '制单', '批准'];

function isStopRow(cells) {
  const joined = cells.map(c => c.text).join('').replace(/\s/g, '');
  if (STOP_WORDS.some(w => joined.startsWith(w.replace(/\s/g, '')))) return true;
  if (/(人民币|含税|未税|价税|RMB)[^，。]{0,8}(合计|总计)/.test(joined)) return true;
  if (/(合计|总计)[（(:：]/.test(joined)) return true;
  if (/[（(]?大写[）)]?[:：]/.test(joined)) return true;
  if (/[零壹贰叁肆伍陆柒捌玖拾佰仟万亿]{4,}[元圆角分整]/.test(joined)) return true;
  return false;
}

function assignToColumns(cells, columns) {
  const result = new Array(columns.length).fill('');
  for (const cell of cells) {
    const center = cell.x + cell.w / 2;
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < columns.length; i++) {
      const colCenter = columns[i].x + columns[i].w / 2;
      const d = Math.abs(center - colCenter);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    result[bestIdx] = result[bestIdx] ? `${result[bestIdx]} ${cell.text}` : cell.text;
  }
  return result;
}

export async function parsePurchaseOrderPdf(buffer) {
  let pages = await extractTextItems(buffer);
  let usedOcr = false;
  const totalItems = pages.reduce((s, p) => s + p.length, 0);
  if (totalItems < 15) {
    try {
      const { ocrPdfToItems } = await import('./pdf-ocr.js');
      pages = await ocrPdfToItems(buffer);
      usedOcr = true;
    } catch (e) {
      console.error('OCR识别失败:', e);
      return { error: 'no_text', message: 'PDF没有文字层，转OCR识别也失败了：' + (e.message || '未知错误') };
    }
  }
  if (pages.every(p => p.length === 0)) {
    return { error: 'no_text', message: '这个PDF既没有文字层，OCR也没认出内容，可能是空白页或图像太模糊。' };
  }

  let columns = null;
  let headerTexts = null;
  const dataRows = [];
  const allRows = [];

  for (const items of pages) {
    const rows = groupRows(items);
    allRows.push(...rows);
    let startIdx = 0;
    if (!columns) {
      const header = findHeaderRow(rows);
      if (!header) continue;
      headerTexts = header.cells.map(c => c.text);
      columns = header.cells.map(c => ({ x: c.x, w: Math.max(c.w, 10) }));
      startIdx = header.index + 1;
    }
    for (let i = startIdx; i < rows.length; i++) {
      const cells = mergeCells(rows[i].items);
      if (cells.length < 2) continue;
      if (isStopRow(cells)) break;
      const assigned = assignToColumns(cells, columns);
      if (assigned.filter(v => v !== '').length < 2) continue;
      dataRows.push(assigned);
    }
  }

  const meta = extractMeta(allRows);

  if (!columns) {
    return { error: 'no_table', message: '没有找到明细表格的表头行（需要含有 编号/图号/数量 之类的表头）。', meta };
  }

  const rawGuesses = headerTexts.map(h => guessField(h));
  const guesses = rawGuesses.map(g => (ITEM_FIELDS.includes(g) ? g : null));

  if (!meta.due_date) {
    const dueCol = rawGuesses.indexOf('_due');
    if (dueCol >= 0) {
      const dates = dataRows
        .map(r => String(r[dueCol] || '').match(/(\d{4})\D(\d{1,2})\D(\d{1,2})/))
        .filter(Boolean)
        .map(m => `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`)
        .sort();
      if (dates.length) meta.due_date = dates[0];
    }
  }

  const looksLikeData = row => row.some(v => isNumeric(v));
  const cleanRows = dataRows.filter(looksLikeData);

  return {
    headers: headerTexts,
    guesses,
    rows: cleanRows,
    meta,
    ocr: usedOcr
  };
}
