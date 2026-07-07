import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas, DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas';
import { createWorker } from 'tesseract.js';
import { PDF_OPEN_OPTS } from './pdf-parse.js';

if (!globalThis.DOMMatrix) globalThis.DOMMatrix = DOMMatrix;
if (!globalThis.ImageData) globalThis.ImageData = ImageData;
if (!globalThis.Path2D) globalThis.Path2D = Path2D;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TESSDATA = path.join(__dirname, 'tessdata');

let workerPromise = null;
function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker(['chi_sim', 'eng'], 1, {
      langPath: TESSDATA,
      gzip: false,
      cacheMethod: 'none'
    }).catch(e => {
      workerPromise = null;
      throw e;
    });
  }
  return workerPromise;
}

async function renderPage(page, scale) {
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas.toBuffer('image/png');
}

function collectWords(data) {
  if (Array.isArray(data.words) && data.words.length) return data.words;
  const words = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        for (const w of line.words || []) words.push(w);
      }
    }
  }
  return words;
}

export async function ocrPdfToItems(buffer, { scale = 3, minConfidence = 30 } = {}) {
  const task = getDocument({ data: new Uint8Array(buffer), ...PDF_OPEN_OPTS });
  const doc = await task.promise;
  const worker = await getWorker();
  const pages = [];
  try {
    for (let p = 1; p <= Math.min(doc.numPages, 10); p++) {
      const page = await doc.getPage(p);
      const pageHeight = page.getViewport({ scale: 1 }).viewBox[3];
      const png = await renderPage(page, scale);
      const { data } = await worker.recognize(png, {}, { blocks: true });
      const items = [];
      for (const w of collectWords(data)) {
        const text = (w.text || '').trim();
        if (!text || (w.confidence || 0) < minConfidence) continue;
        const b = w.bbox;
        items.push({
          text,
          x: b.x0 / scale,
          y: pageHeight - ((b.y0 + b.y1) / 2) / scale,
          w: (b.x1 - b.x0) / scale
        });
      }
      pages.push(items);
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return pages;
}
