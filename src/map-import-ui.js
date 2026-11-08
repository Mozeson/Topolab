// The "ייבוא מפה" dialog: choose an image or a PDF page, mark two points of known grid
// reference on it, pick the area (centre and size), and load the real terrain with the map
// draped over it. The maths is in map-import.js; scene.js shows the result.

import {
  loadImageFile, openPdf, renderPdfPage, similarityFromPairs, imageToItm, itmToImage, checkPairs,
  coverage, squareOrigin,
} from './map-import.js';
import { isItm } from './itm.js';

const $ = (id) => document.getElementById(id);
const LABELS = ['א', 'ב'];

export function createMapImport(api) {
  // api: { load({ image, transform, centerE, centerN, sizeKm, name }), drapeActive(), view(), setView(patch), remove() }
  const dialog = $('importDialog');
  const canvas = $('importCanvas');
  const ctx = canvas.getContext('2d');
  let image = null;
  let name = '';
  let pdf = null;
  let points = [null, null];      // { x, y } image pixels
  let mode = 0;                   // 0 / 1: the point a click places; 'center': the area's centre
  let center = null;              // { x, y } image pixels
  let transform = null;
  let view = { s: 1, ox: 0, oy: 0 };
  let drag = null;
  const pointers = new Map();

  function showError(text) {
    $('importError').textContent = text || '';
    $('importError').hidden = !text;
  }

  function show(section) {
    for (const id of ['importPick', 'importWork', 'importView']) $(id).hidden = id !== section;
    dialog.classList.toggle('working', section === 'importWork');
    if (section === 'importWork') requestAnimationFrame(() => { fit(); draw(); });
  }

  // ——— Choosing the file ———
  $('importFile').addEventListener('change', async () => {
    const file = $('importFile').files[0];
    if (!file) return;
    showError('');
    name = file.name;
    $('importPageRow').hidden = true;
    try {
      if (/pdf$/i.test(file.type) || /\.pdf$/i.test(file.name)) {
        $('importBusy').hidden = false;
        pdf = await openPdf(file);
        if (pdf.numPages > 1) {
          $('importPage').innerHTML = Array.from({ length: pdf.numPages }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('');
          $('importPageRow').hidden = false;
        }
        await usePage(1);
      } else {
        pdf = null;
        setImage(await loadImageFile(file));
      }
    } catch (error) {
      console.warn('Map import failed', error);
      showError('לא הצלחנו לפתוח את הקובץ. נסו תמונה (JPG / PNG) או PDF אחר.');
    } finally {
      $('importBusy').hidden = true;
    }
  });
  $('importPage').addEventListener('change', () => usePage(Number($('importPage').value)));

  async function usePage(number) {
    $('importBusy').hidden = false;
    try { setImage(await renderPdfPage(pdf, number)); } finally { $('importBusy').hidden = true; }
  }

  function setImage(bitmap) {
    image = bitmap;
    canvas.dataset.iw = String(bitmap.width); // the image's size, for tests
    canvas.dataset.ih = String(bitmap.height);
    points = [null, null];
    center = null;
    mode = 0;
    for (const i of [0, 1]) { $(`importE${i}`).value = ''; $(`importN${i}`).value = ''; }
    show('importWork');
    update();
  }

  // ——— Points and area ———
  function readPair(i) {
    const p = points[i];
    const e = Number($(`importE${i}`).value);
    const n = Number($(`importN${i}`).value);
    if (!p || !(e > 0) || !(n > 0)) return null;
    return { ...p, e, n };
  }

  function update() {
    const pairs = [readPair(0), readPair(1)];
    transform = null;
    let problems = [];
    if (pairs[0] && pairs[1]) {
      if (!isItm(pairs[0].e, pairs[0].n) || !isItm(pairs[1].e, pairs[1].n)) problems = ['הנ״צ מחוץ לרשת ישראל: מזרח 100000–300000, צפון 350000–820000 (במטרים, 6 ספרות).'];
      else problems = checkPairs(pairs[0], pairs[1]);
      if (!problems.length) transform = similarityFromPairs(pairs[0], pairs[1]);
    }
    for (const i of [0, 1]) $(`importPoint${i}`).classList.toggle('active', mode === i);
    $('importPoint0').classList.toggle('done', Boolean(pairs[0]));
    $('importPoint1').classList.toggle('done', Boolean(pairs[1]));
    const step = !points[0] ? 'לחצו על התמונה בנקודה שהנ״צ שלה ידוע לכם (למשל הצטלבות של קווי רשת), והקלידו את הנ״צ שלה.'
      : !pairs[0] ? 'הקלידו את הנ״צ של נקודה א׳ (מזרח וצפון, במטרים).'
        : !points[1] ? 'עכשיו נקודה ב׳: רחוקה מהראשונה, רצוי בפינה המנוגדת.'
          : !pairs[1] ? 'הקלידו את הנ״צ של נקודה ב׳.'
            : problems.length ? problems[0]
              : 'מעולה! עכשיו לחצו על התמונה במרכז השטח שתרצו, ובחרו גודל.';
    $('importStep').textContent = step;
    $('importStep').classList.toggle('warn', problems.length > 0);
    $('importArea').hidden = !transform;
    if (transform) {
      $('importScale').textContent = `קנה מידה: ${transform.metersPerPixel.toFixed(2)} מ׳ לפיקסל · סיבוב ${transform.rotation.toFixed(1)}°`;
      if (!center) center = { x: image.width / 2, y: image.height / 2 };
      if (mode !== 'center') mode = 'center';
      const c = imageToItm(transform, center.x, center.y);
      const extent = Number($('importSize').value) * 1000;
      const origin = squareOrigin(c.e, c.n, extent);
      const cover = coverage(transform, origin, extent, image.width, image.height);
      $('importCoverage').textContent = `מרכז ${Math.round(c.n / 100) * 100}/${Math.round(c.e / 100) * 100} · המפה מכסה ${Math.round(cover * 100)}% מהשטח${cover < .98 ? ' (מה שמחוץ לה יהיה לבן)' : ''}`;
      $('importLoadBtn').disabled = cover < .2 || !isItm(c.e, c.n);
    } else {
      $('importScale').textContent = '';
      $('importLoadBtn').disabled = true;
    }
    draw();
  }

  for (const i of [0, 1]) {
    $(`importPoint${i}`).addEventListener('click', () => { mode = i; update(); });
    for (const id of [`importE${i}`, `importN${i}`]) $(id).addEventListener('input', update);
  }
  $('importSize').addEventListener('change', update);

  $('importLoadBtn').addEventListener('click', async () => {
    if (!transform || !center) return;
    const c = imageToItm(transform, center.x, center.y);
    $('importLoadBtn').disabled = true;
    const ok = await api.load({ image, transform, centerE: c.e, centerN: c.n, sizeKm: Number($('importSize').value), name });
    $('importLoadBtn').disabled = false;
    if (ok) dialog.close();
  });

  // ——— The image viewer: pan (drag), zoom (wheel, pinch, buttons), click to place ———
  function fit() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    if (!image) return;
    const s = Math.min(canvas.width / image.width, canvas.height / image.height) * .96;
    view = { s, ox: (canvas.width - image.width * s) / 2, oy: (canvas.height - image.height * s) / 2 };
  }

  const toImage = (cx, cy) => ({ x: (cx - view.ox) / view.s, y: (cy - view.oy) / view.s });
  const toCanvas = (x, y) => ({ x: x * view.s + view.ox, y: y * view.s + view.oy });

  function zoom(factor, cx = canvas.width / 2, cy = canvas.height / 2) {
    const p = toImage(cx, cy);
    view.s = Math.max(.02, Math.min(20, view.s * factor));
    view.ox = cx - p.x * view.s;
    view.oy = cy - p.y * view.s;
    draw();
  }
  $('importZoomIn').addEventListener('click', () => zoom(1.5));
  $('importZoomOut').addEventListener('click', () => zoom(1 / 1.5));
  $('importFit').addEventListener('click', () => { fit(); draw(); });
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const dpr = canvas.width / rect.width;
    zoom(Math.exp(-event.deltaY * .0015), (event.clientX - rect.left) * dpr, (event.clientY - rect.top) * dpr);
  }, { passive: false });

  const local = (event) => {
    const rect = canvas.getBoundingClientRect();
    const dpr = canvas.width / rect.width;
    return { x: (event.clientX - rect.left) * dpr, y: (event.clientY - rect.top) * dpr };
  };
  canvas.addEventListener('pointerdown', (event) => {
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, local(event));
    drag = pointers.size === 1 ? { start: local(event), ox: view.ox, oy: view.oy, moved: false } : { pinch: pinchState() };
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, local(event));
    if (pointers.size >= 2 && drag?.pinch) {
      const now = pinchState();
      zoom(now.d / drag.pinch.d, now.cx, now.cy);
      drag.pinch = now;
      return;
    }
    if (!drag || drag.pinch) return;
    const p = local(event);
    if (Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > 6) drag.moved = true;
    if (drag.moved) { view.ox = drag.ox + p.x - drag.start.x; view.oy = drag.oy + p.y - drag.start.y; draw(); }
  });
  const end = (event) => {
    const was = drag;
    pointers.delete(event.pointerId);
    if (pointers.size) return;
    drag = null;
    if (!was || was.moved || was.pinch || !image || event.type === 'pointercancel') return;
    const p = toImage(was.start.x, was.start.y);
    if (p.x < 0 || p.y < 0 || p.x > image.width || p.y > image.height) return;
    if (mode === 'center') center = p;
    else {
      points[mode] = p;
      $(`importE${mode}`).focus();
      if (mode === 0 && !points[1]) mode = 1;
    }
    update();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  function pinchState() {
    const [a, b] = [...pointers.values()];
    return { d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  }

  function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#e8ece6';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!image) return;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, view.ox, view.oy, image.width * view.s, image.height * view.s);
    const dpr = window.devicePixelRatio || 1;
    // The area that will be loaded: a square in grid metres (turned if the scan is turned).
    if (transform && center) {
      const c = imageToItm(transform, center.x, center.y);
      const extent = Number($('importSize').value) * 1000;
      const o = squareOrigin(c.e, c.n, extent);
      const corners = [[o.e, o.n], [o.e + extent, o.n], [o.e + extent, o.n + extent], [o.e, o.n + extent]]
        .map(([e, n]) => itmToImage(transform, e, n)).map((p) => toCanvas(p.x, p.y));
      ctx.beginPath();
      corners.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fillStyle = 'rgba(226,85,45,.12)';
      ctx.fill();
      ctx.lineWidth = 2.5 * dpr;
      ctx.strokeStyle = '#e2552d';
      ctx.setLineDash([10 * dpr, 6 * dpr]);
      ctx.stroke();
      ctx.setLineDash([]);
      const m = toCanvas(center.x, center.y);
      ctx.beginPath();
      ctx.arc(m.x, m.y, 5 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = '#e2552d';
      ctx.fill();
    }
    points.forEach((p, i) => {
      if (!p) return;
      const q = toCanvas(p.x, p.y);
      const r = 11 * dpr;
      for (const [color, width] of [['#fff', 5], ['#7a2fb0', 2.2]]) {
        ctx.strokeStyle = color;
        ctx.lineWidth = width * dpr;
        ctx.beginPath();
        ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
        ctx.moveTo(q.x - r * 1.9, q.y); ctx.lineTo(q.x - r * .4, q.y);
        ctx.moveTo(q.x + r * .4, q.y); ctx.lineTo(q.x + r * 1.9, q.y);
        ctx.moveTo(q.x, q.y - r * 1.9); ctx.lineTo(q.x, q.y - r * .4);
        ctx.moveTo(q.x, q.y + r * .4); ctx.lineTo(q.x, q.y + r * 1.9);
        ctx.stroke();
      }
      ctx.font = `700 ${15 * dpr}px Heebo, Arial, sans-serif`;
      ctx.fillStyle = '#7a2fb0';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 4 * dpr;
      ctx.strokeText(LABELS[i], q.x + r * 1.3, q.y - r * 1.3);
      ctx.fillText(LABELS[i], q.x + r * 1.3, q.y - r * 1.3);
    });
  }
  window.addEventListener('resize', () => { if (dialog.open && image) { fit(); draw(); } });

  // ——— After loading: how the imported map is shown ———
  function syncView() {
    const v = api.view();
    $('importOpacity').value = String(Math.round(v.opacity * 100));
    $('importOwnContours').checked = v.ownContours;
    $('importOsm').checked = v.osm;
    $('importViewName').textContent = v.name || 'מפה מיובאת';
  }
  $('importOpacity').addEventListener('input', () => api.setView({ opacity: Number($('importOpacity').value) / 100 }));
  $('importOwnContours').addEventListener('change', () => api.setView({ ownContours: $('importOwnContours').checked }));
  $('importOsm').addEventListener('change', () => api.setView({ osm: $('importOsm').checked }));
  $('importAnotherBtn').addEventListener('click', () => { $('importFile').value = ''; show('importPick'); });
  $('importRemoveBtn').addEventListener('click', () => { api.remove(); dialog.close(); });
  $('closeImportBtn').addEventListener('click', () => dialog.close());

  return {
    open() {
      showError('');
      if (api.drapeActive()) { syncView(); show('importView'); } else if (image) show('importWork'); else show('importPick');
      if (!dialog.open) dialog.showModal();
    },
  };
}
