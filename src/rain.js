// Rain simulator: shows where water goes on the current terrain.
// The physics lives in hydrology.js (computeHydrology): pits fill into lakes up to their
// spill point, everything else drains to the map edge, and streams are traced from the
// flow accumulation. This file animates it:
//   'raining'  — rain falls (3D streaks, 2D drops) while streams grow from their heads and
//                lakes fill from their deepest point up to their spill level;
//   'flowing'  — the steady state: streams keep flowing (scrolling texture) until cleared.
// See docs/RAIN.md.
import { analyzeTerrain, simulateRain, drainageBasins, tracePath, upstreamArea, dryFlow, traceDryPath } from './hydrology.js';
import { createRunoff } from './runoff.js';
import { contours } from 'd3-contour';
import * as THREE from 'three';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const RAIN_SECONDS = 3.2;      // how long the growth animation takes
const STREAK_COUNT = 1400;
const RAIN_KEY = 'topolab-rain-amount';
const OPACITY_KEY = 'topolab-water-opacity';
const BASIN_COLORS = ['#e39b4f', '#6fae5c', '#c56f98', '#4fa59b', '#d1bd45', '#8f7cc4', '#de7465', '#5c93cf', '#b08758', '#7fbfa2', '#c9a0d8', '#9fb34a'];
const CATCHMENT_COLOR = '#27a3d6';
const SIDE_NAMES = { north: 'צפון', south: 'דרום', east: 'מזרח', west: 'מערב' };
const sideName = (side) => side.split('-').map((part) => SIDE_NAMES[part] || part).join('־');
const hexToRgb = (hex) => [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16) / 255);

// Rain amount slider 0..100 → millimetres on a log scale; 100 means "until every
// depression is full" (the steady state after unlimited rain).
export function sliderToMillimetres(value) {
  if (value >= 100) return Infinity;
  return 5 * 600 ** (value / 99);
}
function rainLabel(mm) {
  if (!Number.isFinite(mm)) return 'עד שכל השקעים מתמלאים';
  const amount = mm >= 1000 ? `${(mm / 1000).toFixed(1)} מ׳` : `${Math.round(mm)} מ״מ`;
  const name = mm < 15 ? 'טפטוף' : mm < 60 ? 'גשם' : mm < 200 ? 'סערה' : mm < 800 ? 'חורף גשום' : 'מבול';
  return `${amount} · ${name}`;
}

function hash01(value) {
  let x = value >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

// Chaikin corner cutting: turns the D8 staircase into a natural curve.
function smooth(points, iterations = 2) {
  let pts = points;
  for (let k = 0; k < iterations; k++) {
    if (pts.length < 3) return pts;
    const next = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      next.push({ u: a.u * .75 + b.u * .25, v: a.v * .75 + b.v * .25, flow: a.flow * .75 + b.flow * .25 });
      next.push({ u: a.u * .25 + b.u * .75, v: a.v * .25 + b.v * .75, flow: a.flow * .25 + b.flow * .75 });
    }
    next.push(pts[pts.length - 1]);
    pts = next;
  }
  return pts;
}

function makeFlowTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, 32);
  gradient.addColorStop(0, '#2f86c0');
  gradient.addColorStop(.5, '#4aa6d9');
  gradient.addColorStop(1, '#2f86c0');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 32);
  ctx.strokeStyle = 'rgba(225,245,255,.75)';
  ctx.lineCap = 'round';
  for (let i = 0; i < 9; i++) {
    const x = hash01(i * 31 + 7) * 128;
    const y = 5 + hash01(i * 17 + 3) * 22;
    ctx.lineWidth = 1.4 + hash01(i * 13) * 1.6;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 14 + hash01(i * 29) * 18, y);
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createRainSimulation(api) {
  let base = null;        // terrain analysis (once per start)
  let model = null;       // base + the result of the current rain amount
  let paths = [];        // smoothed stream polylines: { points:[{u,v,flow}], length, end }
  let lakeShapes = [];   // d3 contour polygons per lake (2D)
  let phase = 'idle';
  let active = false;
  let frameId = 0;
  let lastTime = 0;
  let growth = 0;        // 0..1 during 'raining'
  let lastMapDraw = 0;
  let world = null;      // 3D objects
  let runoff = null;     // flowing droplets (runoff.js)
  // Water-analysis tools (rain panel): drainage basins and the drop tool.
  let showBasins = false;
  let basinView = null;  // { basinOf, basins, shapes }
  let dropMode = false;
  let hover = null;      // drop path preview under the pointer
  let pinned = null;     // clicked drop: { cell, path, catchment, shape, t }
  let dry = null;        // drop analysis without rain (lazy; dropped when the terrain changes)
  let waterOpacity = .6; // "בולטות המים" — scales every water layer
  let dryFrame = 0;
  // Trails are painted on their own canvas layered over the map, so the terrain is not
  // redrawn every frame; old trail pixels fade a little each frame.
  const trailCanvas = document.createElement('canvas');
  trailCanvas.className = 'rain-trails';
  trailCanvas.setAttribute('aria-hidden', 'true');
  document.getElementById('mapSurface')?.appendChild(trailCanvas);
  const trailCtx = trailCanvas.getContext('2d');
  const MAX_DROPS = 2200;
  let flowTexture = null;

  function updateUI(message = '') {
    const button = document.getElementById('rainBtn');
    const overlay = document.getElementById('rainStatusOverlay');
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
    button.querySelector('span').textContent = active ? 'ניקוי מים' : 'הפעלת גשם';
    document.getElementById('rainPanel').hidden = !active;
    if (message) overlay.textContent = message;
    if (message || !active) queueMicrotask(() => updateWaterInfo());
  }

  // ——— Model → drawable geometry ———
  function buildPaths() {
    const n = model.size;
    const toPoint = (i) => ({ u: (i % n) / (n - 1), v: Math.floor(i / n) / (n - 1), flow: model.accumulation[i] });
    paths = model.streams.map((stream) => {
      const raw = stream.cells.map(toPoint);
      if (stream.end === 'edge') {
        // Carry the stream visibly over the map edge.
        const last = raw[raw.length - 1];
        const prev = raw[raw.length - 2] || last;
        raw.push({ u: last.u + (last.u - prev.u), v: last.v + (last.v - prev.v), flow: last.flow });
      }
      const points = smooth(raw);
      let length = 0;
      for (let i = 1; i < points.length; i++) length += Math.hypot(points[i].u - points[i - 1].u, points[i].v - points[i - 1].v);
      return { points, length, end: stream.end };
    });
  }

  function buildLakeShapes() {
    const n = model.size;
    lakeShapes = model.lakes.filter((lake) => lake.wetCells > 0).map((lake) => {
      const grid = new Float64Array(n * n);
      for (const c of lake.cells) grid[c] = model.wet[c];
      const levels = [.3, Math.max(.6, lake.wetDepth * .5)];
      return { lake, polygons: contours().size([n, n]).smooth(true).thresholds(levels)(grid) };
    });
  }

  function strokeWidth(flow, dpr) {
    return clamp((.9 + Math.log2(flow / model.threshold + 1) * 1.15) * dpr, 1.1 * dpr, 7 * dpr);
  }

  // ——— Water analysis: basins and drops ———
  // The drop tool works with or without rain: during rain it follows the rain model (full
  // lakes overflow); otherwise it follows the real ground and stops in the first pit.
  const raining = () => active && Boolean(model);
  function dropBase() {
    if (raining()) return model;
    if (!dry) dry = dryFlow(api.gridSize(), api.heights());
    return dry;
  }
  function cellMeters() {
    const extent = api.extent ? api.extent() : 4000;
    return extent / (dropBase().size - 1);
  }

  function formatArea(cells) {
    const area = cells * cellMeters() ** 2;
    if (area >= 1e6) return `${(area / 1e6).toFixed(area >= 1e7 ? 1 : 2)} קמ״ר`;
    if (area >= 1e4) return `${Math.round(area / 1000)} דונם`;
    return `${Math.round(area / 100) * 100} מ״ר`;
  }

  function maskShape(mask) {
    const n = dropBase().size;
    const grid = new Float64Array(n * n);
    for (let i = 0; i < n * n; i++) grid[i] = mask(i) ? 1 : 0;
    return contours().size([n, n]).smooth(true).thresholds([.5])(grid)[0];
  }

  function pathPoints(cells) {
    const n = dropBase().size;
    return smooth(cells.map((i) => ({ u: (i % n) / (n - 1), v: Math.floor(i / n) / (n - 1), flow: 1 })), 2);
  }

  function endText(end) {
    if (end.type === 'lake') {
      const lake = model.lakes[end.lake];
      return `נעצרת באגם (עומק ${Math.max(1, Math.round(lake.wetDepth))} מ׳) — אגן סגור`;
    }
    if (end.type === 'edge') return `יוצאת מהמפה ב${sideName(end.side)}`;
    if (end.type === 'pit') return 'נעצרת בשקע — הנקודה הנמוכה ביותר בסביבתה';
    return 'נעצרת בשטח שטוח';
  }

  function computeBasins() {
    const { basinOf, basins } = drainageBasins(model, model);
    const shapes = basins.map((basin) => maskShape((i) => basinOf[i] === basin.id));
    basinView = { basinOf, basins, shapes };
  }

  function tracePoint(cell) {
    return raining() ? tracePath(model, model, cell) : traceDryPath(dropBase(), cell);
  }

  function pinDrop(cell) {
    const path = tracePoint(cell);
    const catchment = upstreamArea(dropBase(), cell);
    pinned = { cell, path, points: pathPoints(path.cells), catchment, shape: catchment.cells > 3 ? maskShape((i) => catchment.mask[i]) : null, t: 0 };
  }

  // Terrain overlay in 3D: the clicked drop's catchment wins over the basin colours.
  function applyTint() {
    if (!api.setTerrainTint) return;
    if (!pinned && !(active && showBasins)) { api.setTerrainTint(null); return; }
    const n = dropBase().size;
    const tint = new Float32Array(n * n * 4);
    if (pinned) {
      const [r, g, b] = hexToRgb(CATCHMENT_COLOR);
      for (let i = 0; i < n * n; i++) if (pinned.catchment.mask[i]) tint.set([r, g, b, .5], i * 4);
    } else if (basinView) {
      const colors = basinView.basins.map((basin) => hexToRgb(BASIN_COLORS[basin.id % BASIN_COLORS.length]));
      for (let i = 0; i < n * n; i++) {
        const id = basinView.basinOf[i];
        if (id >= 0) tint.set([...colors[id], .45], i * 4);
      }
    }
    api.setTerrainTint(tint);
  }

  function refreshWaterTools() {
    if (active && model && showBasins) computeBasins(); else basinView = null;
    if (pinned) pinDrop(pinned.cell);
    applyTint();
    updateWaterInfo();
  }

  // Details live behind the "i" button on the map (wide screens) or below the map (phones).
  function updateWaterInfo(fresh = false) {
    const box = document.getElementById('waterInfo');
    const toggle = document.getElementById('waterInfoBtn');
    const parts = [];
    const status = document.getElementById('rainStatusOverlay').textContent;
    if (active && status) parts.push(`<div class="info-status">🌧️ ${status}</div>`);
    if (pinned) {
      const base = dropBase();
      const n = base.size;
      const start = pinned.path.cells[0];
      const last = pinned.path.cells[pinned.path.cells.length - 1];
      let length = 0;
      for (let k = 1; k < pinned.path.cells.length; k++) {
        const a = pinned.path.cells[k - 1];
        const b = pinned.path.cells[k];
        length += Math.hypot(a % n - b % n, Math.floor(a / n) - Math.floor(b / n));
      }
      const meters = length * cellMeters();
      const drop = base.heights[start] - base.heights[last];
      const context = raining() ? '' : ' <span style="color:#5d7d8c">(בלי גשם)</span>';
      parts.push(`<div>💧 <strong>מהנקודה (גובה ${Math.round(base.heights[start])} מ׳)</strong>${context} הטיפה עוברת ${meters >= 1000 ? `${(meters / 1000).toFixed(2)} ק״מ` : `${Math.round(meters)} מ׳`}, יורדת ${Math.max(0, Math.round(drop))} מ׳ ו${endText(pinned.path.end)}.</div>`);
      parts.push(`<div><i style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${CATCHMENT_COLOR};opacity:.8"></i> <strong>אגן ההיקוות של הנקודה:</strong> ${formatArea(pinned.catchment.cells)} — כל הגשם שיורד בשטח המסומן עובר כאן.</div>`);
    }
    if (active && showBasins && basinView && !pinned) {
      const chips = basinView.basins.map((basin) => {
        const where = basin.destination.type === 'lake' ? 'אגם (אגן סגור)' : sideName(basin.destination.side);
        return `<span><i style="background:${BASIN_COLORS[basin.id % BASIN_COLORS.length]}"></i>${Math.round(basin.share * 100)}% → ${where}</span>`;
      }).join('');
      parts.push(`<div><strong>${basinView.basins.length} אגני ניקוז.</strong> הקווים הכהים הם קווי פרשת המים: גשם משני צדי הקו מגיע למקומות שונים.</div><div class="basin-chips">${chips}</div>`);
    }
    if (active && !pinned) parts.push('<div class="rain-legend-inline">כל קו כחול דק הוא טיפה שזורמת במורד התלול ביותר: מכיפה לכל הכיוונים, תמיד בניצב לקווי הגובה.</div>');
    if (pinned) parts.push('<button type="button" class="info-close" id="clearDropBtn">ניקוי הטיפה</button>');
    box.hidden = !parts.length;
    toggle.hidden = !parts.length;
    if (!parts.length) { box.classList.remove('open'); toggle.setAttribute('aria-expanded', 'false'); }
    box.innerHTML = parts.join('') + '<button type="button" class="info-dismiss" id="closeWaterInfoBtn" aria-label="סגירת הפירוט">×</button>';
    document.getElementById('closeWaterInfoBtn').addEventListener('click', () => setInfoOpen(false));
    if (fresh) {
      toggle.classList.remove('pulse');
      void toggle.offsetWidth;
      toggle.classList.add('pulse');
    }
    document.getElementById('clearDropBtn')?.addEventListener('click', () => { pinned = null; applyTint(); updateWaterInfo(); updateDrop3D(); clearTrails(); api.redraw(); });
  }

  // On wide screens the card opens as a popover right under the "i" button.
  function setInfoOpen(open) {
    const box = document.getElementById('waterInfo');
    const toggle = document.getElementById('waterInfoBtn');
    box.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
    const floating = open && toggle.offsetParent !== null; // the toggle is hidden on phones
    box.classList.toggle('floating', floating);
    if (floating) {
      const rect = toggle.getBoundingClientRect();
      const width = Math.min(360, innerWidth - 24);
      box.style.width = `${width}px`;
      box.style.left = `${Math.max(12, rect.right - width)}px`;
      box.style.top = `${rect.bottom + 8}px`;
    } else {
      box.style.width = box.style.left = box.style.top = '';
    }
  }

  function syncToolButtons() {
    document.getElementById('basinsBtn').setAttribute('aria-pressed', String(showBasins));
    api.setDropCursor?.(dropMode);
  }

  function collapsePanel(collapsed) {
    document.getElementById('rainPanel').classList.toggle('collapsed', collapsed);
    document.getElementById('rainCollapseBtn').setAttribute('aria-expanded', String(!collapsed));
  }

  function setBasins(on) {
    showBasins = on;
    if (on) collapsePanel(true);
    syncToolButtons();
    refreshWaterTools();
    api.redraw();
  }

  // Called by scene.js when the "טיפה" rail tool is picked or left.
  function setDropMode(on) {
    if (dropMode === on) return;
    dropMode = on;
    if (on && active) collapsePanel(true);
    hover = null;
    if (!on) pinned = null;
    syncToolButtons();
    refreshWaterTools();
    updateDrop3D();
    if (!active) clearTrails();
    runDryLoop();
    api.redraw();
  }

  // Terrain was edited: the dry analysis is stale; a pinned dry drop is recomputed.
  function terrainChanged() {
    dry = null;
    if (!active && pinned) {
      pinDrop(pinned.cell);
      applyTint();
      updateWaterInfo();
      updateDrop3D();
    }
  }

  // Without rain the rain loop is off, so the pinned droplet gets its own animation.
  function runDryLoop() {
    cancelAnimationFrame(dryFrame);
    if (active || !dropMode || !pinned) return;
    let last = 0;
    const loop = (now) => {
      if (active || !dropMode || !pinned) return;
      const dt = last ? Math.min((now - last) / 1000, .08) : 0;
      last = now;
      advancePinned(dt);
      clearTrails();
      paintPinnedDroplet();
      dryFrame = requestAnimationFrame(loop);
    };
    dryFrame = requestAnimationFrame(loop);
  }

  function advancePinned(dt) {
    if (!pinned || dt <= 0) return;
    pinned.t += dt * 9; // path points per second
    if (pinned.t > pinned.points.length - 1 + 12) pinned.t = 0; // pause at the end, then again
    updateDrop3D();
  }

  function cellAt(gx, gy) {
    const n = dropBase().size;
    return Math.round(Math.max(0, Math.min(n - 1, gy))) * n + Math.round(Math.max(0, Math.min(n - 1, gx)));
  }

  function handleMapHover(gx, gy) {
    if (!dropMode) return;
    const cell = cellAt(gx, gy);
    if (hover?.cell === cell) return;
    hover = { cell, points: pathPoints(tracePoint(cell).cells) };
    api.redraw();
  }

  // Clicks near a stream snap onto it (students aim at the blue line, not beside it).
  function snapToStream(cell) {
    if (!raining()) return cell; // no streams without rain
    const n = model.size;
    const x0 = cell % n;
    const y0 = Math.floor(cell / n);
    let best = cell;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = x0 + dx;
        const y = y0 + dy;
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        const i = y * n + x;
        if (model.accumulation[i] >= model.threshold && model.accumulation[i] > model.accumulation[best]) best = i;
      }
    }
    return best;
  }

  function handleMapClick(gx, gy) {
    if (!dropMode) return;
    pinDrop(snapToStream(cellAt(gx, gy)));
    hover = null;
    applyTint();
    updateWaterInfo(true);
    updateDrop3D();
    runDryLoop();
    api.redraw();
  }

  function drawShape(ctx, shape, w, h, fill, stroke, lineWidth) {
    if (!shape) return;
    const n = dropBase().size;
    ctx.save();
    ctx.scale(w / n, h / n);
    ctx.beginPath();
    for (const polygon of shape.coordinates) for (const ring of polygon) ring.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    if (fill) { ctx.fillStyle = fill; ctx.fill('evenodd'); }
    if (stroke) { ctx.lineWidth = lineWidth / (w / n); ctx.strokeStyle = stroke; ctx.stroke(); }
    ctx.restore();
  }

  function drawPath(ctx, points, w, h, dpr, preview) {
    if (!points || points.length < 2) return;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    points.forEach((p, i) => (i ? ctx.lineTo(p.u * w, p.v * h) : ctx.moveTo(p.u * w, p.v * h)));
    ctx.lineWidth = (preview ? 5 : 7) * dpr;
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.stroke();
    ctx.lineWidth = (preview ? 2.4 : 3.6) * dpr;
    ctx.strokeStyle = preview ? 'rgba(10,80,140,.75)' : '#0b5ea8';
    if (preview) ctx.setLineDash([6 * dpr, 5 * dpr]);
    ctx.stroke();
    ctx.setLineDash([]);
    const start = points[0];
    ctx.beginPath();
    ctx.arc(start.u * w, start.v * h, (preview ? 4 : 6) * dpr, 0, Math.PI * 2);
    ctx.fillStyle = '#0b5ea8';
    ctx.fill();
    ctx.lineWidth = 2 * dpr;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    // Arrow head at the end shows the direction of flow.
    const a = points[points.length - 2];
    const b = points[points.length - 1];
    const angle = Math.atan2((b.v - a.v) * h, (b.u - a.u) * w);
    const size = (preview ? 7 : 10) * dpr;
    ctx.translate(b.u * w, b.v * h);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(size * .6, 0);
    ctx.lineTo(-size * .6, size * .55);
    ctx.lineTo(-size * .6, -size * .55);
    ctx.closePath();
    ctx.fillStyle = '#0b5ea8';
    ctx.fill();
    ctx.restore();
  }

  // ——— 2D map overlay ———
  function drawDropOverlays(ctx, w, h, dpr) {
    if (pinned?.shape) drawShape(ctx, pinned.shape, w, h, 'rgba(39,163,214,.36)', 'rgba(10,94,150,.95)', 2.6 * dpr);
    if (hover) drawPath(ctx, hover.points, w, h, dpr, true);
    if (pinned) drawPath(ctx, pinned.points, w, h, dpr, false);
  }

  function draw2D(ctx, canvas, dpr) {
    const w = canvas.width;
    const h = canvas.height;
    if (!active || !model) {
      if (dropMode) drawDropOverlays(ctx, w, h, dpr);
      return;
    }
    const n = model.size;
    const p = phase === 'raining' ? growth : 1;
    ctx.save();
    if (basinView && !pinned) {
      basinView.shapes.forEach((shape, id) => drawShape(ctx, shape, w, h, `${BASIN_COLORS[id % BASIN_COLORS.length]}66`, null, 0));
      // Divides: the outlines of the basins, dark and thick.
      basinView.shapes.forEach((shape) => drawShape(ctx, shape, w, h, null, 'rgba(40,30,20,.75)', 2.6 * dpr));
    }
    // Water layers (lakes, streams, outlets) follow the "בולטות המים" control.
    ctx.globalAlpha = waterOpacity;
    // Lakes: shallow and deep shading, filling in as the rain falls.
    const sx = w / n;
    const sy = h / n;
    for (const { polygons } of lakeShapes) {
      polygons.forEach((shape, k) => {
        ctx.save();
        ctx.scale(sx, sy);
        ctx.beginPath();
        for (const polygon of shape.coordinates) {
          for (const ring of polygon) ring.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        }
        ctx.fillStyle = k === 0 ? `rgba(66,152,206,${.62 * p})` : `rgba(28,104,166,${.55 * p})`;
        ctx.fill('evenodd');
        if (k === 0) {
          ctx.lineWidth = 1.4 * dpr / sx;
          ctx.strokeStyle = `rgba(20,90,140,${.8 * p})`;
          ctx.stroke();
        }
        ctx.restore();
      });
    }
    // Streams: white halo, then water, revealed from the head downstream.
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const pass of ['halo', 'water']) {
      for (const path of paths) {
        const visible = Math.max(2, Math.ceil(path.points.length * clamp(p * 1.25, 0, 1)));
        for (let i = 1; i < visible && i < path.points.length; i++) {
          const a = path.points[i - 1];
          const b = path.points[i];
          const width = strokeWidth(b.flow, dpr);
          ctx.beginPath();
          ctx.moveTo(a.u * w, a.v * h);
          ctx.lineTo(b.u * w, b.v * h);
          if (pass === 'halo') {
            ctx.lineWidth = width + 2.2 * dpr;
            ctx.strokeStyle = 'rgba(255,255,255,.45)';
          } else {
            ctx.lineWidth = width;
            ctx.strokeStyle = 'rgba(30,124,186,.92)';
          }
          ctx.stroke();
        }
      }
    }
    // Outlets: arrows where water leaves the map.
    if (p >= 1) {
      const maxFlow = model.outlets[0]?.flow || 1;
      for (const outlet of model.outlets) {
        if (outlet.flow < model.threshold * 2) continue; // only outlets that matter
        const x = outlet.index % n;
        const y = Math.floor(outlet.index / n);
        const ox = x === 0 ? -1 : x === n - 1 ? 1 : 0;
        const oy = y === 0 ? -1 : y === n - 1 ? 1 : 0;
        if (!ox && !oy) continue;
        const px = x / (n - 1) * w;
        const py = y / (n - 1) * h;
        const size = (7 + 7 * Math.sqrt(outlet.flow / maxFlow)) * dpr;
        const angle = Math.atan2(oy, ox);
        ctx.save();
        ctx.translate(px - ox * size * .9, py - oy * size * .9);
        ctx.rotate(angle);
        ctx.beginPath();
        ctx.moveTo(size * .7, 0);
        ctx.lineTo(-size * .5, size * .55);
        ctx.lineTo(-size * .5, -size * .55);
        ctx.closePath();
        ctx.fillStyle = '#1b6fa8';
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.6 * dpr;
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
    drawDropOverlays(ctx, w, h, dpr);
    // Rain drops while it is raining.
    if (phase === 'raining') {
      const t = performance.now() / 1000;
      ctx.fillStyle = 'rgba(60,150,210,.55)';
      for (let i = 0; i < 260; i++) {
        const life = (t * 1.6 + hash01(i * 7 + 1)) % 1;
        const x = hash01(i * 13 + Math.floor(t * 1.6 + hash01(i * 7 + 1)) * 977) * w;
        const y = hash01(i * 29 + Math.floor(t * 1.6 + hash01(i * 7 + 1)) * 557) * h;
        ctx.globalAlpha = (1 - life) * (1 - growth * .6);
        ctx.beginPath();
        ctx.arc(x, y, (1.2 + life * 2.6) * dpr, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  // ——— 3D: rain streaks, flowing stream ribbons, lake surfaces ———
  function buildWorld() {
    const scene = api.scene();
    if (!scene) return null;
    const group = new THREE.Group();
    group.name = 'rain';
    const W = api.worldSize();
    const vs = api.verticalScale();
    const surface = api.surfaceHeight || api.height;
    const k = W / 10; // overview widths are tuned for the 4 km (10-unit) model

    // Rain streaks.
    const streakPositions = new Float32Array(STREAK_COUNT * 6);
    const streakGeometry = new THREE.BufferGeometry();
    streakGeometry.setAttribute('position', new THREE.BufferAttribute(streakPositions, 3).setUsage(THREE.DynamicDrawUsage));
    const streaks = new THREE.LineSegments(streakGeometry, new THREE.LineBasicMaterial({ color: 0x9fd2f0, transparent: true, opacity: .55, depthWrite: false }));
    streaks.frustumCulled = false;
    const drops = [];
    for (let i = 0; i < STREAK_COUNT; i++) {
      drops.push({ u: hash01(i * 3 + 1), v: hash01(i * 5 + 2), y: hash01(i * 7 + 3), speed: .8 + hash01(i * 11 + 4) * .5 });
    }
    group.add(streaks);

    // Streams.
    flowTexture ||= makeFlowTexture();
    const streamMaterial = new THREE.MeshStandardMaterial({ map: flowTexture, roughness: .25, metalness: .05, transparent: true, opacity: .95, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    const ribbons = [];
    for (const path of paths) {
      const pts = path.points;
      if (pts.length < 2) continue;
      const positions = [];
      const uvs = [];
      const indices = [];
      let along = 0;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const prev = pts[Math.max(0, i - 1)];
        const next = pts[Math.min(pts.length - 1, i + 1)];
        let tx = (next.u - prev.u) * W;
        let tz = (next.v - prev.v) * W;
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl; tz /= tl;
        const half = clamp(.008 + Math.log2(p.flow / model.threshold + 1) * .0085, .009, .05) * k;
        const u = clamp(p.u, 0, 1);
        const v = clamp(p.v, 0, 1);
        const x = (p.u - .5) * W;
        const z = (p.v - .5) * W;
        const y = surface(u, v) * vs + .012 * k;
        if (i > 0) along += Math.hypot((p.u - pts[i - 1].u) * W, (p.v - pts[i - 1].v) * W);
        positions.push(x - tz * half, y, z + tx * half, x + tz * half, y, z - tx * half);
        uvs.push(along / (.35 * k), 0, along / (.35 * k), 1);
        if (i > 0) {
          const a = (i - 1) * 2;
          indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();
      geometry.setDrawRange(0, 0);
      const mesh = new THREE.Mesh(geometry, streamMaterial);
      mesh.userData.totalIndices = indices.length;
      group.add(mesh);
      ribbons.push(mesh);
    }

    // Lakes: a flat water sheet over every grid square that touches the lake. The terrain
    // pokes through it where it is higher, which draws a natural shoreline. The sheet rises
    // from the lake bottom to its spill level while it rains.
    const n = model.size;
    const lakeMeshes = [];
    // No polygon offset: the terrain must win near the shore so it cuts a natural shoreline.
    const lakeMaterial = new THREE.MeshStandardMaterial({ color: 0x2f7fb8, roughness: .12, metalness: .08, transparent: true, opacity: .86 });
    for (const lake of model.lakes) {
      if (!lake.wetCells) continue;
      const inLake = new Set(lake.cells.filter((c) => model.wet[c] > 0));
      const squares = new Set();
      for (const c of inLake) {
        const cx = c % n;
        const cy = (c - cx) / n;
        for (const [dx, dy] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= n - 1 || y >= n - 1) continue;
          // Skip squares whose corners drop below the lake outside it (the outflow side).
          const corners = [y * n + x, y * n + x + 1, (y + 1) * n + x, (y + 1) * n + x + 1];
          if (corners.every((i) => inLake.has(i) || api.heights()[i] >= lake.wetLevel - .05)) squares.add(y * n + x);
        }
      }
      const positions = [];
      const cell = W / (n - 1);
      for (const s of squares) {
        const x = s % n;
        const y = (s - x) / n;
        const x0 = -W / 2 + x * cell;
        const z0 = -W / 2 + y * cell;
        positions.push(x0, 0, z0, x0, 0, z0 + cell, x0 + cell, 0, z0, x0 + cell, 0, z0, x0, 0, z0 + cell, x0 + cell, 0, z0 + cell);
      }
      if (!positions.length) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, lakeMaterial);
      const bottom = lake.bottoms[0];
      mesh.userData = { bottom, level: lake.wetLevel };
      mesh.position.y = bottom * vs;
      mesh.receiveShadow = true;
      group.add(mesh);
      lakeMeshes.push(mesh);
    }

    // Runoff drops: a short bright streak per drop, lying on the ground.
    const dropPositions = new Float32Array(MAX_DROPS * 6);
    const dropGeometry = new THREE.BufferGeometry();
    dropGeometry.setAttribute('position', new THREE.BufferAttribute(dropPositions, 3).setUsage(THREE.DynamicDrawUsage));
    dropGeometry.setDrawRange(0, 0);
    const dropLines = new THREE.LineSegments(dropGeometry, new THREE.LineBasicMaterial({ color: 0xcff0ff, transparent: true, opacity: .95, depthTest: true }));
    dropLines.frustumCulled = false;
    dropLines.renderOrder = 5;
    group.add(dropLines);

    scene.add(group);
    return { group, streaks, drops, dropLines, ribbons, lakeMeshes, vs, streamMaterial, lakeMaterial, materials: [streamMaterial, lakeMaterial, streaks.material, dropLines.material] };
  }

  function disposeWorld() {
    if (!world) return;
    world.group.parent?.remove(world.group);
    world.group.traverse((object) => object.geometry?.dispose());
    world.materials.forEach((m) => m.dispose());
    world = null;
  }

  function update3D(dt = 0) {
    if (!world) return;
    // Ribbons are baked at the current vertical exaggeration; rebuild if it changed.
    if (world.vs !== api.verticalScale()) { disposeWorld(); world = buildWorld(); if (!world) return; }
    const W = api.worldSize();
    const vs = api.verticalScale();
    const top = W * .55;
    const p = phase === 'raining' ? growth : 1;
    // Rain streaks fall while it rains and fade out afterwards.
    const positions = world.streaks.geometry.attributes.position.array;
    const raining = phase === 'raining';
    world.streaks.material.opacity = raining ? .55 : Math.max(0, world.streaks.material.opacity - dt * .8);
    world.streaks.visible = world.streaks.material.opacity > .01;
    if (world.streaks.visible) {
      const length = W * .018;
      world.drops.forEach((drop, i) => {
        drop.y -= dt * drop.speed * 1.2;
        if (drop.y < 0) drop.y += 1;
        const ground = api.height(drop.u, drop.v) * vs;
        const y = ground + drop.y * top;
        const x = (drop.u - .5) * W;
        const z = (drop.v - .5) * W;
        positions.set([x, y, z, x + W * .002, y + length, z], i * 6);
      });
      world.streaks.geometry.attributes.position.needsUpdate = true;
    }
    for (const ribbon of world.ribbons) {
      const visible = Math.floor(ribbon.userData.totalIndices / 6 * clamp(p * 1.25, 0, 1)) * 6;
      ribbon.geometry.setDrawRange(0, visible);
    }
    for (const lake of world.lakeMeshes) {
      const { bottom, level } = lake.userData;
      lake.position.y = (bottom + (level - bottom) * clamp(p * 1.1, 0, 1)) * vs + .004 * W / 10;
    }
    if (runoff && world.dropLines) {
      const n = runoff.size;
      const surface = api.surfaceHeight || api.height;
      const lift = .006 * W / 10;
      const arr = world.dropLines.geometry.attributes.position.array;
      let k = 0;
      for (const p of runoff.particles) {
        if (!p.alive || p.fresh) continue;
        // Streak from where the drop was ~0.4 s ago to where it is now.
        const tx = Math.max(0, Math.min(n - 1, p.x - p.vx * .4));
        const ty = Math.max(0, Math.min(n - 1, p.y - p.vy * .4));
        const hu = p.x / (n - 1);
        const hv = p.y / (n - 1);
        const tu = tx / (n - 1);
        const tv = ty / (n - 1);
        arr[k++] = (tu - .5) * W; arr[k++] = surface(tu, tv) * vs + lift; arr[k++] = (tv - .5) * W;
        arr[k++] = (hu - .5) * W; arr[k++] = surface(hu, hv) * vs + lift; arr[k++] = (hv - .5) * W;
      }
      world.dropLines.geometry.setDrawRange(0, k / 3);
      world.dropLines.geometry.attributes.position.needsUpdate = true;
    }
    world.streamMaterial.opacity = .95 * waterOpacity;
    world.lakeMaterial.opacity = .86 * waterOpacity;
    world.lakeMaterial.transparent = true;
    world.dropLines.material.opacity = .95 * Math.max(.35, waterOpacity);
    if (flowTexture) flowTexture.offset.x -= dt * .9;
    api.invalidate();
  }

  // ——— Messages ———
  function summary() {
    const extent = api.extent ? api.extent() : 4000;
    const cellArea = (extent / (model.size - 1)) ** 2;
    const lakes = model.lakes.filter((lake) => lake.wetCells > 0);
    const full = lakes.filter((lake) => lake.full).length;
    const outlets = model.outlets.filter((o) => o.flow >= model.threshold * 2).length;
    const parts = [];
    if (!model.streams.length && !lakes.length) return 'המים מתפזרים על המדרונות ויוצאים מהמפה בלי ליצור נחלים.';
    if (lakes.length) {
      const biggest = lakes.reduce((a, b) => (b.wetCells > a.wetCells ? b : a));
      const area = biggest.wetCells * cellArea;
      const size = area >= 1e6 ? `${(area / 1e6).toFixed(2)} קמ״ר` : area >= 1e4 ? `${Math.round(area / 1000)} דונם` : `${Math.round(area / 100) * 100} מ״ר`;
      const count = lakes.length === 1 ? 'אגם אחד' : `${lakes.length} אגמים`;
      const fullText = !full ? '' : full === lakes.length ? (full === 1 ? ', מלא וגולש' : ', כולם מלאים וגולשים') : full === 1 ? ', אחד מהם מלא וגולש' : `, ${full} מהם מלאים וגולשים`;
      parts.push(`${count}${fullText} · הגדול ${size}, עומק ${Math.round(biggest.wetDepth)} מ׳`);
    }
    if (outlets) parts.push(`יוצאים מהמפה ב־${outlets} ${outlets === 1 ? 'מקום' : 'מקומות'}`);
    return parts.join(' · ');
  }

  // ——— 3D drop path and droplet ———
  let drop3D = null;
  function updateDrop3D() {
    const scene = api.scene();
    if (!scene) return;
    if (!pinned) {
      if (drop3D) { scene.remove(drop3D.group); drop3D.line.geometry.dispose(); drop3D.ball.geometry.dispose(); drop3D = null; api.invalidate(); }
      return;
    }
    const W = api.worldSize();
    const vs = api.verticalScale();
    const surface = api.surfaceHeight || api.height;
    const lift = .02 * W / 10;
    const at = (p) => [(p.u - .5) * W, surface(Math.min(1, Math.max(0, p.u)), Math.min(1, Math.max(0, p.v))) * vs + lift, (p.v - .5) * W];
    if (!drop3D || drop3D.cell !== pinned.cell || drop3D.vs !== vs || drop3D.count !== pinned.points.length) {
      if (drop3D) { scene.remove(drop3D.group); drop3D.line.geometry.dispose(); drop3D.ball.geometry.dispose(); }
      const group = new THREE.Group();
      const positions = pinned.points.flatMap(at);
      const lineGeometry = new THREE.BufferGeometry();
      lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      const line = new THREE.Line(lineGeometry, new THREE.LineBasicMaterial({ color: 0x0b5ea8, depthTest: false, transparent: true }));
      line.renderOrder = 12;
      const ball = new THREE.Mesh(new THREE.SphereGeometry(.035 * W / 10, 16, 12), new THREE.MeshStandardMaterial({ color: 0x2b9be0, emissive: 0x0b5ea8, emissiveIntensity: .4, roughness: .2 }));
      ball.renderOrder = 13;
      group.add(line, ball);
      scene.add(group);
      drop3D = { group, line, ball, cell: pinned.cell, vs, count: pinned.points.length };
    }
    const pts = pinned.points;
    const k = Math.min(pts.length - 1, Math.floor(pinned.t));
    const f = pinned.t - k;
    const a = at(pts[k]);
    const b = at(pts[Math.min(pts.length - 1, k + 1)]);
    drop3D.ball.position.set(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f + .02 * W / 10, a[2] + (b[2] - a[2]) * f);
    api.invalidate();
  }

  // ——— 2D trails ———
  function paintTrails() {
    const mapCanvas = document.getElementById('mapCanvas');
    if (!mapCanvas || !runoff) return;
    if (trailCanvas.width !== mapCanvas.width || trailCanvas.height !== mapCanvas.height) {
      trailCanvas.width = mapCanvas.width;
      trailCanvas.height = mapCanvas.height;
    }
    const w = trailCanvas.width;
    const h = trailCanvas.height;
    const n = runoff.size;
    const dpr = w / Math.max(1, mapCanvas.getBoundingClientRect().width || w);
    // Fade what is already there, then add this frame's movement.
    trailCtx.globalCompositeOperation = 'destination-out';
    trailCtx.fillStyle = 'rgba(0,0,0,.09)';
    trailCtx.fillRect(0, 0, w, h);
    trailCtx.globalCompositeOperation = 'source-over';
    trailCtx.lineCap = 'round';
    trailCtx.lineWidth = 1.7 * dpr;
    trailCtx.strokeStyle = 'rgba(18,96,168,.9)';
    trailCtx.beginPath();
    for (const p of runoff.particles) {
      if (!p.alive || p.fresh) continue;
      trailCtx.moveTo(p.px / (n - 1) * w, p.py / (n - 1) * h);
      trailCtx.lineTo(p.x / (n - 1) * w, p.y / (n - 1) * h);
    }
    trailCtx.stroke();
    paintPinnedDroplet();
  }

  function paintPinnedDroplet() {
    const mapCanvas = document.getElementById('mapCanvas');
    if (!mapCanvas || !pinned) return;
    if (trailCanvas.width !== mapCanvas.width || trailCanvas.height !== mapCanvas.height) {
      trailCanvas.width = mapCanvas.width;
      trailCanvas.height = mapCanvas.height;
    }
    const w = trailCanvas.width;
    const h = trailCanvas.height;
    const dpr = w / Math.max(1, mapCanvas.getBoundingClientRect().width || w);
    if (pinned.points.length > 1) {
      const pts = pinned.points;
      const k = Math.min(pts.length - 1, Math.floor(pinned.t));
      const f = pinned.t - k;
      const a = pts[k];
      const b = pts[Math.min(pts.length - 1, k + 1)];
      const x = (a.u + (b.u - a.u) * f) * w;
      const y = (a.v + (b.v - a.v) * f) * h;
      trailCtx.beginPath();
      trailCtx.arc(x, y, 5.5 * dpr, 0, Math.PI * 2);
      trailCtx.fillStyle = '#0b5ea8';
      trailCtx.fill();
      trailCtx.lineWidth = 2 * dpr;
      trailCtx.strokeStyle = '#fff';
      trailCtx.stroke();
    }
  }

  function clearTrails() {
    trailCtx.clearRect(0, 0, trailCanvas.width, trailCanvas.height);
  }

  // ——— Lifecycle ———
  function tick(now) {
    if (!active) return;
    const dt = lastTime ? Math.min((now - lastTime) / 1000, .08) : 0;
    lastTime = now;
    if (phase === 'raining') {
      growth = Math.min(1, growth + dt / RAIN_SECONDS);
      if (growth >= 1) {
        phase = 'flowing';
        updateUI(summary());
        api.redraw();
      }
      if (now - lastMapDraw >= 60) {
        lastMapDraw = now;
        api.redraw();
      }
    }
    advancePinned(dt);
    if (runoff && dt > 0) {
      // Small fixed sub-steps keep trails smooth even when a frame is slow.
      const steps = Math.ceil(dt / .03);
      for (let k = 0; k < steps; k++) runoff.step(dt / steps);
      paintTrails();
    }
    update3D(dt);
    frameId = requestAnimationFrame(tick);
  }

  function rainMeters() {
    return sliderToMillimetres(Number(document.getElementById('rainAmount').value)) / 1000;
  }

  function simulate() {
    const extent = api.extent ? api.extent() : 4000;
    const cellArea = (extent / (base.size - 1)) ** 2;
    model = { ...base, ...simulateRain(base, { rainMeters: rainMeters(), cellArea }) };
    // More rain, more drops on the slopes (drizzle ≈ 500, unlimited ≈ 2200).
    const mm = rainMeters() * 1000;
    const drops = Number.isFinite(mm) ? Math.round(Math.min(MAX_DROPS, 350 + Math.log10(Math.max(5, mm)) * 520)) : MAX_DROPS;
    runoff = createRunoff({ size: base.size, surface: base.filled, wet: model.wet, cellMeters: extent / (base.size - 1), count: drops, seed: 11 });
    buildPaths();
    buildLakeShapes();
    disposeWorld();
    world = buildWorld();
    refreshWaterTools();
  }

  // Re-run with a new rain amount (cheap: the terrain analysis is reused).
  let pendingAmount = 0;
  function onAmountInput() {
    const slider = document.getElementById('rainAmount');
    document.getElementById('rainAmountValue').value = rainLabel(sliderToMillimetres(Number(slider.value)));
    try { localStorage.setItem(RAIN_KEY, slider.value); } catch { /* storage unavailable */ }
    if (!active || pendingAmount) return;
    pendingAmount = requestAnimationFrame(() => {
      pendingAmount = 0;
      simulate();
      if (phase !== 'raining') { update3D(0); updateUI(summary()); }
      api.redraw();
    });
  }

  function start() {
    base = analyzeTerrain(api.gridSize(), api.heights());
    active = true;
    simulate();
    syncToolButtons();
    collapsePanel(dropMode || showBasins); // keep the map clear while a water tool is on
    phase = 'raining';
    growth = 0;
    lastTime = 0;
    lastMapDraw = 0;
    updateUI('יורד גשם… כל טיפה זורמת במורד התלול ביותר, אל הערוצים והשקעים');
    cancelAnimationFrame(frameId);
    frameId = requestAnimationFrame(tick);
    api.redraw();
  }

  function stop() {
    active = false;
    phase = 'idle';
    cancelAnimationFrame(frameId);
    disposeWorld();
    runoff = null;
    clearTrails();
    pinned = null;
    hover = null;
    basinView = null;
    base = null;
    model = null;
    updateDrop3D();
    api.setTerrainTint?.(null);
    updateWaterInfo(); // the drop tool keeps working without rain
    syncToolButtons();
    paths = [];
    lakeShapes = [];
    updateUI();
    api.redraw();
    api.invalidate();
  }

  function toggle() {
    if (active) stop();
    else start();
  }

  function stats() {
    return {
      active,
      phase,
      lakes: model?.lakes.filter((l) => l.wetCells > 0).length || 0,
      fullLakes: model?.lakes.filter((l) => l.wetCells > 0 && l.full).length || 0,
      rainMm: Number.isFinite(rainMeters()) ? Math.round(rainMeters() * 1000) : 'unlimited',
      streams: model?.streams.length || 0,
      drops: runoff ? runoff.particles.filter((p) => p.alive).length : 0,
      basins: basinView ? basinView.basins.length : 0,
      dropMode,
      pinnedDrop: pinned ? { pathCells: pinned.path.cells.length, end: pinned.path.end.type, catchmentCells: pinned.catchment.cells } : null,
      outlets: model?.outlets.length || 0,
      biggestLakeDepth: model?.lakes.length ? Math.max(0, ...model.lakes.map((l) => l.wetDepth || 0)) : 0,
    };
  }

  document.getElementById('rainBtn').addEventListener('click', toggle);
  document.getElementById('basinsBtn').addEventListener('click', () => setBasins(!showBasins));
  document.getElementById('waterInfoBtn').addEventListener('click', () => {
    setInfoOpen(!document.getElementById('waterInfo').classList.contains('open'));
  });
  document.getElementById('rainCollapseBtn').addEventListener('click', () => {
    const panel = document.getElementById('rainPanel');
    const collapsed = panel.classList.toggle('collapsed');
    const button = document.getElementById('rainCollapseBtn');
    button.setAttribute('aria-expanded', String(!collapsed));
    button.setAttribute('aria-label', collapsed ? 'הגדלת חלונית הגשם' : 'הקטנת חלונית הגשם');
  });
  const opacitySlider = document.getElementById('waterOpacity');
  const applyOpacity = () => {
    waterOpacity = Number(opacitySlider.value) / 100;
    document.getElementById('waterOpacityValue').value = `${opacitySlider.value}%`;
    trailCanvas.style.opacity = String(Math.max(.35, waterOpacity));
  };
  try { const saved = localStorage.getItem(OPACITY_KEY); if (saved !== null) opacitySlider.value = saved; } catch { /* storage unavailable */ }
  applyOpacity();
  opacitySlider.addEventListener('input', () => {
    applyOpacity();
    try { localStorage.setItem(OPACITY_KEY, opacitySlider.value); } catch { /* storage unavailable */ }
    update3D(0);
    api.redraw();
  });
  const slider = document.getElementById('rainAmount');
  try { const saved = localStorage.getItem(RAIN_KEY); if (saved !== null) slider.value = saved; } catch { /* storage unavailable */ }
  slider.addEventListener('input', onAmountInput);
  document.getElementById('rainAmountValue').value = rainLabel(sliderToMillimetres(Number(slider.value)));
  updateUI();

  // Kept for API compatibility with scene.js (terrain changes stop the rain).
  return {
    start, stop, toggle, draw2D, update3D: () => update3D(0), stats, handleMapClick, handleMapHover, setDropMode, terrainChanged,
    get active() { return active; },
    get dropMode() { return dropMode; },
  };
}
