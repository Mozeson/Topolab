// Importing your own map (a scan, a photo or a PDF page): two points with known grid
// references place it, and it is draped over the real terrain of the area (real-terrain.js).
// The maths here is pure and tested (tests/map-import.test.js); the files never leave the
// browser. See docs/MAP-IMPORT.md.

// ——— Georeferencing ———
// A similarity (scale, rotation, shift) from image pixels to ITM metres, as complex numbers:
// w = a·z + b with z = x − i·y (image y grows downwards) and w = e + i·n.
export function similarityFromPairs(p1, p2) {
  const z1 = { re: p1.x, im: -p1.y };
  const z2 = { re: p2.x, im: -p2.y };
  const dz = { re: z2.re - z1.re, im: z2.im - z1.im };
  const dw = { re: p2.e - p1.e, im: p2.n - p1.n };
  const den = dz.re * dz.re + dz.im * dz.im;
  if (!(den > 0)) return null;
  // a = dw / dz
  const a = { re: (dw.re * dz.re + dw.im * dz.im) / den, im: (dw.im * dz.re - dw.re * dz.im) / den };
  const b = { re: p1.e - (a.re * z1.re - a.im * z1.im), im: p1.n - (a.re * z1.im + a.im * z1.re) };
  return {
    a, b,
    metersPerPixel: Math.hypot(a.re, a.im),
    rotation: Math.atan2(a.im, a.re) * 180 / Math.PI, // degrees the image is turned from north-up
  };
}

export function imageToItm(t, x, y) {
  return { e: t.a.re * x + t.a.im * y + t.b.re, n: t.a.im * x - t.a.re * y + t.b.im };
}

export function itmToImage(t, e, n) {
  // z = (w − b) / a, then x = Re z, y = −Im z
  const w = { re: e - t.b.re, im: n - t.b.im };
  const den = t.a.re * t.a.re + t.a.im * t.a.im;
  const z = { re: (w.re * t.a.re + w.im * t.a.im) / den, im: (w.im * t.a.re - w.re * t.a.im) / den };
  return { x: z.re, y: -z.im };
}

// Checks before trusting two points. Returns a list of problems (Hebrew), empty when fine.
export function checkPairs(p1, p2) {
  const problems = [];
  const px = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const m = Math.hypot(p2.e - p1.e, p2.n - p1.n);
  if (px < 60) problems.push('הנקודות קרובות מדי בתמונה. בחרו שתי נקודות רחוקות זו מזו (למשל בפינות מנוגדות).');
  if (m < 100) problems.push('הנ״צ של שתי הנקודות כמעט זהים. בדקו את המספרים.');
  const t = similarityFromPairs(p1, p2);
  if (t && px >= 60 && m >= 100) {
    if (t.metersPerPixel < .05 || t.metersPerPixel > 200) problems.push(`קנה המידה שיוצא (${t.metersPerPixel.toFixed(2)} מ׳ לפיקסל) לא סביר. ייתכן שהחלפתם מזרח וצפון.`);
    if (Math.abs(t.rotation) > 20) problems.push(`המפה יוצאת מסובבת ב־${Math.round(t.rotation)}°. אם היא סרוקה ישר, כנראה שהחלפתם בין הנקודות או בין מזרח לצפון.`);
  }
  return problems;
}

// The canvas transform that paints the image into a size×size square covering the map
// (south-west corner `origin`, side `extent` metres; canvas row 0 is the north edge).
// For ctx.setTransform(a, b, c, d, e, f): x' = a·x + c·y + e, y' = b·x + d·y + f.
export function drapeTransform(t, origin, extent, size) {
  const k = size / extent;
  return [k * t.a.re, -k * t.a.im, k * t.a.im, k * t.a.re, k * (t.b.re - origin.e), k * (origin.n + extent - t.b.im)];
}

// How much of the square the image covers (0..1), sampled on a grid.
export function coverage(t, origin, extent, width, height, steps = 20) {
  let inside = 0;
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < steps; j++) {
      const p = itmToImage(t, origin.e + (i + .5) / steps * extent, origin.n + (j + .5) / steps * extent);
      if (p.x >= 0 && p.y >= 0 && p.x <= width && p.y <= height) inside++;
    }
  }
  return inside / (steps * steps);
}

// The map's south-west corner for a centre, as real-terrain.js will choose it (round km).
export const squareOrigin = (centerE, centerN, extent) => ({
  e: Math.round((centerE - extent / 2) / 1000) * 1000,
  n: Math.round((centerN - extent / 2) / 1000) * 1000,
});

// Texture size for the drape: finer for small maps, never past 4096 (phones' limit).
export const drapeSize = (sizeKm) => (sizeKm <= 1 ? 2048 : 4096);

// ——— Files (browser) ———
const MAX_PIXELS = 16e6; // a PDF page is rendered up to about 4000×4000

export async function loadImageFile(file) {
  const bitmap = await createImageBitmap(file);
  if (bitmap.width * bitmap.height <= MAX_PIXELS * 2) return bitmap;
  // Very large scans are scaled down to keep memory sane.
  const k = Math.sqrt(MAX_PIXELS / (bitmap.width * bitmap.height));
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * k), Math.round(bitmap.height * k));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return createImageBitmap(canvas);
}

let pdfjs = null;
async function pdfLib() {
  if (!pdfjs) {
    pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
  }
  return pdfjs;
}

export async function openPdf(file) {
  const lib = await pdfLib();
  return lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
}

// One page as an image, as sharp as the pixel budget allows.
export async function renderPdfPage(doc, number) {
  const page = await doc.getPage(number);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(8, Math.sqrt(MAX_PIXELS / (base.width * base.height)));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport, canvas }).promise;
  return createImageBitmap(canvas);
}

// Paint the image into the map's square.
export function buildDrape(image, t, origin, extent, size) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(...drapeTransform(t, origin, extent, size));
  ctx.drawImage(image, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return canvas;
}

// ——— Keeping the drape (IndexedDB: too big for localStorage) ———
const DB = 'topolab-maps';
const STORE = 'drape';

function db() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveDrape(record) {
  try {
    const d = await db();
    await new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record, 'current');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) { console.warn('Could not keep the imported map', error); }
}

export async function loadDrape() {
  try {
    const d = await db();
    return await new Promise((resolve) => {
      const request = d.transaction(STORE).objectStore(STORE).get('current');
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
    });
  } catch { return null; }
}

export async function clearDrape() {
  try {
    const d = await db();
    d.transaction(STORE, 'readwrite').objectStore(STORE).delete('current');
  } catch { /* nothing kept */ }
}
