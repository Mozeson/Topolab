import { gridResolution, brushRadiusCells, resampleForMapSize } from './terrain-grid.js';
import { generateTerrain } from './terrain-generator.js';
import { drainLandscape, erodeStreamPower, breachDepressions } from './erosion.js';
import { createSheepGame } from './sheep.js';
import { initPanelSplitter } from './splitter.js';
import { initNavigation } from './nav.js';
import { createMapFeatures } from './map-features.js';
import { createRainSimulation } from './rain.js';
import { createPdfPreviewController } from './pdf-preview.js';
import { createHistory } from './history.js';
import { applyHeightBrush, applySmoothBrush, applySmudgeBrush, applyPinchBrush, applyFlattenBrush, slopePercent, SCULPT_TOOLS, SHAPE_TOOLS } from './brush.js';
import { createAutosave, loadProject, clearProject } from './persistence.js';
import { initShortcuts, SHORTCUTS, HOLD_HINTS, shortcutLabel } from './shortcuts.js';
import { emptyCourse, sanitizeCourse, isRunnable, generateCourse, courseLength, drawCourse, coursePoints, cloneCourse } from './course.js';
import { createNavGame } from './nav-game.js';
import { DEFAULT_ORIGIN, sanitizeOrigin, readCoordinate, formatCoordinate } from './grid-coords.js';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { contours } from 'd3-contour';

const $ = (id) => document.getElementById(id);
const MAP_ZOOM_LEVELS = [1, 1.25, 1.5, 2, 3, 4];
let N = gridResolution(4);
let WORLD_SIZE = 10;

const MIN_HEIGHT = -100;
const MAX_HEIGHT = 200;
const BASE_Y = -4.15;
// Plinth under the terrain model. Sized for the 4 km world and shrunk for smaller maps
// so the 1 km model doesn't sit on a slab a seventh of its width (6/8 km are unchanged).
const plinthScale = () => Math.min(1, WORLD_SIZE / 10);
const plinthBox = () => new THREE.BoxGeometry(WORLD_SIZE + .05 * plinthScale(), .12 * plinthScale(), WORLD_SIZE + .05 * plinthScale());
const EYE_HEIGHT_METERS = 1.7;
const NAV_EYE_HEIGHT_METERS = 2.1; // a little above head height: the game view felt ground-hugging
const OBSERVER_FOV = 65;
let heights = new Float32Array(N * N);
const TOOL_LABELS = { raise: 'הגבהה', lower: 'הנמכה', smooth: 'החלקה', smudge: 'מריחה', pinch: 'צביטה', flatten: 'השטחה', pan: 'הזזת מפה', features: 'תכסית', course: 'מסלול', drop: 'טיפה', waypoint: 'נ״צ' };
const SHAPE_HINTS = {
  smudge: 'גררו: השטח נמרח בכיוון התנועה — מאריכים שלוחה, מזיזים פסגה',
  pinch: 'החזיקו על גיא כדי להצר אותו, על רכס כדי לחדד · Alt: הרחבה ומריחת כיפה',
  flatten: 'מיישר לגובה הנקודה שבה התחלתם — רמה, מדרגה או אוכף',
};
const state = {
  tool: 'raise',          // 'raise' | 'lower' | 'smooth' | 'smudge' | 'pinch' | 'flatten' | 'pan' | 'features' | 'course'
  lastSculptTool: 'raise', // which sculpt tool the "עיצוב" rail button stands for
  flattenTarget: 0,       // height (m) the flatten tool levels to, set when a stroke starts
  course: emptyCourse(),  // orienteering course (course.js)
  gridOrigin: { ...DEFAULT_ORIGIN }, // easting/northing of the map's south-west corner
  waypoints: [],          // נ״צ markers: [{ u, v }]
  coursePlace: 'control', // what a click places with the course tool: 'start' | 'control' | 'finish'
  navigating: false,      // the navigation game owns the screen (nav-game.js)
  tempPan: false,         // space held over the map
  lastFeatureType: 'trail',
  mapSize: 4,
  brush: 1920,            // brush diameter in metres
  localSpacing: 5,        // sample spacing (m) for the 1×1 km detailed map
  strength: 14,
  topo: false,
  focus: null,
  interval: 10,
  scale: 25000,
  exaggeration: 1.6,
  mapView: { zoom: 1, panX: 0, panY: 0 },
  pointer: null,
  drawing: false,
  observerDrag: null,
  observer: { placed: false, firstPerson: false, placing: false, u: .5, v: .5, heading: 0, tilt: -5 },
  exercise: false,
  exerciseBackup: null,
};

const history = createHistory({ limit: 60, onChange: () => updateHistoryButtons() });
let autosave = null;
let updateQueued = false;
let holdTimer = null;
let lastStamp = null;
let lastBrushTime = 0;
let toastTimer = null;
let needsRender = true;
let sheepGame = null;
let navigation = null;
let mapFeatures = null;
let rainSimulation = null;
let lastRandomTerrain = null;
let mapPanDrag = null;
let terrainTint = null; // optional per-cell rgba overlay on the 3D terrain (rain.js)
let areaTint = null;    // land-cover colours under drawn areas (map-features.js); rain overlays win
let courseDrag = null;
let navGame = null;
let lastMapBaseSide = 0;
let wheelZoomDelta = 0;

// ——— Topographic colour model ———
const colorStops = [
  [-100, [70, 119, 119]],
  [-40, [99, 148, 127]],
  [0, [112, 155, 91]],
  [35, [155, 174, 104]],
  [75, [190, 177, 117]],
  [120, [177, 126, 82]],
  [170, [197, 164, 126]],
  [200, [229, 215, 183]],
];

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }

function heightColor(h, editing = false) {
  let i = 0;
  while (i < colorStops.length - 2 && h > colorStops[i + 1][0]) i++;
  const [h0, c0] = colorStops[i];
  const [h1, c1] = colorStops[i + 1];
  const t = clamp((h - h0) / (h1 - h0), 0, 1);
  const c = c0.map((v, k) => lerp(v, c1[k], t));
  if (editing) return c.map((v, k) => lerp(v, [107, 148, 83][k], 0.42));
  return c;
}

function terrainStats() {
  let min = Infinity;
  let max = -Infinity;
  for (const h of heights) { min = Math.min(min, h); max = Math.max(max, h); }
  return { min, max };
}

function contourLevels() {
  const { min, max } = terrainStats();
  const levels = [];
  const start = Math.ceil(min / state.interval) * state.interval;
  for (let v = start; v <= max; v += state.interval) {
    if (v >= MIN_HEIGHT && v <= MAX_HEIGHT) levels.push(v);
  }
  return levels;
}

function countPositiveContourLevels() {
  const { max } = terrainStats();
  if (max < 10) return 0;
  const generator = contours().size([N, N]).smooth(true);
  let count = 0;
  for (let level = 10; level <= Math.min(max, 60); level += 10) {
    const shapes = generator.thresholds([level])(heights);
    if (shapes.some((shape) => shape.coordinates.length > 0)) count++;
  }
  return count;
}

// ——— 2D map and contour rendering ———
const mapCanvas = $('mapCanvas');
const mapCtx = mapCanvas.getContext('2d');
const raster = document.createElement('canvas');
raster.width = N;
raster.height = N;
const rasterCtx = raster.getContext('2d');
let rasterImage = rasterCtx.createImageData(N, N);
let mapDpr = 1;

function resizeMap() {
  const baseSide = mapFitSide();
  if (!baseSide) return;
  if (lastMapBaseSide && lastMapBaseSide !== baseSide) {
    const ratio = baseSide / lastMapBaseSide;
    state.mapView.panX *= ratio;
    state.mapView.panY *= ratio;
  }
  lastMapBaseSide = baseSide;
  clampMapPan(baseSide);
  const side = baseSide * state.mapView.zoom;
  const surface = $('mapSurface');
  surface.style.width = side + 'px';
  surface.style.height = side + 'px';
  applyMapSurfaceTransform(baseSide);
  document.querySelector('.map-scale').style.width = (baseSide / 4) + 'px';
  const rect = mapCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  mapDpr = Math.min(window.devicePixelRatio || 1, 2, 4096 / Math.max(rect.width, rect.height));
  const w = Math.round(rect.width * mapDpr);
  const h = Math.round(rect.height * mapDpr);
  if (mapCanvas.width !== w || mapCanvas.height !== h) {
    mapCanvas.width = w;
    mapCanvas.height = h;
  }
  updateMapScaleText();
  updateMapViewUI();
  drawMap();
}

function hillshade(x, y) {
  const xm = Math.max(0, x - 1);
  const xp = Math.min(N - 1, x + 1);
  const ym = Math.max(0, y - 1);
  const yp = Math.min(N - 1, y + 1);
  const dx = heights[y * N + xp] - heights[y * N + xm];
  const dy = heights[yp * N + x] - heights[ym * N + x];
  return clamp(1 - dx * 0.007 - dy * 0.009, 0.7, 1.22);
}

function drawRaster() {
  if (state.topo) {
    mapCtx.fillStyle = '#fdfcf8';
    mapCtx.fillRect(0, 0, mapCanvas.width, mapCanvas.height);
    return;
  }
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const index = y * N + x;
      const shade = hillshade(x, y);
      const [r, g, b] = heightColor(heights[index], !state.topo);
      const p = index * 4;
      rasterImage.data[p] = clamp(r * shade, 0, 255);
      rasterImage.data[p + 1] = clamp(g * shade, 0, 255);
      rasterImage.data[p + 2] = clamp(b * shade, 0, 255);
      rasterImage.data[p + 3] = 255;
    }
  }
  rasterCtx.putImageData(rasterImage, 0, 0);
  mapCtx.imageSmoothingEnabled = true;
  mapCtx.imageSmoothingQuality = 'high';
  mapCtx.drawImage(raster, 0, 0, mapCanvas.width, mapCanvas.height);
}

function tracePolygon(ctx, polygon) {
  ctx.beginPath();
  for (const ring of polygon) {
    ring.forEach((point, i) => {
      if (i === 0) ctx.moveTo(point[0], point[1]);
      else ctx.lineTo(point[0], point[1]);
    });
    ctx.closePath();
  }
}

function drawContours(ctx, w, h, dpr) {
  const levels = contourLevels();
  if (!levels.length) return;
  const generated = contours().size([N, N]).smooth(true).thresholds(levels)(heights);
  const sx = w / N;
  const sy = h / N;

  ctx.save();
  ctx.scale(sx, sy);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const shape of generated) {
    const major = shape.value % 100 === 0;
    ctx.strokeStyle = major ? 'rgba(116,76,43,.9)' : 'rgba(143,101,65,.64)';
    ctx.lineWidth = (major ? 1.65 : 0.85) / Math.max(sx, sy) * dpr;
    ctx.setLineDash(shape.value < 0 ? [4 / sx * dpr, 3 / sx * dpr] : []);
    for (const polygon of shape.coordinates) {
      tracePolygon(ctx, polygon);
      ctx.stroke();
    }
  }
  ctx.restore();
  ctx.setLineDash([]);

  // A few restrained labels on major contours; never cover the whole map.
  const labels = generated.filter((shape) => shape.value % 100 === 0 && shape.coordinates.length).slice(0, 7);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `600 ${11 * dpr}px Heebo, Arial, sans-serif`;
  for (const shape of labels) {
    const ring = shape.coordinates.flat().sort((a, b) => b.length - a.length)[0];
    if (!ring || ring.length < 8) continue;
    const p = ring[Math.floor(ring.length * 0.43)];
    const x = p[0] * sx;
    const y = p[1] * sy;
    const text = `${shape.value} מ׳`;
    const width = ctx.measureText(text).width + 8 * dpr;
    if (x - width / 2 < 0 || x + width / 2 > w || y < 10 * dpr || y > h - 10 * dpr) continue; // never clip a label at the edge
    ctx.fillStyle = 'rgba(248,246,229,.9)';
    ctx.fillRect(x - width / 2, y - 8 * dpr, width, 16 * dpr);
    ctx.fillStyle = '#51462f';
    ctx.fillText(text, x, y + .5 * dpr);
  }
}

function mapExtentMeters() {
  return state.mapSize * 1000;
}

// Match horizontal and vertical units before applying exaggeration.
function metersToWorld() {
  return WORLD_SIZE / mapExtentMeters();
}

function mapFitSide() {
  const bounds = $('mapWrap').getBoundingClientRect();
  return Math.min(bounds.width, bounds.height);
}

function gridCellMeters() {
  // A reference grid square is 2 cm on a printed map: 500 m at 1:25,000.
  return Math.min(state.scale / 50, mapExtentMeters());
}

function gridCellCount() {
  return Math.max(1, Math.round(mapExtentMeters() / gridCellMeters()));
}

function formatMapDistance(meters) {
  if (meters >= 1000) {
    return `${new Intl.NumberFormat('he-IL', { maximumFractionDigits: 2 }).format(meters / 1000)} ק״מ`;
  }
  return `${Math.round(meters)} מ׳`;
}

// The map can be dragged at any zoom (middle button, Space, the pan tool) and the zoom
// never changes while panning; at least ~35% of the map always stays in view.
function clampMapPan(baseSide = mapFitSide()) {
  const limit = Math.max(0, (baseSide * state.mapView.zoom - baseSide) / 2) + baseSide * .32;
  state.mapView.panX = clamp(state.mapView.panX, -limit, limit);
  state.mapView.panY = clamp(state.mapView.panY, -limit, limit);
}

function positionMapOverlays(baseSide) {
  const bounds = $('mapWrap').getBoundingClientRect();
  const offsetX = Math.max(0, (bounds.width - baseSide) / 2);
  const offsetY = Math.max(0, (bounds.height - baseSide) / 2);
  const north = document.querySelector('.map-north');
  const scale = document.querySelector('.map-scale');
  const mode = $('mapModeLabel');
  const view = $('mapViewLabel');
  const zoomControls = document.querySelector('.map-zoom-controls');
  const infoToggle = $('waterInfoBtn');
  infoToggle.style.right = `${offsetX + 14}px`;
  infoToggle.style.top = `${offsetY + 14}px`;
  north.style.left = `${offsetX + 14}px`;
  north.style.top = `${offsetY + 24}px`; // below the frame and the top coordinate labels
  scale.style.left = `${offsetX + 15}px`;
  scale.style.bottom = `${offsetY + 14}px`;
  mode.style.right = `${offsetX + 14}px`;
  mode.style.top = `${offsetY + 14}px`;
  view.style.top = `${offsetY + 14}px`;
  zoomControls.style.right = `${offsetX + 14}px`;
  zoomControls.style.bottom = `${offsetY + 14}px`;
}

function applyMapSurfaceTransform(baseSide = mapFitSide()) {
  clampMapPan(baseSide);
  $('mapSurface').style.transform = `translate(-50%, -50%) translate(${state.mapView.panX}px, ${state.mapView.panY}px)`;
  positionMapOverlays(baseSide);
}

function updateMapViewUI() {
  const zoomPct = Math.round(state.mapView.zoom * 100);
  const scale = `1:${state.scale.toLocaleString('en-US')}`;
  const spacing = mapExtentMeters() / (N - 1);
  const spacingText = spacing < 10 ? Number(spacing.toFixed(1)) : Math.round(spacing);
  $('mapViewLabel').textContent = `קנה מידה ${scale} · זום ${zoomPct}% · דגימה כל ${spacingText} מ׳`;
  $('mapZoomOutBtn').disabled = state.mapView.zoom <= MAP_ZOOM_LEVELS[0];
  $('mapZoomInBtn').disabled = state.mapView.zoom >= MAP_ZOOM_LEVELS[MAP_ZOOM_LEVELS.length - 1];
  $('centerMapBtn').disabled = state.mapView.zoom === 1 && state.mapView.panX === 0 && state.mapView.panY === 0;
}

function setMapZoom(nextZoom, clientX = null, clientY = null) {
  const zoom = clamp(nextZoom, MAP_ZOOM_LEVELS[0], MAP_ZOOM_LEVELS[MAP_ZOOM_LEVELS.length - 1]);
  if (zoom === state.mapView.zoom) return;
  const wrapBounds = $('mapWrap').getBoundingClientRect();
  const baseSide = mapFitSide();
  const focusX = clientX === null ? wrapBounds.left + wrapBounds.width / 2 : clientX;
  const focusY = clientY === null ? wrapBounds.top + wrapBounds.height / 2 : clientY;
  const viewportCenterX = wrapBounds.left + wrapBounds.width / 2;
  const viewportCenterY = wrapBounds.top + wrapBounds.height / 2;
  const oldSide = baseSide * state.mapView.zoom;
  const oldCenterX = viewportCenterX + state.mapView.panX;
  const oldCenterY = viewportCenterY + state.mapView.panY;
  const u = oldSide ? (focusX - oldCenterX) / oldSide : 0;
  const v = oldSide ? (focusY - oldCenterY) / oldSide : 0;
  const newSide = baseSide * zoom;
  state.mapView.zoom = zoom;
  state.mapView.panX = focusX - u * newSide - viewportCenterX;
  state.mapView.panY = focusY - v * newSide - viewportCenterY;
  resizeMap();
}

function stepMapZoom(direction, clientX = null, clientY = null) {
  const currentIndex = MAP_ZOOM_LEVELS.indexOf(state.mapView.zoom);
  const fallbackIndex = MAP_ZOOM_LEVELS.reduce((best, value, index) => (
    Math.abs(value - state.mapView.zoom) < Math.abs(MAP_ZOOM_LEVELS[best] - state.mapView.zoom) ? index : best
  ), 0);
  const index = currentIndex === -1 ? fallbackIndex : currentIndex;
  const nextIndex = clamp(index + direction, 0, MAP_ZOOM_LEVELS.length - 1);
  setMapZoom(MAP_ZOOM_LEVELS[nextIndex], clientX, clientY);
}

function resetMapView(showMessage = true) {
  state.mapView.zoom = 1;
  state.mapView.panX = 0;
  state.mapView.panY = 0;
  resizeMap();
  if (showMessage) showToast('המפה כולה מוצגת. קנה המידה ונתוני השטח לא השתנו.');
}

function refreshPanCursor() {
  mapCanvas.classList.toggle('pan-mode', isPanning());
}

function setTempPan(enabled) {
  if (state.tempPan === enabled) return;
  state.tempPan = enabled;
  if (enabled) stopDrawing();
  refreshPanCursor();
  drawMap();
}

function updateMapScaleText() {
  $('mapScaleText').textContent = formatMapDistance(mapExtentMeters() / (4 * state.mapView.zoom));
}

function drawGridLines(ctx, w, h, dpr) {
  const count = gridCellCount();
  ctx.save();
  ctx.strokeStyle = 'rgba(74,112,130,.34)';
  ctx.lineWidth = .7 * dpr;
  for (let i = 1; i < count; i++) {
    const x = Math.round(i * w / count) + .5 * dpr;
    const y = Math.round(i * h / count) + .5 * dpr;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  ctx.restore();
  drawMapFrame(ctx, w, h, dpr);
}

// Topographic-map neatline: a band along the edge, alternating black and white for each
// grid square, framed by thin lines (like the margin of a printed 1:50,000 sheet).
const FRAME_BAND = 8;
function drawMapFrame(ctx, w, h, dpr) {
  const count = gridCellCount();
  const t = FRAME_BAND * dpr;
  ctx.save();
  ctx.fillStyle = '#fdfcf8';
  ctx.fillRect(0, 0, w, t); ctx.fillRect(0, h - t, w, t);
  ctx.fillRect(0, 0, t, h); ctx.fillRect(w - t, 0, t, h);
  ctx.fillStyle = '#1d211f';
  for (let i = 0; i < count; i += 2) {
    const x0 = i * w / count;
    const x1 = (i + 1) * w / count;
    ctx.fillRect(x0, 0, x1 - x0, t);
    ctx.fillRect(x0, h - t, x1 - x0, t);
    // Vertical edges count from the south so the pattern matches the northing labels.
    const y1 = h - i * h / count;
    const y0 = h - (i + 1) * h / count;
    ctx.fillRect(0, y0, t, y1 - y0);
    ctx.fillRect(w - t, y0, t, y1 - y0);
  }
  ctx.strokeStyle = '#1d211f';
  ctx.lineWidth = 1.4 * dpr;
  ctx.strokeRect(.7 * dpr, .7 * dpr, w - 1.4 * dpr, h - 1.4 * dpr);
  ctx.lineWidth = 1 * dpr;
  ctx.strokeRect(t, t, w - 2 * t, h - 2 * t);
  ctx.restore();
}

function drawGridLabels(ctx, w, h, dpr) {
  const count = gridCellCount();
  const step = gridCellMeters();
  const cellPixels = w / count;
  const labelEvery = Math.max(1, Math.ceil(68 * dpr / cellPixels));
  const fontSize = 8.5 * dpr;
  ctx.save();
  ctx.font = `500 ${fontSize}px Arial, sans-serif`;
  ctx.fillStyle = '#4e6870';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  const { e: originE, n: originN } = state.gridOrigin;
  const inset = FRAME_BAND * dpr;
  for (let i = 0; i <= count; i++) {
    if (i !== count && i % labelEvery !== 0) continue;
    const value = String(Math.round(originE + i * step));
    const x = clamp(i * w / count, 23 * dpr + inset, w - 23 * dpr - inset);
    const width = ctx.measureText(value).width + 5 * dpr;
    for (const y of [10 * dpr + inset, h - 10 * dpr - inset]) {
      ctx.fillStyle = 'rgba(253,252,248,.94)';
      ctx.fillRect(x - width / 2, y - 6 * dpr, width, 12 * dpr);
      ctx.fillStyle = '#4e6870';
      ctx.fillText(value, x, y);
    }
  }
  for (let i = 0; i <= count; i++) {
    if (i !== count && i % labelEvery !== 0) continue;
    const value = String(Math.round(originN + (count - i) * step));
    const y = clamp(i * h / count, 10 * dpr + inset, h - 10 * dpr - inset);
    const width = ctx.measureText(value).width + 5 * dpr;
    for (const side of ['left', 'right']) {
      const left = side === 'left';
      const x = left ? 4 * dpr + inset : w - 4 * dpr - inset;
      ctx.fillStyle = 'rgba(253,252,248,.94)';
      ctx.fillRect(left ? inset : w - width - inset, y - 6 * dpr, width, 12 * dpr);
      ctx.fillStyle = '#4e6870';
      ctx.textAlign = left ? 'left' : 'right';
      ctx.fillText(value, x, y);
    }
  }
  ctx.restore();
}

function isPanning() {
  return state.tool === 'pan' || state.tempPan;
}

function isSculptTool(tool = state.tool) {
  return SCULPT_TOOLS.includes(tool);
}

function drawBrush() {
  if (!state.pointer || !isSculptTool() || isPanning() || rainSimulation?.dropMode) return;
  const { gx, gy } = state.pointer;
  const x = (gx / (N - 1)) * mapCanvas.width;
  const y = (gy / (N - 1)) * mapCanvas.height;
  const radius = state.brush / (2 * mapExtentMeters()) * mapCanvas.width;
  mapCtx.save();
  mapCtx.beginPath();
  mapCtx.arc(x, y, radius, 0, Math.PI * 2);
  const effective = state.drawing ? state.strokeTool || state.tool : state.tool;
  mapCtx.fillStyle = { raise: 'rgba(238,248,217,.12)', lower: 'rgba(238,184,151,.13)', smudge: 'rgba(214,190,240,.16)', pinch: 'rgba(250,206,120,.16)', expand: 'rgba(250,206,120,.16)', flatten: 'rgba(255,255,255,.16)' }[effective] || 'rgba(190,220,232,.14)';
  mapCtx.fill();
  mapCtx.lineWidth = 1.6 * mapDpr;
  mapCtx.strokeStyle = 'rgba(255,255,244,.94)';
  mapCtx.setLineDash([5 * mapDpr, 4 * mapDpr]);
  mapCtx.stroke();
  mapCtx.setLineDash([]);
  mapCtx.beginPath();
  mapCtx.arc(x, y, 2.4 * mapDpr, 0, Math.PI * 2);
  mapCtx.fillStyle = '#fffdf3';
  mapCtx.fill();
  mapCtx.restore();
}

function observerCanvasGeometry() {
  const observer = state.observer;
  const cx = observer.u * mapCanvas.width;
  const cy = observer.v * mapCanvas.height;
  const angle = observer.heading * Math.PI / 180;
  const dx = Math.sin(angle);
  const dy = -Math.cos(angle);
  const length = clamp(Math.min(mapCanvas.width, mapCanvas.height) * .14, 46 * mapDpr, 74 * mapDpr);
  return { cx, cy, dx, dy, length, tipX: cx + dx * length, tipY: cy + dy * length };
}

function drawObserver() {
  const observer = state.observer;
  if (!observer.placed) return;
  const { cx, cy, dx, dy, length, tipX, tipY } = observerCanvasGeometry();
  const directionAngle = Math.atan2(dy, dx);
  const coneRadius = length * 1.3;
  mapCtx.save();
  mapCtx.beginPath();
  mapCtx.moveTo(cx, cy);
  mapCtx.arc(cx, cy, coneRadius, directionAngle - Math.PI / 6, directionAngle + Math.PI / 6);
  mapCtx.closePath();
  mapCtx.fillStyle = 'rgba(24,63,53,.12)';
  mapCtx.fill();
  mapCtx.strokeStyle = 'rgba(24,63,53,.3)';
  mapCtx.lineWidth = 1 * mapDpr;
  mapCtx.stroke();

  mapCtx.beginPath();
  mapCtx.moveTo(cx, cy);
  mapCtx.lineTo(tipX, tipY);
  mapCtx.strokeStyle = 'rgba(255,253,244,.92)';
  mapCtx.lineWidth = 5 * mapDpr;
  mapCtx.stroke();
  mapCtx.strokeStyle = '#183f35';
  mapCtx.lineWidth = 2.2 * mapDpr;
  mapCtx.stroke();

  const baseX = tipX - dx * 13 * mapDpr;
  const baseY = tipY - dy * 13 * mapDpr;
  const perpX = -dy * 6 * mapDpr;
  const perpY = dx * 6 * mapDpr;
  mapCtx.beginPath();
  mapCtx.moveTo(tipX, tipY);
  mapCtx.lineTo(baseX + perpX, baseY + perpY);
  mapCtx.lineTo(baseX - perpX, baseY - perpY);
  mapCtx.closePath();
  mapCtx.fillStyle = '#183f35';
  mapCtx.fill();

  mapCtx.beginPath();
  mapCtx.arc(cx, cy, 14 * mapDpr, 0, Math.PI * 2);
  mapCtx.fillStyle = '#fffdf4';
  mapCtx.fill();
  mapCtx.lineWidth = 2.4 * mapDpr;
  mapCtx.strokeStyle = '#183f35';
  mapCtx.stroke();
  mapCtx.fillStyle = '#183f35';
  mapCtx.beginPath();
  mapCtx.arc(cx, cy - 4 * mapDpr, 3 * mapDpr, 0, Math.PI * 2);
  mapCtx.fill();
  mapCtx.beginPath();
  mapCtx.arc(cx, cy + 7 * mapDpr, 6 * mapDpr, Math.PI, 0);
  mapCtx.fill();

  mapCtx.beginPath();
  mapCtx.arc(tipX, tipY, 7 * mapDpr, 0, Math.PI * 2);
  mapCtx.fillStyle = '#d16c45';
  mapCtx.fill();
  mapCtx.lineWidth = 2 * mapDpr;
  mapCtx.strokeStyle = '#fffdf4';
  mapCtx.stroke();
  mapCtx.restore();
}

function observerHitTest(event) {
  if (!state.observer.placed) return null;
  const rect = mapCanvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) * mapCanvas.width / rect.width;
  const y = (event.clientY - rect.top) * mapCanvas.height / rect.height;
  const { cx, cy, tipX, tipY } = observerCanvasGeometry();
  if (Math.hypot(x - tipX, y - tipY) <= 20 * mapDpr) return 'rotate';
  if (Math.hypot(x - cx, y - cy) <= 22 * mapDpr) return 'move';
  return null;
}

function sampleHeight(u, v) {
  const gx = clamp(u, 0, 1) * (N - 1);
  const gy = clamp(v, 0, 1) * (N - 1);
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const x1 = Math.min(N - 1, x0 + 1);
  const y1 = Math.min(N - 1, y0 + 1);
  const tx = gx - x0;
  const ty = gy - y0;
  const top = lerp(heights[y0 * N + x0], heights[y0 * N + x1], tx);
  const bottom = lerp(heights[y1 * N + x0], heights[y1 * N + x1], tx);
  return lerp(top, bottom, ty);
}

// Height (m) on the rendered terrain surface: the mesh splits each grid cell into the
// triangles (x,y)-(x,y+1)-(x+1,y) and (x+1,y)-(x,y+1)-(x+1,y+1), so things laid on the
// ground (roads in the navigation game) use the same interpolation and never sink into it.
function surfaceHeight(u, v) {
  const gx = clamp(u, 0, 1) * (N - 1);
  const gy = clamp(v, 0, 1) * (N - 1);
  const x0 = Math.min(N - 2, Math.floor(gx));
  const y0 = Math.min(N - 2, Math.floor(gy));
  const fx = gx - x0;
  const fy = gy - y0;
  const a = heights[y0 * N + x0];
  const b = heights[y0 * N + x0 + 1];
  const c = heights[(y0 + 1) * N + x0];
  const d = heights[(y0 + 1) * N + x0 + 1];
  if (fx + fy <= 1) return a + (b - a) * fx + (c - a) * fy;
  return d + (c - d) * (1 - fx) + (b - d) * (1 - fy);
}

function drawMap() {
  if (!mapCanvas.width || !mapCanvas.height) return;
  mapCtx.clearRect(0, 0, mapCanvas.width, mapCanvas.height);
  drawRaster();
  if (state.topo) {
    drawGridLines(mapCtx, mapCanvas.width, mapCanvas.height, mapDpr);
    drawContours(mapCtx, mapCanvas.width, mapCanvas.height, mapDpr);
    drawGridLabels(mapCtx, mapCanvas.width, mapCanvas.height, mapDpr);
  }
  rainSimulation?.draw2D(mapCtx, mapCanvas, mapDpr);
  mapFeatures?.draw2D(mapCtx, mapCanvas, mapDpr);
  if (state.course.start) {
    mapCtx.save();
    if (state.tool !== 'course') mapCtx.globalAlpha = .55;
    drawCourse(mapCtx, state.course, { width: mapCanvas.width, height: mapCanvas.height, dpr: mapDpr });
    mapCtx.restore();
  }
  drawWaypoints(mapCtx, mapCanvas.width, mapCanvas.height, mapDpr);
  sheepGame?.draw(mapCtx, mapCanvas, mapDpr);
  drawObserver();
  if (!sheepGame?.placing && !state.observer.placing && !state.observerDrag && (!state.observer.firstPerson || state.drawing)) drawBrush();
}

// Same terrain data as the editor, composed independently for the PDF options.
function drawPrintBlock(ctx, w, h, dpr, options = {}) {
  ctx.fillStyle = '#fdfcf8';
  ctx.fillRect(0, 0, w, h);
  if (options.mapStyle !== 'contours') {
    const printRaster = document.createElement('canvas');
    printRaster.width = N;
    printRaster.height = N;
    const printRasterCtx = printRaster.getContext('2d');
    const image = printRasterCtx.createImageData(N, N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const index = y * N + x;
        const shade = options.mapStyle === 'shaded' ? hillshade(x, y) : 1;
        const [red, green, blue] = heightColor(heights[index], false);
        const pixel = index * 4;
        image.data[pixel] = clamp(red * shade, 0, 255);
        image.data[pixel + 1] = clamp(green * shade, 0, 255);
        image.data[pixel + 2] = clamp(blue * shade, 0, 255);
        image.data[pixel + 3] = 255;
      }
    }
    printRasterCtx.putImageData(image, 0, 0);
    ctx.save();
    ctx.globalAlpha = clamp(options.tintOpacity ?? .85, 0, 1);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(printRaster, 0, 0, w, h);
    ctx.restore();
  }
  if (options.showGrid !== false) drawGridLines(ctx, w, h, dpr);
  else {
    ctx.save();
    ctx.strokeStyle = 'rgba(55,76,80,.78)';
    ctx.lineWidth = 1.1 * dpr;
    ctx.strokeRect(1 * dpr, 1 * dpr, w - 2 * dpr, h - 2 * dpr);
    ctx.restore();
  }
  drawContours(ctx, w, h, dpr);
  if (options.showCoordinates !== false) drawGridLabels(ctx, w, h, dpr);
  if (options.showFeatures !== false) mapFeatures?.draw2D(ctx, { width: w, height: h }, dpr, false);
  if (options.showFeatures !== false) drawWaypoints(ctx, w, h, dpr);
}

// ——— Three.js terrain model ———
let renderer;
let scene;
let camera;
let controls;
let terrainGeometry;
let terrainMesh;
let terrainMaterial;
let skirtGeometry;
let contourUniforms;
let groundMesh;
let baseMesh;
let skirtMesh;
let sunLight;
const sceneContainer = $('sceneContainer');
const defaultCamera = new THREE.Vector3(13.6, 11.2, 14.8);
// "מבט במרחב" display layers (the layers popover over the 3D view), saved per browser.
const VIEW3D_KEY = 'topolab-view3d';
const view3d = { contours: false, grid: false, strata: true, shadows: true, autoRotate: false };
try { Object.assign(view3d, JSON.parse(localStorage.getItem(VIEW3D_KEY) || '{}')); } catch { /* storage unavailable */ }
let shadowCatcher = null;
let fillLight = null;
let hemiLight = null;
// Night navigation (nav-game.js + sky.js) recolours the fog; the drone only moves it out.
let gameFog = null; // { color: [r, g, b] sRGB, scale } or null for the daytime haze
let skirtUniforms = null;
const defaultTarget = new THREE.Vector3(0, -0.45, 0);
let savedOrbitPosition = null;
let savedOrbitTarget = null;
let perimeter = [];

function rebuildPerimeter() {
  perimeter = [];
  for (let x = 0; x < N - 1; x++) perimeter.push([x, 0], [x + 1, 0]);
  for (let y = 0; y < N - 1; y++) perimeter.push([N - 1, y], [N - 1, y + 1]);
  for (let x = N - 1; x > 0; x--) perimeter.push([x, N - 1], [x - 1, N - 1]);
  for (let y = N - 1; y > 0; y--) perimeter.push([0, y], [0, y - 1]);
}
rebuildPerimeter();

function gridPosition(x, y) {
  const cell = WORLD_SIZE / (N - 1);
  return [-WORLD_SIZE / 2 + x * cell, -WORLD_SIZE / 2 + y * cell];
}

function createTerrainGeometry() {
  const positions = new Float32Array(N * N * 3);
  const colors = new Float32Array(N * N * 3);
  const meterValues = new Float32Array(N * N);
  const uvs = new Float32Array(N * N * 2);
  const indices = [];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const [wx, wz] = gridPosition(x, y);
      positions[i * 3] = wx;
      positions[i * 3 + 2] = wz;
      uvs[i * 2] = x / (N - 1);
      uvs[i * 2 + 1] = y / (N - 1);
      if (x < N - 1 && y < N - 1) {
        const a = i, b = i + 1, c = i + N, d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('aHeight', new THREE.BufferAttribute(meterValues, 1).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

// The model's sides look like a geology block model: horizontal rock layers of varying
// thickness and colour, fixed in metres so they line up all the way round.
function installStrataShader(material) {
  skirtUniforms = { uStrata: { value: 1 }, uWorldToMeters: { value: 400 }, uVerticalScale: { value: 1.6 } };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, skirtUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSidePos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSidePos = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vSidePos;
        uniform float uStrata;
        uniform float uWorldToMeters;
        uniform float uVerticalScale;
        float sideHash(float n) { return fract(sin(n * 91.345) * 47453.5453); }
      `)
      .replace('#include <color_fragment>', `#include <color_fragment>
        if (uStrata > 0.5) {
          // Depth in real metres (undo the vertical exaggeration), with a gentle tilt.
          float along = vSidePos.x + vSidePos.z;
          float m = vSidePos.y * uWorldToMeters / uVerticalScale + along * uWorldToMeters * 0.004;
          float layer = floor(m / 22.0);
          float within = fract(m / 22.0);
          float pick = sideHash(layer);
          vec3 a = vec3(0.80, 0.70, 0.55);
          vec3 b = vec3(0.67, 0.53, 0.40);
          vec3 c = vec3(0.86, 0.80, 0.68);
          vec3 d = vec3(0.55, 0.47, 0.40);
          vec3 rock = pick < 0.3 ? a : pick < 0.55 ? b : pick < 0.8 ? c : d;
          rock *= 0.9 + 0.1 * smoothstep(0.0, 0.12, within) * smoothstep(1.0, 0.85, within);
          diffuseColor.rgb = rock;
        }
      `)
      // The south and east sides face away from the north-west sun; a little self-light
      // keeps the layers readable from every side.
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * 0.38 * uStrata;');
  };
  material.customProgramCacheKey = () => 'skirt-strata-v2';
}

function createSkirtGeometry() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(perimeter.length * 18), 3).setUsage(THREE.DynamicDrawUsage));
  return geometry;
}

function installContourShader(material) {
  contourUniforms = {
    uContours: { value: 0 },
    uInterval: { value: state.interval },
    uDetail: { value: 0 },          // 1 in the navigation game: ground texture for a sense of speed
    uGrid: { value: 0 },            // 1: the map's coordinate grid draped over the model
    uGridCell: { value: 1.25 },     // grid square size in world units
    uHalfWorld: { value: 5 },
    uWorldToMeters: { value: 400 },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, contourUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aHeight;\nvarying float vTerrainHeight;\nvarying vec2 vGroundXZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTerrainHeight = aHeight;\nvGroundXZ = position.xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vTerrainHeight;
        varying vec2 vGroundXZ;
        uniform float uContours;
        uniform float uInterval;
        uniform float uDetail;
        uniform float uWorldToMeters;
        uniform float uGrid;
        uniform float uGridCell;
        uniform float uHalfWorld;
        float groundHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float groundNoise(vec2 p) {
          vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(groundHash(i), groundHash(i + vec2(1.0, 0.0)), f.x), mix(groundHash(i + vec2(0.0, 1.0)), groundHash(i + vec2(1.0, 1.0)), f.x), f.y);
        }
      `)
      .replace('#include <color_fragment>', `#include <color_fragment>
        if (uDetail > 0.5) {
          vec2 m = vGroundXZ * uWorldToMeters;
          float n = groundNoise(m / 30.0) * .6 + groundNoise(m / 9.0) * .3 + groundNoise(m / 3.5) * .1;
          float patches = smoothstep(.35, .75, groundNoise(m / 90.0 + 7.3));
          diffuseColor.rgb *= .82 + n * .34;
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.08, 1.02, .82), patches * .35);
        }
        if (uGrid > 0.5) {
          vec2 g = (vGroundXZ + uHalfWorld) / uGridCell;
          vec2 gw = max(fwidth(g), vec2(0.0001));
          vec2 gd = abs(fract(g + 0.5) - 0.5) / gw;
          float gridLine = 1.0 - smoothstep(0.6, 1.6, min(gd.x, gd.y));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.27, 0.36), gridLine * 0.55);
        }
        if (uContours > 0.5) {
          float coord = vTerrainHeight / uInterval;
          // Perfectly flat ground lying exactly on a contour level is not a line.
          float hasSlope = step(1e-5, fwidth(vTerrainHeight));
          float fw = max(fwidth(coord), 0.0001);
          float distToLine = abs(fract(coord + 0.5) - 0.5);
          float line = 1.0 - smoothstep(fw * 0.35, fw * 1.35, distToLine);
          float majorCoord = vTerrainHeight / 100.0;
          float majorFw = max(fwidth(majorCoord), 0.0001);
          float majorDist = abs(fract(majorCoord + 0.5) - 0.5);
          float majorLine = 1.0 - smoothstep(majorFw * 0.35, majorFw * 1.25, majorDist);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.24, 0.22, 0.15), line * 0.62 * hasSlope);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.17, 0.12), majorLine * 0.78 * hasSlope);
        }
      `);
  };
  material.customProgramCacheKey = () => 'terrain-contour-v4';
}

function initThree() {
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.96;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.setAttribute('aria-label', 'דגם תלת־ממדי של פני השטח. גררו לסיבוב וצבטו לשינוי מרחק.');
    renderer.domElement.setAttribute('role', 'img');
    renderer.domElement.setAttribute('tabindex', '0');
    sceneContainer.prepend(renderer.domElement);

    scene = new THREE.Scene();
    scene.background = makeSkyTexture();
    scene.fog = new THREE.Fog(0xe4ebe3, 31, 72);
    camera = new THREE.PerspectiveCamera(43, 1, 0.1, 180);
    camera.position.copy(defaultCamera);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(defaultTarget);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 9;
    controls.maxDistance = 30;
    controls.maxPolarAngle = Math.PI / 2.08;
    controls.minPolarAngle = 0.04;
    controls.addEventListener('start', () => $('orbitHint').classList.add('dismissed'));
    controls.addEventListener('change', () => { needsRender = true; });
    controls.update();

    // Cartographic lighting: the sun from the north-west (north is -z), fairly low so the
    // relief reads clearly, plus a soft sky fill and a faint counter-light from the south-east.
    hemiLight = new THREE.HemisphereLight(0xf2f5ff, 0x5a6650, 1.15);
    scene.add(hemiLight);
    fillLight = new THREE.DirectionalLight(0xdfe8ff, .35);
    fillLight.position.set(10, 8, 9);
    scene.add(fillLight);
    sunLight = new THREE.DirectionalLight(0xfff1d6, 2.6);
    sunLight.position.set(-10, 13, -9);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(2048, 2048);
    sunLight.shadow.camera.left = -10;
    sunLight.shadow.camera.right = 10;
    sunLight.shadow.camera.top = 10;
    sunLight.shadow.camera.bottom = -10;
    sunLight.shadow.camera.near = 1;
    sunLight.shadow.camera.far = 42;
    sunLight.shadow.bias = -0.00035;
    sunLight.shadow.normalBias = 0.035;
    scene.add(sunLight);

    groundMesh = new THREE.Mesh(
      new THREE.CircleGeometry(150, 80).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0xd9e0d3, roughness: 1 }),
    );
    groundMesh.position.y = BASE_Y - .05;
    groundMesh.visible = false; // the navigation game shows it; the model view uses a shadow only
    scene.add(groundMesh);
    // A soft shadow under the model instead of a grey floor.
    shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2), new THREE.ShadowMaterial({ opacity: .22 }));
    shadowCatcher.receiveShadow = true;
    scene.add(shadowCatcher);

    baseMesh = new THREE.Mesh(
      plinthBox(),
      new THREE.MeshStandardMaterial({ color: 0x3b3a35, roughness: .7, metalness: .05 }),
    );
    baseMesh.position.y = BASE_Y - .18;
    baseMesh.castShadow = true;
    baseMesh.receiveShadow = true;
    scene.add(baseMesh);

    terrainGeometry = createTerrainGeometry();
    terrainMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .91, metalness: 0 });
    installContourShader(terrainMaterial);
    terrainMesh = new THREE.Mesh(terrainGeometry, terrainMaterial);
    terrainMesh.castShadow = true;
    terrainMesh.receiveShadow = true;
    scene.add(terrainMesh);

    skirtGeometry = createSkirtGeometry();
    const skirtMaterial = new THREE.MeshStandardMaterial({ color: 0x8a7a63, roughness: 1, side: THREE.DoubleSide }); // side walls face both ways
    installStrataShader(skirtMaterial);
    skirtMesh = new THREE.Mesh(skirtGeometry, skirtMaterial);
    skirtMesh.castShadow = true;
    skirtMesh.receiveShadow = true;
    scene.add(skirtMesh);

    const resizeObserver = new ResizeObserver(resizeThree);
    resizeObserver.observe(sceneContainer);
    resizeThree();
    applyView3d();
    updateTerrain();
    resetCamera();
    let lastFrameTime = performance.now();
    renderer.setAnimationLoop(() => {
      const now = performance.now();
      const dt = Math.min((now - lastFrameTime) / 1000, .1);
      lastFrameTime = now;
      if (navGame?.active) {
        navGame.frame(dt);
      } else {
        const axes = navigation?.frame();
        if (axes?.active) applyNavigation(axes, dt);
      }
      const moved = state.observer.firstPerson ? false : controls.update();
      if (moved || needsRender) updateCompass();
      if (moved || needsRender) {
        renderer.render(scene, camera);
        needsRender = false;
      }
    });
    $('scenePoster').hidden = true;
    window.__SCENE_READY__ = true;
  } catch (error) {
    console.error('3D initialization failed', error);
    const poster = $('scenePoster');
    poster.querySelector('span').textContent = 'התצוגה התלת־ממדית אינה זמינה במכשיר זה. עריכת המפה עדיין פעילה.';
    window.__SCENE_READY__ = true;
  }
}

function resizeThree() {
  if (!renderer || !camera) return;
  const width = sceneContainer.clientWidth;
  const height = sceneContainer.clientHeight;
  if (!width || !height) return;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.fov = state.observer.firstPerson ? (state.observer.drone ? state.observer.fov || 74 : OBSERVER_FOV) : camera.aspect < 0.85 ? 52 : 43;
  camera.near = state.observer.firstPerson ? metersToWorld() * .3 : .1;
  camera.updateProjectionMatrix();
  if (scene) renderer.render(scene, camera);
  needsRender = false;
}

async function capture3DForPdf(view = 'isometric') {
  if (!scene || !camera) throw new Error('The 3D scene is not ready.');
  const captureWidth = 1600;
  const captureHeight = 1000;
  const captureRenderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false });
  captureRenderer.setPixelRatio(1);
  captureRenderer.setSize(captureWidth, captureHeight, false);
  captureRenderer.outputColorSpace = THREE.SRGBColorSpace;
  captureRenderer.toneMapping = THREE.ACESFilmicToneMapping;
  captureRenderer.toneMappingExposure = 0.96;
  captureRenderer.shadowMap.enabled = true;
  captureRenderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const captureCamera = camera.clone();
  captureCamera.aspect = captureWidth / captureHeight;
  captureCamera.near = .1;
  captureCamera.far = 180;
  if (view === 'isometric') {
    captureCamera.position.set(WORLD_SIZE * 1.4, WORLD_SIZE * 1.05, WORLD_SIZE * 1.45);
    captureCamera.up.set(0, 1, 0);
    captureCamera.lookAt(0, -.2, 0);
  } else if (view === 'top') {
    captureCamera.position.set(0, WORLD_SIZE * 2.1, .001);
    captureCamera.up.set(0, 0, -1);
    captureCamera.lookAt(0, 0, 0);
  }
  captureCamera.updateProjectionMatrix();
  captureCamera.updateMatrixWorld(true);
  scene.updateMatrixWorld(true);
  captureRenderer.render(scene, captureCamera);
  const image = captureRenderer.domElement.toDataURL('image/jpeg', .94);
  captureRenderer.dispose();
  captureRenderer.forceContextLoss();
  return image;
}

function updateSkirt() {
  if (!skirtGeometry) return;
  const array = skirtGeometry.attributes.position.array;
  const { min } = terrainStats();
  const k = plinthScale();
  // A deep block so the rock layers on the sides are visible (geology block-model look).
  const bottom = Math.min(-1.1 * k, min * metersToWorld() * state.exaggeration - .9 * k);
  if (baseMesh) baseMesh.position.y = bottom - 0.06 * k;
  if (groundMesh) groundMesh.position.y = bottom - 0.24 * k;
  if (shadowCatcher) shadowCatcher.position.y = bottom - 0.12 * k - .002;
  let offset = 0;
  const put = (x, y, z) => { array[offset++] = x; array[offset++] = y; array[offset++] = z; };
  for (let i = 0; i < perimeter.length; i += 2) {
    const a = perimeter[i];
    const b = perimeter[i + 1];
    const [ax, az] = gridPosition(a[0], a[1]);
    const [bx, bz] = gridPosition(b[0], b[1]);
    const ay = heights[a[1] * N + a[0]] * metersToWorld() * state.exaggeration;
    const by = heights[b[1] * N + b[0]] * metersToWorld() * state.exaggeration;
    put(ax, ay, az); put(ax, bottom, az); put(bx, by, bz);
    put(bx, by, bz); put(ax, bottom, az); put(bx, bottom, bz);
  }
  skirtGeometry.attributes.position.needsUpdate = true;
  skirtGeometry.computeVertexNormals();
  skirtGeometry.computeBoundingSphere();
}

// Relief-model shading baked into the vertex colours: valleys a little darker, ridges a
// little lighter (curvature), and bare rock showing on steep slopes.
const ROCK = [.62, .57, .5];
function reliefShade(i, cellM) {
  const x = i % N;
  const y = (i - x) / N;
  const h = heights[i];
  const left = heights[y * N + Math.max(0, x - 1)];
  const right = heights[y * N + Math.min(N - 1, x + 1)];
  const up = heights[Math.max(0, y - 1) * N + x];
  const down = heights[Math.min(N - 1, y + 1) * N + x];
  const curvature = (left + right + up + down - 4 * h) / cellM; // > 0 in valleys
  const slope = Math.hypot(right - left, down - up) / (2 * cellM);
  return { shade: clamp(1 - curvature * 1.6, .8, 1.08), rock: clamp((slope - .28) / .35, 0, .7) };
}

function updateTerrain() {
  if (!terrainGeometry) return;
  const cellM = mapExtentMeters() / (N - 1);
  const positions = terrainGeometry.attributes.position;
  const colors = terrainGeometry.attributes.color;
  const meterValues = terrainGeometry.attributes.aHeight;
  for (let i = 0; i < heights.length; i++) {
    const h = heights[i];
    positions.array[i * 3 + 1] = h * metersToWorld() * state.exaggeration;
    meterValues.array[i] = h;
    let [r, g, b] = heightColor(h, !state.topo && !state.navigating).map((v) => v / 255);
    const relief = reliefShade(i, cellM);
    r = (r + (ROCK[0] - r) * relief.rock) * relief.shade;
    g = (g + (ROCK[1] - g) * relief.rock) * relief.shade;
    b = (b + (ROCK[2] - b) * relief.rock) * relief.shade;
    if (areaTint && areaTint.length === heights.length * 4) {
      const a = areaTint[i * 4 + 3];
      if (a > 0) {
        r += (areaTint[i * 4] - r) * a;
        g += (areaTint[i * 4 + 1] - g) * a;
        b += (areaTint[i * 4 + 2] - b) * a;
      }
    }
    if (terrainTint && !state.navigating) {
      // Overlay colour per cell (drainage basins, a drop's catchment): rgba in 0..1.
      const a = terrainTint[i * 4 + 3];
      if (a > 0) {
        r += (terrainTint[i * 4] - r) * a;
        g += (terrainTint[i * 4 + 1] - g) * a;
        b += (terrainTint[i * 4 + 2] - b) * a;
      }
    }
    const color = new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
    colors.array[i * 3] = color.r;
    colors.array[i * 3 + 1] = color.g;
    colors.array[i * 3 + 2] = color.b;
  }
  positions.needsUpdate = true;
  colors.needsUpdate = true;
  meterValues.needsUpdate = true;
  terrainGeometry.computeVertexNormals();
  terrainGeometry.computeBoundingSphere();
  updateSkirt();
  if (skirtUniforms) {
    skirtUniforms.uStrata.value = view3d.strata && !state.navigating ? 1 : 0;
    skirtUniforms.uWorldToMeters.value = 1 / metersToWorld();
    skirtUniforms.uVerticalScale.value = state.exaggeration;
  }
  if (contourUniforms) {
    contourUniforms.uContours.value = (state.topo || view3d.contours) && !state.navigating ? 1 : 0;
    contourUniforms.uGrid.value = view3d.grid && !state.navigating ? 1 : 0;
    contourUniforms.uGridCell.value = gridCellMeters() * metersToWorld();
    contourUniforms.uHalfWorld.value = WORLD_SIZE / 2;
    contourUniforms.uInterval.value = state.interval;
    contourUniforms.uDetail.value = state.navigating ? 1 : 0;
    contourUniforms.uWorldToMeters.value = 1 / metersToWorld();
  }
  if (state.observer.firstPerson) updateObserverCamera();
  sheepGame?.update3D();
  mapFeatures?.terrainChanged();
  rainSimulation?.update3D();
  updateBrushRing();
  needsRender = true;
}

// ——— 3D brush preview: a ring draped over the terrain under the map cursor ———
const BRUSH_RING_SEGMENTS = 72;
const BRUSH_RING_COLORS = { raise: 0xfffbe8, lower: 0xffc49e, smooth: 0xbfe6f5, smudge: 0xd9c2ff, pinch: 0xffd27a, expand: 0xffd27a, flatten: 0xffffff };
let brushRing = null;

function updateBrushRing() {
  if (!scene) return;
  if (!brushRing) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(BRUSH_RING_SEGMENTS * 3), 3).setUsage(THREE.DynamicDrawUsage));
    brushRing = new THREE.LineLoop(geometry, new THREE.LineBasicMaterial({ color: BRUSH_RING_COLORS.raise, transparent: true, opacity: .95, depthTest: false }));
    brushRing.renderOrder = 10;
    brushRing.frustumCulled = false;
    brushRing.visible = false;
    scene.add(brushRing);
  }
  const visible = Boolean(state.pointer) && isSculptTool() && !isPanning() && !rainSimulation?.dropMode && !state.observer.firstPerson && !state.observer.placing;
  if (brushRing.visible !== visible) needsRender = true;
  brushRing.visible = visible;
  if (!visible) return;
  const tool = state.drawing ? state.strokeTool || state.tool : state.tool;
  brushRing.material.color.setHex(BRUSH_RING_COLORS[tool] || BRUSH_RING_COLORS.raise);
  const cu = state.pointer.gx / (N - 1);
  const cv = state.pointer.gy / (N - 1);
  const radius = state.brush / (2 * mapExtentMeters());
  const vertical = metersToWorld() * state.exaggeration;
  const positions = brushRing.geometry.attributes.position.array;
  for (let i = 0; i < BRUSH_RING_SEGMENTS; i++) {
    const angle = i / BRUSH_RING_SEGMENTS * Math.PI * 2;
    const u = clamp(cu + Math.cos(angle) * radius, 0, 1);
    const v = clamp(cv + Math.sin(angle) * radius, 0, 1);
    positions[i * 3] = (u - .5) * WORLD_SIZE;
    positions[i * 3 + 1] = sampleHeight(u, v) * vertical + .03;
    positions[i * 3 + 2] = (v - .5) * WORLD_SIZE;
  }
  brushRing.geometry.attributes.position.needsUpdate = true;
  needsRender = true;
}

function updateObserverCamera() {
  const observer = state.observer;
  if (!camera || !observer.placed) return;
  // The rendered terrain is made of triangles; bilinear sampling can sit metres below them on
  // a slope, putting the eye "in" the ground. Use the higher of the two.
  const groundHeight = Math.max(sampleHeight(observer.u, observer.v), surfaceHeight(observer.u, observer.v));
  const eye = state.navigating ? NAV_EYE_HEIGHT_METERS : EYE_HEIGHT_METERS;
  const verticalScale = metersToWorld() * state.exaggeration;
  // Drone mode (nav-game.js): the camera flies at the drone's altitude instead of eye height.
  const flying = observer.drone && Number.isFinite(observer.flyY);
  camera.position.set(
    (observer.u - .5) * WORLD_SIZE,
    flying ? observer.flyY : groundHeight * verticalScale + (eye + (observer.bob || 0)) * metersToWorld(),
    (observer.v - .5) * WORLD_SIZE,
  );
  const heading = observer.heading * Math.PI / 180;
  const tilt = observer.tilt * Math.PI / 180;
  const horizontal = Math.cos(tilt);
  const target = new THREE.Vector3(
    camera.position.x + Math.sin(heading) * horizontal,
    camera.position.y + Math.sin(tilt),
    camera.position.z - Math.cos(heading) * horizontal,
  );
  camera.lookAt(target);
  if (flying) {
    // FPV: bank (roll) around the view axis, a lens that widens with speed, and shake.
    if (observer.roll) camera.rotateZ(-observer.roll * Math.PI / 180);
    if (observer.shake) {
      const amount = observer.shake * metersToWorld();
      camera.position.x += (Math.random() - .5) * amount;
      camera.position.y += (Math.random() - .5) * amount;
      camera.position.z += (Math.random() - .5) * amount;
    }
    if (observer.fov && Math.abs(camera.fov - observer.fov) > .05) {
      camera.fov = observer.fov;
      camera.updateProjectionMatrix();
    }
  }
  needsRender = true;
}

// Keyboard/joystick axes applied once per animation frame; speeds are per second.
const NAV_SPEEDS = { orbitAzimuth: 1.7, orbitPolar: 1.1, dolly: 1.1, turn: 130, tilt: 55, walk: 0.012 };
const navOffset = new THREE.Vector3();
const navSpherical = new THREE.Spherical();

function applyNavigation(axes, dt) {
  if (state.observer.firstPerson && state.observer.placed && camera) {
    const observer = state.observer;
    if (axes.x) observer.heading = (observer.heading + axes.x * NAV_SPEEDS.turn * dt + 360) % 360;
    if (axes.aux) {
      observer.tilt = clamp(observer.tilt + axes.aux * NAV_SPEEDS.tilt * dt, -45, 45);
      $('observerTiltRange').value = String(Math.round(observer.tilt));
      $('observerTiltValue').value = `${Math.round(observer.tilt)}°`;
    }
    if (axes.y) {
      const heading = observer.heading * Math.PI / 180;
      observer.u = clamp(observer.u + Math.sin(heading) * axes.y * NAV_SPEEDS.walk * dt, 0, 1);
      observer.v = clamp(observer.v - Math.cos(heading) * axes.y * NAV_SPEEDS.walk * dt, 0, 1);
    }
    updateObserverCamera();
    drawMap();
    return;
  }
  if (!camera || !controls) return;
  if (axes.x || axes.y) {
    navOffset.copy(camera.position).sub(controls.target);
    navSpherical.setFromVector3(navOffset);
    navSpherical.theta -= axes.x * NAV_SPEEDS.orbitAzimuth * dt;
    navSpherical.phi = clamp(navSpherical.phi - axes.y * NAV_SPEEDS.orbitPolar * dt, controls.minPolarAngle + .02, controls.maxPolarAngle - .02);
    navOffset.setFromSpherical(navSpherical);
    camera.position.copy(controls.target).add(navOffset);
    camera.lookAt(controls.target);
    needsRender = true;
  }
  if (axes.aux) {
    navOffset.copy(camera.position).sub(controls.target);
    navSpherical.setFromVector3(navOffset);
    navSpherical.radius = clamp(navSpherical.radius * (1 - axes.aux * NAV_SPEEDS.dolly * dt), controls.minDistance, controls.maxDistance);
    navOffset.setFromSpherical(navSpherical);
    camera.position.copy(controls.target).add(navOffset);
    camera.lookAt(controls.target);
    needsRender = true;
  }
}

function updateObserverUI() {
  const observer = state.observer;
  const button = $('observerBtn');
  $('removeObserverBtn').hidden = !observer.placed;
  button.classList.toggle('active', observer.placing || observer.firstPerson);
  button.setAttribute('aria-pressed', String(observer.placing || observer.firstPerson));
  button.querySelector('span').textContent = observer.placing
    ? 'ביטול הצבה'
    : observer.firstPerson
      ? 'מבט חיצוני'
      : observer.placed ? 'מבט האדם' : 'הצבת אדם';
  $('sceneKicker').textContent = observer.firstPerson ? 'תצפית מתוך השטח' : 'מבט במרחב';
  $('sceneTitle').textContent = observer.firstPerson ? 'מבט עיניים של האדם' : 'פני השטח בתלת־ממד';
  $('orbitHint').lastChild.textContent = observer.firstPerson
    ? ' גררו את האדם במפה · קצה החץ משנה כיוון'
    : ' גררו כדי לסובב · צבטו כדי לקרב';
  for (const id of ['exaggerationLabel', 'exaggerationRange', 'exaggerationValue', 'exaggerationNote']) $(id).hidden = observer.firstPerson;
  for (const id of ['observerTiltLabel', 'observerTiltRange', 'observerTiltValue']) $(id).hidden = !observer.firstPerson;
  $('observerTiltRange').value = String(observer.tilt);
  $('observerTiltValue').value = `${observer.tilt}°`;
  mapCanvas.classList.toggle('placing-observer', observer.placing);
}

function enterObserver(u = state.observer.u, v = state.observer.v) {
  const observer = state.observer;
  if (camera && controls && !observer.firstPerson) {
    savedOrbitPosition = camera.position.clone();
    savedOrbitTarget = controls.target.clone();
  }
  observer.placed = true;
  observer.firstPerson = true;
  observer.placing = false;
  observer.u = clamp(u, 0, 1);
  observer.v = clamp(v, 0, 1);
  if (controls) controls.enabled = false;
  closePopovers();
  updateObserverUI();
  resizeThree();
  updateObserverCamera();
  drawMap();
}

function exitObserver() {
  const observer = state.observer;
  observer.firstPerson = false;
  observer.placing = false;
  state.observerDrag = null;
  if (controls) controls.enabled = true;
  resizeThree();
  if (camera && controls && savedOrbitPosition && savedOrbitTarget) {
    camera.position.copy(savedOrbitPosition);
    controls.target.copy(savedOrbitTarget);
    controls.update();
  }
  updateObserverUI();
  drawMap();
  needsRender = true;
}

function makeSkyTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, 256);
  gradient.addColorStop(0, '#a9c6dd');
  gradient.addColorStop(.55, '#dbe6e6');
  gradient.addColorStop(1, '#eef0e6');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 4, 256);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// Distance at which the whole model fits the view (both directions, any panel shape).
function fitDistance() {
  const radius = WORLD_SIZE * .74;
  const vfov = THREE.MathUtils.degToRad(camera.fov);
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
  return radius / Math.sin(Math.min(vfov, hfov) / 2);
}

// Compass over the 3D view: the needle shows where north is on screen.
function updateCompass() {
  const needle = $('viewCompassRose');
  if (!needle || !camera || !controls) return;
  const fx = controls.target.x - camera.position.x;
  const fz = controls.target.z - camera.position.z;
  const length = Math.hypot(fx, fz);
  const angle = length < 1e-6 ? 0 : Math.atan2(-fx, -fz) * 180 / Math.PI;
  needle.style.transform = `rotate(${-angle}deg)`;
}

// Turn the view so the given direction points up the screen (like turning a map).
function viewFacing(direction) {
  if (!camera || !controls) return;
  if (state.observer.firstPerson) exitObserver();
  const forward = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] }[direction];
  const offset = camera.position.clone().sub(controls.target);
  const horizontal = Math.max(Math.hypot(offset.x, offset.z), fitDistance() * .45);
  const height = Math.max(offset.y, fitDistance() * .45);
  camera.position.set(controls.target.x - forward[0] * horizontal, controls.target.y + height, controls.target.z - forward[1] * horizontal);
  controls.update();
  needsRender = true;
  updateCompass();
}

function applyView3d() {
  // Shadows stay compiled in (switching castShadow would need every shader rebuilt);
  // turning them "off" just sets their strength to zero.
  if (sunLight) sunLight.shadow.intensity = view3d.shadows ? 1 : 0;
  if (shadowCatcher) shadowCatcher.visible = view3d.shadows && !state.navigating;
  if (controls) {
    controls.autoRotate = view3d.autoRotate && !state.navigating;
    controls.autoRotateSpeed = .7;
  }
  for (const input of document.querySelectorAll('[data-view3d]')) input.checked = Boolean(view3d[input.dataset.view3d]);
  updateTerrain();
  needsRender = true;
}

function setView3d(key, value) {
  view3d[key] = value;
  try { localStorage.setItem(VIEW3D_KEY, JSON.stringify(view3d)); } catch { /* storage unavailable */ }
  applyView3d();
}

function resetCamera() {
  if (state.observer.firstPerson) {
    updateObserverCamera();
    return;
  }
  if (!camera || !controls) return;
  // Oblique view from the south-east (north up-left), framed to fit the model.
  const sizeFactor = state.mapSize / 4;
  camera.position.copy(defaultCamera).normalize().multiplyScalar(fitDistance() * .93);
  controls.target.copy(defaultTarget).multiplyScalar(sizeFactor);
  controls.update();
  needsRender = true;
  updateCompass();
}

function updateSceneForMapSize() {
  const sizeFactor = state.mapSize / 4;
  if (scene?.fog) {
    scene.fog.near = 31 * sizeFactor;
    scene.fog.far = 72 * sizeFactor;
  }
  if (controls) {
    controls.minDistance = 9 * sizeFactor;
    controls.maxDistance = 30 * sizeFactor;
  }
  if (sunLight) {
    sunLight.position.set(-10 * sizeFactor, 13 * sizeFactor, -9 * sizeFactor);
    fillLight?.position.set(10 * sizeFactor, 8 * sizeFactor, 9 * sizeFactor);
    const shadowExtent = 10 * sizeFactor;
    sunLight.shadow.camera.left = -shadowExtent;
    sunLight.shadow.camera.right = shadowExtent;
    sunLight.shadow.camera.top = shadowExtent;
    sunLight.shadow.camera.bottom = -shadowExtent;
    sunLight.shadow.camera.far = 42 * sizeFactor;
    sunLight.shadow.camera.updateProjectionMatrix();
  }
  resetCamera();
}

// Changes the map extent (km) and/or the 1 km map's sample spacing. Heights are
// resampled around the centre unless a snapshot is being restored.
function setMapSize(newSize, restoredHeights = null, localSpacing = state.localSpacing) {
  const nextN = gridResolution(newSize, localSpacing);
  if (!nextN || (newSize === state.mapSize && nextN === N && !restoredHeights)) return;
  stopDrawing();
  rainSimulation?.stop();
  const nextHeights = restoredHeights
    ? new Float32Array(restoredHeights)
    : resampleForMapSize(heights, N, state.mapSize, nextN, newSize);

  const previousMapSize = state.mapSize;
  // The detailed map needs a much smaller brush; remember the regional one for the way back.
  if (newSize === 1 && previousMapSize !== 1) { state.regionalBrush = state.brush; state.brush = 100; }
  if (newSize !== 1 && previousMapSize === 1 && state.regionalBrush) state.brush = state.regionalBrush;
  state.mapSize = newSize;
  state.localSpacing = localSpacing;
  N = nextN;
  WORLD_SIZE = newSize * 2.5;
  heights = nextHeights;
  state.pointer = null;
  state.mapView.zoom = 1;
  state.mapView.panX = 0;
  state.mapView.panY = 0;
  lastStamp = null;
  $('mapSizeSelect').value = String(newSize);
  syncDetailControls();
  hideCursorReadout();

  rebuildPerimeter();
  raster.width = N;
  raster.height = N;
  rasterImage = rasterCtx.createImageData(N, N);
  if (terrainGeometry && terrainMesh) {
    terrainGeometry.dispose();
    terrainGeometry = createTerrainGeometry();
    terrainMesh.geometry = terrainGeometry;
  }
  if (skirtGeometry && skirtMesh) {
    skirtGeometry.dispose();
    skirtGeometry = createSkirtGeometry();
    skirtMesh.geometry = skirtGeometry;
  }
  if (baseMesh) {
    baseMesh.geometry.dispose();
    baseMesh.geometry = plinthBox();
  }
  if (previousMapSize === newSize) mapFeatures?.refreshAreas(); // same extent, new grid
  if (previousMapSize !== newSize) {
    sheepGame?.resize(previousMapSize, newSize);
    mapFeatures?.resize(previousMapSize, newSize);
    // Keep course points on the same ground; drop those that fall off a smaller map.
    const k = previousMapSize / newSize;
    const scalePoint = (p) => {
      if (!p) return null;
      const q = { u: .5 + (p.u - .5) * k, v: .5 + (p.v - .5) * k };
      return q.u >= 0 && q.u <= 1 && q.v >= 0 && q.v <= 1 ? q : null;
    };
    state.waypoints = state.waypoints.map(scalePoint).filter(Boolean);
    state.course = {
      start: scalePoint(state.course.start),
      controls: state.course.controls.map(scalePoint).filter(Boolean),
      finish: scalePoint(state.course.finish),
    };
    updateCourseUI();
  }
  updateSceneForMapSize();
  updateMapScaleText();
  resizeMap();
  scheduleUpdate();
  if (!restoredHeights) {
    showToast(`גודל המפה שונה ל־${newSize}×${newSize} ק״מ. המרכז נשמר; בהקטנת השטח השוליים נחתכים.`, { action: { label: 'ביטול', run: undo } });
  }
}

// The brush is measured in metres, so its limits depend on the map: at least ~4 samples
// across, at most the whole map. The detail selector only exists for the 1×1 km map.
function syncDetailControls() {
  const local = state.mapSize === 1;
  const spacing = mapExtentMeters() / (N - 1);
  $('detailControl').hidden = !local;
  $('detailSelect').value = String(state.localSpacing);
  updateMapViewUI();
  $('localGullyControl').hidden = !local;
  const range = $('brushRange');
  range.min = String(Math.ceil(4 * spacing / 5) * 5);
  range.max = String(mapExtentMeters());
  setBrushSize(state.brush, false);
}

// ——— Shared state updates ———
function updateReadouts() {
  const { max } = terrainStats();
  $('maxHeight').textContent = `שיא ${Math.round(max)} מ׳`;
  if (state.exercise) {
    const lines = countPositiveContourLevels();
    const complete = (max >= 60 ? 1 : 0) + (lines >= 3 ? 1 : 0);
    $('exerciseProgress').textContent = `${complete} מתוך 2`;
  }
}

function scheduleUpdate() {
  rainSimulation?.terrainChanged?.();
  if (updateQueued) return;
  updateQueued = true;
  updateReadouts();
  requestAnimationFrame(() => {
    updateQueued = false;
    updateTerrain();
    drawMap();
  });
}

// ——— History (undo / redo) ———
function pushUndo() {
  history.push(currentSnapshot());
  scheduleSave();
}

// One history for everything on the map: terrain, features (roads/streams) and course.
function currentSnapshot() {
  return {
    heights,
    mapSize: state.mapSize,
    localSpacing: state.localSpacing,
    features: mapFeatures?.serialize() || [],
    course: cloneCourse(state.course),
    waypoints: state.waypoints.map((p) => ({ ...p })),
  };
}

function restoreSnapshot(snapshot) {
  rainSimulation?.stop();
  stopDrawing();
  const spacing = snapshot.localSpacing ?? state.localSpacing;
  if (snapshot.mapSize !== state.mapSize || spacing !== state.localSpacing) setMapSize(snapshot.mapSize, snapshot.heights, spacing);
  else heights.set(snapshot.heights);
  // Features and course are restored after any resize so they land exactly where they were.
  if (snapshot.features && mapFeatures && JSON.stringify(snapshot.features) !== JSON.stringify(mapFeatures.serialize())) {
    mapFeatures.load(snapshot.features);
  }
  if (snapshot.course) {
    state.course = sanitizeCourse(snapshot.course);
    updateCourseUI();
  }
  if (snapshot.waypoints) {
    state.waypoints = snapshot.waypoints.map((p) => ({ ...p }));
    updateWaypointUI();
  }
  scheduleUpdate();
  scheduleSave();
}

function undo() {
  const previous = history.undo(currentSnapshot());
  if (!previous) { showToast('אין פעולה לבטל.'); return; }
  restoreSnapshot(previous);
  showToast('הפעולה האחרונה בוטלה.', { action: { label: 'חזרה', run: redo } });
}

function redo() {
  const next = history.redo(currentSnapshot());
  if (!next) { showToast('אין פעולה לחזור אליה.'); return; }
  restoreSnapshot(next);
  showToast('הפעולה שוחזרה.', { action: { label: 'ביטול', run: undo } });
}

function updateHistoryButtons() {
  $('undoBtn').disabled = !history.canUndo;
  $('redoBtn').disabled = !history.canRedo;
}

// ——— Tools ———
// One active tool at a time. Sculpt tools share the brush options; 'pan' and
// 'features' show their own options group. See docs/ARCHITECTURE.md → "Adding a tool".
function setTool(tool) {
  if (!TOOL_LABELS[tool]) return;
  stopDrawing();
  const previous = state.tool;
  state.tool = tool;
  if (tool !== 'features' && previous === 'features') mapFeatures?.cancel(true);
  if (tool === 'pan' || tool === 'features' || tool === 'course' || tool === 'drop' || tool === 'waypoint') {
    state.observer.placing = false;
    sheepGame?.cancelPlacement?.();
    updateObserverUI();
  }
  if (tool === 'features' && mapFeatures && !mapFeatures.active) mapFeatures.activate(state.lastFeatureType);
  syncToolUI();
}

function syncToolUI() {
  const tool = state.tool;
  for (const button of document.querySelectorAll('.rail-tool[data-tool]')) {
    const active = button.dataset.tool === tool;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  $('sculptOptions').hidden = !isSculptTool(tool);
  $('panOptions').hidden = tool !== 'pan';
  $('featureOptions').hidden = tool !== 'features';
  $('courseOptions').hidden = tool !== 'course';
  $('dropOptions').hidden = tool !== 'drop';
  $('waypointOptions').hidden = tool !== 'waypoint';
  if (tool === 'waypoint') updateWaypointUI();
  rainSimulation?.setDropMode(tool === 'drop');
  if (tool === 'course') updateCourseUI();
  const label = $('toolMode');
  label.textContent = TOOL_LABELS[tool];
  label.className = `options-tool ${tool}`;
  // Every sculpt tool lives under the one "עיצוב" rail button; the mode is picked in the
  // options bar (or from the right-click menu). The button remembers the last mode.
  const sculpting = isSculptTool(tool);
  if (sculpting) state.lastSculptTool = tool;
  const sculptButton = $('sculptBtn');
  sculptButton.dataset.tool = state.lastSculptTool;
  sculptButton.dataset.shortcut = `tool-${state.lastSculptTool}`;
  sculptButton.title = `עיצוב השטח — ${TOOL_LABELS[state.lastSculptTool]} (${shortcutLabel(`tool-${state.lastSculptTool}`)})`;
  sculptButton.classList.toggle('active', sculpting);
  sculptButton.setAttribute('aria-pressed', String(sculpting));
  sculptButton.dataset.mode = state.lastSculptTool;
  $('sculptSub').textContent = TOOL_LABELS[state.lastSculptTool];
  const shaping = SHAPE_TOOLS.includes(tool);
  $('shapeHint').hidden = !shaping;
  $('shapeHint').textContent = SHAPE_HINTS[tool] || '';
  for (const button of document.querySelectorAll('[data-sculpt]')) button.setAttribute('aria-checked', String(button.dataset.sculpt === tool));
  refreshPanCursor();
  updateBrushRing();
  drawMap();
}

// Brush diameter in metres, rounded to the slider's 5 m step and clamped to its range.
function setBrushSize(value, save = true) {
  state.brush = clamp(Math.round(value / 5) * 5, Number($('brushRange').min), Number($('brushRange').max));
  $('brushRange').value = String(state.brush);
  $('brushValue').value = formatMapDistance(state.brush);
  updateBrushRing();
  drawMap();
  if (save) scheduleSave();
}

function setStrength(value) {
  state.strength = clamp(Math.round(value / 2) * 2, Number($('strengthRange').min), Number($('strengthRange').max));
  $('strengthRange').value = String(state.strength);
  $('strengthValue').value = `${state.strength} מ׳/ש׳`;
  scheduleSave();
}

function setTopo(enabled) {
  state.topo = enabled;
  $('topoBtn').setAttribute('aria-checked', String(enabled));
  $('sculptViewBtn').setAttribute('aria-checked', String(!enabled));  $('mapKicker').textContent = enabled ? 'קריאת המפה' : 'משטח עריכה';
  $('mapTitle').textContent = enabled ? 'מפה טופוגרפית' : 'מבט מלמעלה';
  document.querySelector('.map-panel').classList.toggle('topographic', enabled);
  $('intervalControl').hidden = !enabled;
  $('mapLegend').hidden = enabled;
  updateMapScaleText();
  updateTerrain();
  drawMap();
  scheduleSave();
}

function clearHeights(record = true) {
  rainSimulation?.stop();
  if (record) pushUndo();
  heights.fill(0);
  state.pointer = null;
  hideCursorReadout();
  scheduleUpdate();
}

function applyPreset(name) {
  rainSimulation?.stop();
  pushUndo();
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const nx = (x / (N - 1) - .5) * 2;
      const ny = (y / (N - 1) - .5) * 2;
      const r = Math.sqrt(nx * nx + ny * ny);
      let h = 0;
      if (name === 'hill') h = 88 * Math.exp(-r * r * 3.2);
      if (name === 'ridge') h = 92 * Math.exp(-((nx * .75 + ny * .45) ** 2) * 8) * Math.exp(-((nx * .45 - ny) ** 2) * 1.2);
      if (name === 'valley') h = 68 - 118 * Math.exp(-((nx * .7 - ny) ** 2) * 6) * Math.exp(-((nx + ny * .4) ** 2) * .7);
      if (name === 'crater') h = 78 * Math.exp(-((r - .43) ** 2) * 34) - 32 * Math.exp(-r * r * 12);
      heights[y * N + x] = clamp(h, MIN_HEIGHT, MAX_HEIGHT);
    }
  }
  scheduleUpdate();
  showToast({ hill: 'גבעה', ridge: 'רכס', valley: 'עמק', crater: 'מכתש' }[name] + ' נוספה למשטח. אפשר להמשיך ולפסל.', { action: { label: 'ביטול', run: undo } });
}

function applyRandomTerrain(newSeed = false) {
  stopDrawing();
  rainSimulation?.stop();
  if (newSeed) $('terrainSeed').value = crypto.getRandomValues(new Uint32Array(1))[0];
  const seedInput = $('terrainSeed');
  if (!seedInput.checkValidity() || seedInput.value === '') {
    seedInput.reportValidity();
    return;
  }
  const options = { seed: Number(seedInput.value) >>> 0, extentMeters: mapExtentMeters(), gullyWidth: Number($('terrain-gullyWidth').value) };
  for (const name of ['relief', 'variation', 'detail', 'valleys']) {
    options[name] = Number($('terrain-' + name).value);
  }
  pushUndo();
  heights.set(generateTerrain(N, options));
  // Let water shape the noise: open channels, branching valleys, only deep lakes remain.
  options.drainage = Number($('terrain-drainage').value);
  drainLandscape(heights, N, options.drainage, { min: MIN_HEIGHT, max: MAX_HEIGHT });
  lastRandomTerrain = options;
  state.pointer = null;
  scheduleUpdate();
  showToast('נוצרה מפה אקראית. אפשר להגריל שוב או להמשיך לפסל.', { action: { label: 'ביטול', run: undo } });
}

// `seconds` is how long the brush acted; strength is metres per second at the centre.
function applyBrush(gx, gy, seconds, tool = state.tool) {
  const radius = brushRadiusCells(state.brush, mapExtentMeters(), N);
  if (tool === 'smudge') return; // smudge acts on pointer motion only (see pointermove)
  if (tool === 'smooth') {
    // Smoothing rate scales with strength so the slider means the same thing for every tool.
    applySmoothBrush(heights, N, gx, gy, radius, state.strength * seconds * .35);
  } else if (tool === 'pinch' || tool === 'expand') {
    const amount = state.strength * seconds * .012;
    applyPinchBrush(heights, N, gx, gy, radius, tool === 'pinch' ? amount : -amount);
  } else if (tool === 'flatten') {
    applyFlattenBrush(heights, N, gx, gy, radius, state.flattenTarget, state.strength * seconds * .15);
  } else {
    const sign = tool === 'lower' ? -1 : 1;
    applyHeightBrush(heights, N, gx, gy, radius, sign * state.strength * seconds, MIN_HEIGHT, MAX_HEIGHT);
  }
  scheduleUpdate();
}

// Alt flips raise/lower, Shift smooths — read from the pointer event so no key tracking is needed.
function strokeToolFor(event) {
  if (event?.shiftKey) return 'smooth';
  if (event?.altKey && state.tool === 'raise') return 'lower';
  if (event?.altKey && state.tool === 'lower') return 'raise';
  if (event?.altKey && state.tool === 'pinch') return 'expand';
  return state.tool;
}

function applyTimedBrush(gx, gy) {
  const now = performance.now();
  const elapsed = clamp((now - lastBrushTime) / 1000, 0, .15);
  lastBrushTime = now;
  applyBrush(gx, gy, elapsed, state.strokeTool || state.tool);
}

function eventToGrid(event) {
  const rect = mapCanvas.getBoundingClientRect();
  return {
    gx: clamp((event.clientX - rect.left) / rect.width * (N - 1), 0, N - 1),
    gy: clamp((event.clientY - rect.top) / rect.height * (N - 1), 0, N - 1),
  };
}

// ——— Waypoints (נקודות ציון): a marker and its grid coordinate, read to 100 m ———
function waypointText(point) {
  return formatCoordinate(readCoordinate(point.u, point.v, mapExtentMeters(), state.gridOrigin));
}

function drawWaypoints(ctx, w, h, dpr) {
  if (!state.waypoints.length) return;
  ctx.save();
  ctx.font = `700 ${11 * dpr}px Arial, sans-serif`;
  ctx.textBaseline = 'middle';
  state.waypoints.forEach((point, index) => {
    const x = point.u * w;
    const y = point.v * h;
    const r = 6 * dpr;
    for (const [color, width] of [['#fff', 4], ['#8a3f7d', 2]]) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width * dpr;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.moveTo(x - r * 1.8, y); ctx.lineTo(x - r * .5, y);
      ctx.moveTo(x + r * .5, y); ctx.lineTo(x + r * 1.8, y);
      ctx.moveTo(x, y - r * 1.8); ctx.lineTo(x, y - r * .5);
      ctx.moveTo(x, y + r * .5); ctx.lineTo(x, y + r * 1.8);
      ctx.stroke();
    }
    const text = `${index + 1}  ${waypointText(point)}`;
    const width = ctx.measureText(text).width + 10 * dpr;
    // Keep the label inside the map: flip to the left near the east edge.
    const left = x + r * 2 + width > w - 8 * dpr ? x - r * 2 - width : x + r * 2;
    const top = clamp(y - 9 * dpr, 8 * dpr, h - 26 * dpr);
    ctx.fillStyle = 'rgba(255,255,255,.93)';
    ctx.strokeStyle = '#8a3f7d';
    ctx.lineWidth = 1.2 * dpr;
    ctx.beginPath();
    ctx.roundRect(left, top, width, 18 * dpr, 5 * dpr);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#5b2752';
    ctx.textAlign = 'left';
    ctx.fillText(text, left + 5 * dpr, top + 9.5 * dpr);
  });
  ctx.restore();
}

function updateWaypointUI(pointer = null) {
  const live = $('waypointLive');
  if (pointer) {
    const point = { u: pointer.gx / (N - 1), v: pointer.gy / (N - 1) };
    live.textContent = `${waypointText(point)} · ${Math.round(sampleHeight(point.u, point.v))} מ׳`;
  } else if (state.waypoints.length) {
    const last = state.waypoints[state.waypoints.length - 1];
    live.textContent = `${state.waypoints.length}: ${waypointText(last)}`;
  } else live.textContent = 'העבירו את הסמן על המפה';
  $('undoWaypointBtn').disabled = !state.waypoints.length;
  $('clearWaypointsBtn').disabled = !state.waypoints.length;
}

function addWaypoint(next) {
  pushUndo();
  const point = { u: clamp(next.gx / (N - 1), 0, 1), v: clamp(next.gy / (N - 1), 0, 1) };
  state.waypoints.push(point);
  if (state.waypoints.length > 40) state.waypoints.shift();
  updateWaypointUI();
  drawMap();
  scheduleSave();
  showToast(`נקודה ${state.waypoints.length}: נ״צ ${waypointText(point)} (צפון/מזרח) · גובה ${Math.round(sampleHeight(point.u, point.v))} מ׳`);
}

function removeLastWaypoint() {
  if (!state.waypoints.length) return;
  pushUndo();
  state.waypoints.pop();
  updateWaypointUI();
  drawMap();
  scheduleSave();
}

function clearWaypoints() {
  if (!state.waypoints.length) return;
  pushUndo();
  state.waypoints = [];
  updateWaypointUI();
  drawMap();
  scheduleSave();
  showToast('נקודות הציון נמחקו.', { action: { label: 'ביטול', run: undo } });
}

// ——— Grid origin (the "#" card in the map footer) ———
function syncGridOriginInputs() {
  $('gridOriginE').value = String(state.gridOrigin.e);
  $('gridOriginN').value = String(state.gridOrigin.n);
}

function setGridOrigin(origin, message = true) {
  state.gridOrigin = sanitizeOrigin(origin);
  syncGridOriginInputs();
  drawMap();
  updateWaypointUI();
  scheduleSave();
  if (message) showToast(`רשת הקואורדינטות מתחילה עכשיו ב־${state.gridOrigin.n}/${state.gridOrigin.e} (צפון/מזרח) בפינה הדרומית־מערבית.`);
}

// ——— Orienteering course planning (course tool) ———
// Click places the selected kind of point; dragging an existing point moves it.
// Without a finish the course returns to the start (a loop).
function courseHitTest(event) {
  const rect = mapCanvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  const tolerance = 16 / rect.width;
  const candidates = [];
  if (state.course.finish) candidates.push({ kind: 'finish' });
  state.course.controls.forEach((_, index) => candidates.push({ kind: 'control', index }));
  if (state.course.start) candidates.push({ kind: 'start' });
  for (const candidate of candidates) {
    const p = candidate.kind === 'control' ? state.course.controls[candidate.index] : state.course[candidate.kind];
    if (Math.hypot(p.u - x, p.v - y) <= tolerance) return candidate;
  }
  return null;
}

function moveCoursePoint(target, point) {
  const p = { u: clamp(point.u, 0, 1), v: clamp(point.v, 0, 1) };
  if (target.kind === 'control') state.course.controls[target.index] = p;
  else state.course[target.kind] = p;
}

function handleCoursePointerDown(next, event) {
  const hit = courseHitTest(event);
  pushUndo();
  if (hit) {
    courseDrag = { ...hit, pointerId: event.pointerId, moved: false };
    mapCanvas.setPointerCapture(event.pointerId);
    return;
  }
  const point = { u: next.gx / (N - 1), v: next.gy / (N - 1) };
  const place = state.course.start ? state.coursePlace : 'start';
  if (place === 'start') state.course.start = point;
  else if (place === 'finish') state.course.finish = point;
  else if (state.course.controls.length < 30) state.course.controls.push(point);
  if (place !== 'control') state.coursePlace = 'control';
  updateCourseUI();
  drawMap();
  scheduleSave();
}

function removeLastCoursePoint() {
  const course = state.course;
  if (!course.start) return;
  pushUndo();
  if (course.finish) course.finish = null;
  else if (course.controls.length) course.controls.pop();
  else course.start = null;
  updateCourseUI();
  drawMap();
  scheduleSave();
}

function updateCourseUI() {
  const course = state.course;
  for (const button of document.querySelectorAll('[data-course-place]')) {
    button.setAttribute('aria-checked', String(button.dataset.coursePlace === (course.start ? state.coursePlace : 'start')));
  }
  const controls = course.controls.length;
  let summary;
  if (!course.start) summary = 'לחצו על המפה כדי להציב את נקודת הזינוק';
  else if (!controls) summary = 'עכשיו הציבו נקודות ביקורת לפי הסדר';
  else summary = `${controls} נקודות · ${formatMapDistance(courseLength(course, mapExtentMeters()))}${course.finish ? '' : ' · חוזרים לזינוק'}`;
  $('courseSummary').textContent = summary;
  $('startNavBtn').disabled = !isRunnable(course);
  $('undoCourseBtn').disabled = !course.start;
  $('clearCourseBtn').disabled = !course.start;
}

function setCourse(course, message = null) {
  pushUndo();
  state.course = course;
  updateCourseUI();
  drawMap();
  scheduleSave();
  if (message) showToast(message, { action: { label: 'ביטול', run: undo } });
}

function openNavigation() {
  if (!isRunnable(state.course)) {
    setTool('course');
    showToast('קודם קובעים מסלול: לחצו על המפה להצבת זינוק ונקודות, או על „מסלול אקראי”.');
    return;
  }
  closePopovers();
  stopDrawing();
  navGame?.openSetup(cloneCourse(state.course));
}

// Game mode: the 3D panel fills the window, terrain shows natural colours with ground
// texture, contours are hidden and the vertical scale is true (×1).
let gameSaved = null;
function enterGameMode({ exaggeration = 1 } = {}) {
  stopDrawing();
  closePopovers();
  rainSimulation?.stop();
  sheepGame?.cancelPlacement?.();
  if (camera && controls && !state.observer.firstPerson) {
    savedOrbitPosition = camera.position.clone();
    savedOrbitTarget = controls.target.clone();
  }
  gameSaved = {
    exaggeration: state.exaggeration,
    fog: scene?.fog,
    background: scene?.background,
    observer: { ...state.observer },
  };
  state.navigating = true;
  // The field view can be exaggerated so hills read as clearly as on the map; walking
  // speed and climb are always computed from the real slope (nav-game.js).
  state.exaggeration = clamp(exaggeration, 1, 10);
  $('toast').hidden = true;
  document.querySelector('#zoomJoystick .joystick-tag').textContent = 'מבט'; // in the game this stick tilts the view
  document.body.classList.add('navigating');
  Object.assign(state.observer, { placed: true, firstPerson: true, placing: false });
  if (controls) controls.enabled = false;
  if (scene) {
    scene.fog = new THREE.Fog(0xdfe9e2, WORLD_SIZE * .3, WORLD_SIZE * 1.45);
    scene.background = new THREE.Color(0xdfe9e2);
  }
  if (groundMesh) groundMesh.visible = true;
  applyView3d();
  updateObserverUI();
  updateTerrain();
  updateBrushRing();
  requestAnimationFrame(() => { resizeThree(); updateObserverCamera(); });
}

// The field's haze: farther while flying; at night darker and closer (gameFog).
function applyGameFog() {
  if (!scene?.fog || !state.navigating) return;
  const drone = state.observer.drone;
  const scale = gameFog?.scale ?? 1;
  scene.fog.near = WORLD_SIZE * (drone ? .7 : .3) * scale;
  scene.fog.far = WORLD_SIZE * (drone ? 2.8 : 1.45) * scale;
  if (gameFog) scene.fog.color.setRGB(...gameFog.color, THREE.SRGBColorSpace);
  else scene.fog.color.set(0xdfe9e2);
  if (scene.background?.isColor) scene.background.copy(scene.fog.color);
}

// Lights for a sky state from sky.js (the key light follows the sun or the moon), or the
// default daylight when `sky` is null.
function setGameLighting(sky) {
  if (!scene || !sunLight) return;
  const sizeFactor = state.mapSize / 4;
  if (!sky) {
    gameFog = null;
    sunLight.color.set(0xfff1d6);
    sunLight.intensity = 2.6;
    sunLight.position.set(-10 * sizeFactor, 13 * sizeFactor, -9 * sizeFactor);
    hemiLight?.color.set(0xf2f5ff);
    hemiLight?.groundColor.set(0x5a6650);
    if (hemiLight) hemiLight.intensity = 1.15;
    if (fillLight) fillLight.intensity = .35;
    renderer.toneMappingExposure = .96;
  } else {
    const { dir, intensity, color } = sky.key;
    sunLight.color.setRGB(...color, THREE.SRGBColorSpace);
    sunLight.intensity = intensity;
    // Keep the light just above the horizon so shadows stay sane as the body sets.
    const y = Math.max(dir.y, .03);
    const length = Math.hypot(dir.x, y, dir.z);
    sunLight.position.set(dir.x / length, y / length, dir.z / length).multiplyScalar(18 * sizeFactor);
    if (hemiLight) {
      hemiLight.color.setRGB(...sky.hemi.sky, THREE.SRGBColorSpace);
      hemiLight.groundColor.setRGB(...sky.hemi.ground, THREE.SRGBColorSpace);
      hemiLight.intensity = sky.hemi.intensity;
    }
    if (fillLight) fillLight.intensity = sky.fill;
    renderer.toneMappingExposure = sky.exposure;
    gameFog = sky.fog;
  }
  applyGameFog();
  needsRender = true;
}

function exitGameMode() {
  if (!state.navigating) return;
  setGameLighting(null);
  state.navigating = false;
  document.body.classList.remove('navigating');
  document.querySelector('#zoomJoystick .joystick-tag').textContent = 'קירוב';
  state.exaggeration = gameSaved?.exaggeration ?? state.exaggeration;
  if (scene && gameSaved) {
    scene.fog = gameSaved.fog;
    scene.background = gameSaved.background;
  }
  Object.assign(state.observer, gameSaved?.observer || {}, { bob: 0 });
  gameSaved = null;
  if (groundMesh) groundMesh.visible = false;
  exitObserver();
  applyView3d();
  requestAnimationFrame(() => { resizeThree(); resizeMap(); });
}

// ——— Cursor readout: height (and slope) next to the pointer ———
const cursorReadout = $('cursorReadout');
let lastReadoutClient = null;

function hideCursorReadout() {
  cursorReadout.hidden = true;
  lastReadoutClient = null;
}

function updatePointReadout(pointer, event = null) {
  const x = Math.round(pointer.gx);
  const y = Math.round(pointer.gy);
  const height = Math.round(heights[y * N + x]);
  const slope = slopePercent(heights, N, pointer.gx, pointer.gy, mapExtentMeters() / (N - 1));
  cursorReadout.textContent = `${height} מ׳ · שיפוע ${slope < 1 ? slope.toFixed(1) : Math.round(slope)}%`;
  const wrapRect = $('mapWrap').getBoundingClientRect();
  let clientX;
  let clientY;
  if (event && 'clientX' in event) {
    clientX = event.clientX;
    clientY = event.clientY;
    lastReadoutClient = { clientX, clientY, touch: event.pointerType === 'touch' };
  } else {
    const rect = mapCanvas.getBoundingClientRect();
    clientX = rect.left + pointer.gx / (N - 1) * rect.width;
    clientY = rect.top + pointer.gy / (N - 1) * rect.height;
  }
  // Fingers hide whatever is under them, so on touch the label sits higher.
  const lift = lastReadoutClient?.touch ? 56 : 18;
  const left = clamp(clientX - wrapRect.left + 16, 4, Math.max(4, wrapRect.width - cursorReadout.offsetWidth - 4));
  const top = clamp(clientY - wrapRect.top - lift - 10, 4, Math.max(4, wrapRect.height - 28));
  cursorReadout.style.transform = `translate(${left}px, ${top}px)`;
  cursorReadout.hidden = false;
  updateBrushRing();
}

function stopDrawing(event) {
  if (courseDrag) {
    courseDrag = null;
    updateCourseUI();
    scheduleSave();
  }
  if (mapPanDrag) {
    if (mapCanvas.hasPointerCapture(mapPanDrag.pointerId)) mapCanvas.releasePointerCapture(mapPanDrag.pointerId);
    mapPanDrag = null;
    mapCanvas.classList.remove('is-panning');
  }
  state.observerDrag = null;
  if (state.drawing) {
    state.drawing = false;
    state.strokeTool = null;
    scheduleSave();
    lastStamp = null;
    clearInterval(holdTimer);
    holdTimer = null;
  }
  if (event && mapCanvas.hasPointerCapture(event.pointerId)) mapCanvas.releasePointerCapture(event.pointerId);
}

// Last known mouse position, used by hold-Space panning. (pointerenter/leave are unreliable
// around pointer capture, so containment is checked against the map's rectangle instead.)
let lastMouse = null;
document.addEventListener('pointermove', (event) => {
  if (event.pointerType === 'mouse') lastMouse = { x: event.clientX, y: event.clientY };
}, { capture: true, passive: true });
function mouseIsOverMap() {
  if (!lastMouse) return false;
  const rect = $('mapWrap').getBoundingClientRect();
  return lastMouse.x >= rect.left && lastMouse.x <= rect.right && lastMouse.y >= rect.top && lastMouse.y <= rect.bottom;
}

function startPanDrag(event) {
  event.preventDefault();
  mapPanDrag = {
    pointerId: event.pointerId,
    clientX: event.clientX,
    clientY: event.clientY,
    panX: state.mapView.panX,
    panY: state.mapView.panY,
  };
  mapCanvas.setPointerCapture(event.pointerId);
  mapCanvas.classList.add('is-panning');
  hideCursorReadout();
}

mapCanvas.addEventListener('pointerdown', (event) => {
  closePopovers();
  const panRequested = isPanning() || (event.pointerType === 'mouse' && event.button === 1);
  if (panRequested) {
    startPanDrag(event);
    return;
  }
  if (event.button !== 0 && event.pointerType === 'mouse') return;
  event.preventDefault();
  mapCanvas.focus({ preventScroll: true });
  const next = eventToGrid(event);
  // The drop tool: show where water from this point goes (works with or without rain).
  if (state.tool === 'drop') {
    rainSimulation?.handleMapClick(next.gx, next.gy);
    return;
  }
  if (state.tool === 'waypoint') {
    addWaypoint(next);
    return;
  }
  if (state.tool === 'course') {
    handleCoursePointerDown(next, event);
    return;
  }
  if (state.tool === 'features') {
    if (mapFeatures && !mapFeatures.active) mapFeatures.activate(state.lastFeatureType);
    if (mapFeatures?.handlePointerDown(next.gx, next.gy)) {
      state.pointer = next;
      updatePointReadout(next, event);
    }
    return;
  }
  if (sheepGame?.place(next.gx / (N - 1), next.gy / (N - 1))) return;
  if (state.observer.placing) {
    state.pointer = next;
    updatePointReadout(next, event);
    enterObserver(next.gx / (N - 1), next.gy / (N - 1));
    showToast('האדם הוצב. גררו אותו לשינוי מיקום, או את קצה החץ לשינוי כיוון.');
    return;
  }
  const observerHit = observerHitTest(event);
  if (observerHit) {
    state.observerDrag = observerHit;
    state.pointer = null;
    mapCanvas.setPointerCapture(event.pointerId);
    drawMap();
    return;
  }
  if (!isSculptTool()) return;
  rainSimulation?.stop();
  pushUndo();
  state.drawing = true;
  state.strokeTool = strokeToolFor(event);
  state.pointer = next;
  state.flattenTarget = sampleHeight(next.gx / (N - 1), next.gy / (N - 1));
  lastStamp = { ...state.pointer };
  mapCanvas.setPointerCapture(event.pointerId);
  lastBrushTime = performance.now() - 80;
  applyTimedBrush(state.pointer.gx, state.pointer.gy);
  updatePointReadout(state.pointer, event);
  clearInterval(holdTimer);
  holdTimer = setInterval(() => {
    if (state.drawing && state.pointer) applyTimedBrush(state.pointer.gx, state.pointer.gy);
  }, 50);
});

mapCanvas.addEventListener('pointermove', (event) => {
  event.preventDefault();
  if (mapPanDrag) {
    state.mapView.panX = mapPanDrag.panX + event.clientX - mapPanDrag.clientX;
    state.mapView.panY = mapPanDrag.panY + event.clientY - mapPanDrag.clientY;
    applyMapSurfaceTransform();
    updateMapViewUI();
    return;
  }
  const bounds = mapCanvas.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
    stopDrawing(event);
    state.pointer = null;
    hideCursorReadout();
    updateBrushRing();
    drawMap();
    return;
  }
  const next = eventToGrid(event);
  state.pointer = next;
  if (isPanning()) {
    hideCursorReadout();
    return;
  }
  updatePointReadout(next, event);
  if (state.tool === 'drop') {
    rainSimulation?.handleMapHover(next.gx, next.gy);
    return;
  }
  if (state.tool === 'waypoint') {
    updateWaypointUI(next);
    return;
  }
  if (courseDrag) {
    moveCoursePoint(courseDrag, { u: next.gx / (N - 1), v: next.gy / (N - 1) });
    courseDrag.moved = true;
    drawMap();
    return;
  }
  if (state.tool === 'features' && mapFeatures?.handlePointerMove(next.gx, next.gy)) return;
  if (state.observerDrag) {
    if (state.observerDrag === 'move') {
      state.observer.u = clamp(next.gx / (N - 1), 0, 1);
      state.observer.v = clamp(next.gy / (N - 1), 0, 1);
    } else {
      const rect = mapCanvas.getBoundingClientRect();
      const cx = rect.left + state.observer.u * rect.width;
      const cy = rect.top + state.observer.v * rect.height;
      const degrees = Math.atan2(event.clientX - cx, -(event.clientY - cy)) * 180 / Math.PI;
      state.observer.heading = (degrees + 360) % 360;
    }
    if (state.observer.firstPerson) updateObserverCamera();
    drawMap();
    return;
  }
  if (state.observer.placing || sheepGame?.placing) {
    drawMap();
    return;
  }
  if (state.drawing) {
    state.strokeTool = strokeToolFor(event);
    const previous = lastStamp || next;
    const distance = Math.hypot(next.gx - previous.gx, next.gy - previous.gy);
    const spacing = Math.max(.25, brushRadiusCells(state.brush, mapExtentMeters(), N) * .18);
    const steps = Math.max(1, Math.ceil(distance / spacing));
    const now = performance.now();
    const elapsed = clamp((now - lastBrushTime) / 1000, 0, .15);
    lastBrushTime = now;
    if (state.strokeTool === 'smudge') {
      // Drag the terrain along with the pointer, in small steps so it stays smooth.
      const radius = brushRadiusCells(state.brush, mapExtentMeters(), N);
      const strength = clamp(state.strength / 28, .25, 1);
      const dx = (next.gx - previous.gx) / steps;
      const dy = (next.gy - previous.gy) / steps;
      for (let i = 1; i <= steps; i++) {
        applySmudgeBrush(heights, N, previous.gx + dx * i, previous.gy + dy * i, radius, dx, dy, strength);
      }
      scheduleUpdate();
    } else {
      for (let i = 1; i <= steps; i++) {
        applyBrush(lerp(previous.gx, next.gx, i / steps), lerp(previous.gy, next.gy, i / steps), elapsed / steps, state.strokeTool);
      }
    }
    lastStamp = { ...next };
  } else drawMap();
});

mapCanvas.addEventListener('pointerup', stopDrawing);
mapCanvas.addEventListener('pointercancel', stopDrawing);
mapCanvas.addEventListener('pointerleave', (event) => {
  if (event.pointerType !== 'touch') hideCursorReadout();
  if (state.observerDrag && event.pointerType === 'mouse') stopDrawing(event);
  else if (!state.drawing) { state.pointer = null; updateBrushRing(); drawMap(); }
  else if (event.pointerType === 'mouse') stopDrawing(event);
});
mapCanvas.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  if (state.navigating) return;
  stopDrawing();
  openMapMenu(event.clientX, event.clientY);
});
// Middle-button drags pan the map: stop the browser's autoscroll from starting.
mapCanvas.addEventListener('mousedown', (event) => { if (event.button === 1) event.preventDefault(); });
mapCanvas.addEventListener('auxclick', (event) => { if (event.button === 1) event.preventDefault(); });

// ——— Right-click menu: pick any tool where you are working ———
const MENU_ICONS = {
  raise: '<path d="M12 5v14M5 12h14"/>',
  lower: '<path d="M5 12h14"/>',
  smooth: '<path d="M3 15c3-4 5-6 9-6s6 2 9 6"/>',
  smudge: '<path d="M3 17c3-1 4-5 7-5s3 4 6 4 4-3 5-4"/><path d="m14 5 3 3-3 3"/>',
  pinch: '<path d="M4 6l6 6-6 6M20 6l-6 6 6 6"/>',
  flatten: '<path d="M3 16h18M6 12h12"/>',
  pan: '<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>',
  features: '<path d="M3 18c4-6 7-9 10-9 2 0 3 2 5 2 1 0 2-1 3-3"/>',
  course: '<path d="M5 21V4h12l-3 4 3 4H5"/>',
  drop: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z"/>',
};
const MENU_LAYOUT = [['title', 'עיצוב השטח'], 'raise', 'lower', 'smooth', 'smudge', 'pinch', 'flatten', '-', 'pan', 'features', 'course', 'drop'];
const mapMenu = $('mapMenu');

function openMapMenu(x, y) {
  mapMenu.innerHTML = MENU_LAYOUT.map((item) => {
    if (item === '-') return '<hr>';
    if (Array.isArray(item)) return `<div class="menu-title">${item[1]}</div>`;
    const key = shortcutLabel(`tool-${item}`);
    return `<button type="button" role="menuitemradio" data-menu-tool="${item}" aria-checked="${state.tool === item}"><svg viewBox="0 0 24 24" aria-hidden="true">${MENU_ICONS[item]}</svg><span>${TOOL_LABELS[item]}</span>${key ? `<kbd>${key}</kbd>` : ''}</button>`;
  }).join('');
  mapMenu.hidden = false;
  const rect = mapMenu.getBoundingClientRect();
  mapMenu.style.left = `${Math.min(x, innerWidth - rect.width - 8)}px`;
  mapMenu.style.top = `${Math.min(y, innerHeight - rect.height - 8)}px`;
  mapMenu.querySelector('[aria-checked="true"]')?.focus() || mapMenu.querySelector('button')?.focus();
}

function closeMapMenu() {
  mapMenu.hidden = true;
}

mapMenu.addEventListener('click', (event) => {
  const button = event.target.closest('[data-menu-tool]');
  if (!button) return;
  setTool(button.dataset.menuTool);
  closeMapMenu();
  mapCanvas.focus({ preventScroll: true });
});
mapMenu.addEventListener('keydown', (event) => {
  const items = [...mapMenu.querySelectorAll('button')];
  const index = items.indexOf(document.activeElement);
  if (event.key === 'ArrowDown') { items[(index + 1) % items.length].focus(); event.preventDefault(); }
  else if (event.key === 'ArrowUp') { items[(index - 1 + items.length) % items.length].focus(); event.preventDefault(); }
  else if (event.key === 'Escape') { closeMapMenu(); mapCanvas.focus({ preventScroll: true }); event.preventDefault(); event.stopPropagation(); }
});
document.addEventListener('pointerdown', (event) => { if (!mapMenu.hidden && !event.target.closest('#mapMenu')) closeMapMenu(); }, true);
addEventListener('blur', closeMapMenu);
mapCanvas.addEventListener('dblclick', (event) => {
  if (!mapFeatures?.active) return;
  event.preventDefault();
  mapFeatures.handleDoubleClick();
});

let wheelBrushDelta = 0;
$('mapWrap').addEventListener('wheel', (event) => {
  event.preventDefault();
  // Ctrl (⌘) + wheel resizes the brush instead of zooming the map.
  if (event.ctrlKey || event.metaKey) {
    wheelBrushDelta += event.deltaY;
    if (Math.abs(wheelBrushDelta) < 30) return;
    setBrushSize(wheelBrushDelta < 0 ? Math.max(state.brush + 5, state.brush * 1.12) : Math.min(state.brush - 5, state.brush / 1.12));
    wheelBrushDelta = 0;
    if (state.pointer) updatePointReadout(state.pointer);
    return;
  }
  wheelZoomDelta += event.deltaY;
  if (Math.abs(wheelZoomDelta) < 35) return;
  stepMapZoom(wheelZoomDelta < 0 ? 1 : -1, event.clientX, event.clientY);
  wheelZoomDelta = 0;
}, { passive: false });

// Keyboard access to the map itself (focus the canvas): arrows move the brush cursor,
// Enter applies the current tool. In pan mode the arrows move the map instead.
mapCanvas.addEventListener('keydown', (event) => {
  if (state.tool === 'features' && mapFeatures?.handleKey(event)) return;
  if (state.tool === 'waypoint' && (event.key === 'Backspace' || event.key === 'Delete')) {
    event.preventDefault();
    removeLastWaypoint();
    return;
  }
  if (state.tool === 'course' && (event.key === 'Backspace' || event.key === 'Delete')) {
    event.preventDefault();
    removeLastCoursePoint();
    return;
  }
  if (isPanning()) {
    const panStep = event.shiftKey ? 100 : 40;
    if (event.key === 'ArrowLeft') state.mapView.panX -= panStep;
    else if (event.key === 'ArrowRight') state.mapView.panX += panStep;
    else if (event.key === 'ArrowUp') state.mapView.panY -= panStep;
    else if (event.key === 'ArrowDown') state.mapView.panY += panStep;
    else return;
    event.preventDefault();
    applyMapSurfaceTransform();
    updateMapViewUI();
    return;
  }
  if (sheepGame?.placing && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    const p = state.pointer || { gx: (N-1)/2, gy: (N-1)/2 };
    sheepGame.place(p.gx/(N-1), p.gy/(N-1));
    return;
  }
  const current = state.pointer || { gx: (N - 1) / 2, gy: (N - 1) / 2 };
  const step = event.shiftKey ? 6 : 2;
  if (event.key === 'ArrowLeft') current.gx -= step;
  else if (event.key === 'ArrowRight') current.gx += step;
  else if (event.key === 'ArrowUp') current.gy -= step;
  else if (event.key === 'ArrowDown') current.gy += step;
  else if ((event.key === 'Enter' || (event.key === ' ' && !mouseIsOverMap())) && isSculptTool()) {
    event.preventDefault();
    pushUndo();
    applyBrush(current.gx, current.gy, .12);
  } else return;
  event.preventDefault();
  current.gx = clamp(current.gx, 0, N - 1);
  current.gy = clamp(current.gy, 0, N - 1);
  state.pointer = current;
  updatePointReadout(current);
  drawMap();
});

// ——— Controls and guided exercise ———
// showToast(message, true) marks an error; showToast(message, { action: { label, run } })
// adds a button — used to make destructive actions undoable instead of asking for confirmation.
let toastAction = null;
function showToast(message, options = false) {
  const { error = false, action = null } = typeof options === 'object' && options ? options : { error: Boolean(options) };
  const toast = $('toast');
  clearTimeout(toastTimer);
  $('toastMessage').textContent = message;
  toastAction = action;
  $('toastAction').hidden = !action;
  if (action) $('toastAction').textContent = action.label;
  toast.classList.toggle('error', error);
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; toastAction = null; }, action ? 6000 : 3600);
}
$('toastAction').addEventListener('click', () => {
  const action = toastAction;
  $('toast').hidden = true;
  toastAction = null;
  action?.run();
});

function updateExercise() {
  if (!state.exercise) return;
  updateReadouts();
}

function startExercise() {
  if (state.exercise) return;
  state.exerciseBackup = { heights: new Float32Array(heights), mapSize: state.mapSize, localSpacing: state.localSpacing, topo: state.topo };
  rainSimulation?.stop();
  state.exercise = true;
  $('checkExerciseBtn').textContent = 'בדיקה';
  if (autosave) { autosave.flush(); autosave.enabled = false; }
  heights.fill(0);
  history.clear();
  $('exerciseStrip').hidden = false;
  $('exerciseBtn').classList.add('active');
  setTopo(true);
  scheduleUpdate();
  showToast('המשטח אופס לתרגיל. היצירה הקודמת נשמרה ותוחזר בסגירה.');
}

function closeExercise() {
  if (!state.exercise) return;
  const backup = state.exerciseBackup;
  state.exercise = false;
  state.exerciseBackup = null;
  if (backup.mapSize !== state.mapSize || backup.localSpacing !== state.localSpacing) setMapSize(backup.mapSize, backup.heights, backup.localSpacing);
  else heights.set(backup.heights);
  $('exerciseStrip').hidden = true;
  $('exerciseBtn').classList.remove('active');
  history.clear();
  if (autosave) autosave.enabled = true;
  setTopo(backup.topo);
  scheduleUpdate();
}

function closePopovers() {
  const popover = $('newTerrainPopover');
  if (popover.hidden) return;
  popover.hidden = true;
  $('newTerrainBtn').setAttribute('aria-expanded', 'false');
}

function toggleNewTerrainMenu() {
  const popover = $('newTerrainPopover');
  const open = popover.hidden;
  closePopovers();
  if (!open) return;
  popover.hidden = false;
  updateResetUI();
  $('newTerrainBtn').setAttribute('aria-expanded', 'true');
  popover.querySelector('.preset-button')?.focus();
}

function syncFullscreen(panel) {
  state.focus = panel;
  for (const name of ['map', 'scene']) {
    const active = panel === name;
    const element = document.querySelector('.' + name + '-panel');
    element.classList.toggle('panel-fullscreen', active);
    const button = $(name === 'map' ? 'focusMapBtn' : 'focusSceneBtn');
    button.setAttribute('aria-pressed', String(active));
    button.setAttribute('aria-label', active ? 'יציאה ממסך מלא' : name === 'map' ? 'מפה במסך מלא' : 'תלת־ממד במסך מלא');
    button.title = active ? 'יציאה ממסך מלא (Esc)' : 'מסך מלא';
  }
  document.body.classList.toggle('panel-expanded', Boolean(panel));
  closePopovers();
  requestAnimationFrame(() => { resizeMap(); resizeThree(); });
}

async function setFocus(panel) {
  stopDrawing();
  if (state.focus === panel) {
    if (document.fullscreenElement) {
      try { await document.exitFullscreen(); } catch { showToast('אפשר לצאת ממסך מלא באמצעות Esc.'); return; }
    }
    syncFullscreen(null);
    return;
  }
  const element = document.querySelector('.' + panel + '-panel');
  try {
    if (!element.requestFullscreen) throw new Error('Fullscreen unavailable');
    await element.requestFullscreen();
    syncFullscreen(panel);
  } catch {
    // Embedded browsers may disallow native fullscreen; fill the app viewport.
    syncFullscreen(panel);
  }
}

document.addEventListener('fullscreenchange', () => {
  const element = document.fullscreenElement;
  syncFullscreen(element?.classList.contains('map-panel') ? 'map' : element?.classList.contains('scene-panel') ? 'scene' : null);
});

$('removeObserverBtn').addEventListener('click', () => {
  stopDrawing();
  state.observer.placed = false;
  exitObserver();
  showToast('האדם הוסתר מהמפה. אפשר להציב אותו מחדש.');
});

$('focusMapBtn').addEventListener('click', () => setFocus('map'));
$('focusSceneBtn').addEventListener('click', () => setFocus('scene'));
$('newTerrainBtn').addEventListener('click', toggleNewTerrainMenu);
$('closeNewTerrainBtn').addEventListener('click', () => { closePopovers(); $('newTerrainBtn').focus(); });
document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('#newTerrainPopover, #newTerrainBtn, #toast')) closePopovers();
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || state.navigating || document.querySelector('dialog[open]')) return;
  sheepGame?.cancelPlacement();
  if (!$('newTerrainPopover').hidden) { closePopovers(); $('newTerrainBtn').focus(); return; }
  if (state.tool === 'features') {
    // First Esc drops the line being drawn; a second one leaves the features tool.
    if (mapFeatures?.drafting) mapFeatures.cancel(false);
    else setTool('raise');
    return;
  }
  if (state.focus) { setFocus(state.focus); return; }
  if (state.observer.placing || state.observer.firstPerson) exitObserver();
});

$('observerBtn').addEventListener('click', () => {
  sheepGame?.cancelPlacement();
  if (state.tool === 'features' || state.tool === 'pan') setTool('raise');
  if (state.observer.firstPerson || state.observer.placing) {
    exitObserver();
    return;
  }
  if (state.observer.placed) {
    enterObserver();
    return;
  }
  state.observer.placing = true;
  closePopovers();
  updateObserverUI();
  drawMap();
  showToast('לחצו על נקודה במפה כדי להציב את האדם ולראות מה הוא רואה.');
});
$('observerTiltRange').addEventListener('input', (event) => {
  state.observer.tilt = Number(event.target.value);
  $('observerTiltValue').value = `${event.target.value}°`;
  updateObserverCamera();
});
for (const button of document.querySelectorAll('.rail-tool[data-tool]')) {
  button.addEventListener('click', () => setTool(button.dataset.tool));
}
for (const button of document.querySelectorAll('[data-sculpt]')) {
  button.addEventListener('click', () => setTool(button.dataset.sculpt));
}
$('mapZoomInBtn').addEventListener('click', () => stepMapZoom(1));
$('mapZoomOutBtn').addEventListener('click', () => stepMapZoom(-1));
$('centerMapBtn').addEventListener('click', () => resetMapView());
$('randomTerrainBtn').addEventListener('click', () => { applyRandomTerrain(true); closePopovers(); });
$('generateTerrainBtn').addEventListener('click', () => { applyRandomTerrain(false); closePopovers(); });
$('terrainSeed').value = crypto.getRandomValues(new Uint32Array(1))[0];
for (const name of ['relief', 'variation', 'detail', 'valleys', 'drainage']) {
  $('terrain-' + name).addEventListener('input', (event) => {
    $('terrain-' + name + '-value').value = event.target.value;
  });
}
$('topoBtn').addEventListener('click', () => setTopo(true));
$('sculptViewBtn').addEventListener('click', () => setTopo(false));
$('brushRange').addEventListener('input', (event) => setBrushSize(Number(event.target.value)));
$('strengthRange').addEventListener('input', (event) => setStrength(Number(event.target.value)));
$('mapSizeSelect').addEventListener('change', (event) => {
  const newSize = Number(event.target.value);
  if (newSize === state.mapSize) return;
  pushUndo();
  closePopovers();
  setMapSize(newSize);
  scheduleSave();
});
$('detailSelect').addEventListener('change', (event) => {
  pushUndo();
  setMapSize(state.mapSize, null, Number(event.target.value));
  scheduleSave();
  showToast('רמת הפירוט עודכנה. פרטים חדשים נוצרים בפיסול או ביצירת מפה חדשה.', { action: { label: 'ביטול', run: undo } });
});
$('terrain-gullyWidth').addEventListener('input', (event) => {
  $('terrain-gullyWidth-value').value = `${event.target.value} מ׳`;
});
function updateMapReferenceScale(showMessage = false) {
  stopDrawing();
  state.pointer = null;
  hideCursorReadout();
  updateMapScaleText();
  resizeMap();
  if (showMessage) {
    showToast(`קנה המידה עודכן. כל משבצת מייצגת ${formatMapDistance(gridCellMeters())}; הזום ונתוני השטח לא השתנו.`);
  }
}

$('scaleSelect').addEventListener('change', (event) => {
  state.scale = Number(event.target.value);
  updateTerrain();
  updateMapReferenceScale(true);
  scheduleSave();
});
$('intervalSelect').addEventListener('change', (event) => {
  state.interval = Number(event.target.value);
  updateTerrain();
  drawMap();
  scheduleSave();
});
const pdfPreview = createPdfPreviewController({
  getData: () => ({
      sizeKm: state.mapSize,
      interval: state.interval,
      scale: state.scale,
      stats: terrainStats(),
      colorStops,
      colorMin: MIN_HEIGHT,
      colorMax: MAX_HEIGHT,
      mapBlock: drawPrintBlock,
      exaggeration: state.exaggeration,
  }),
  capture3D: capture3DForPdf,
  notify: showToast,
});
$('exportPdfBtn').addEventListener('click', () => {
  pdfPreview.open();
});
$('exaggerationRange').addEventListener('input', (event) => {
  state.exaggeration = Number(event.target.value);
  $('exaggerationValue').value = `×${state.exaggeration.toFixed(1)}`;
  updateTerrain();
  updateBrushRing();
  scheduleSave();
});
$('undoBtn').addEventListener('click', undo);
$('redoBtn').addEventListener('click', redo);
let erosionPresses = 0;
// One "סחיפה" press: a few passes of stream-power erosion on the current terrain, then
// small pits are cut open. Real erosion only lowers ground, so heights are not rescaled.
$('erodeBtn').addEventListener('click', () => {
  stopDrawing();
  rainSimulation?.stop();
  pushUndo();
  erosionPresses = (erosionPresses + 1) % 1e6;
  erodeStreamPower(heights, N, { passes: 12, strength: 2.6, m: .6, diffusion: .04, roughness: 2.5, seed: erosionPresses });
  breachDepressions(heights, N, { keepDepth: 6, keepCells: Math.round(N * .3) });
  for (let i = 0; i < heights.length; i++) heights[i] = clamp(heights[i], MIN_HEIGHT, MAX_HEIGHT);
  scheduleUpdate();
  closePopovers();
  showToast('המים חרצו ערוצים בשטח. אפשר ללחוץ שוב להעמקה, או להפעיל גשם ולראות את הזרימה.', { action: { label: 'ביטול', run: undo } });
});
for (const button of document.querySelectorAll('[data-reset]')) {
  button.addEventListener('click', () => {
    const kind = button.dataset.reset;
    resetMap(kind === 'all' ? { terrain: true, features: true, course: true } : { [kind]: true });
    closePopovers();
  });
}
$('resetCameraBtn').addEventListener('click', () => {
  if (state.observer.firstPerson) exitObserver();
  resetCamera();
});
$('topCameraBtn').addEventListener('click', () => {
  if (state.observer.firstPerson) exitObserver();
  if (!camera || !controls) return;
  camera.position.set(0, fitDistance() * .9, .01);
  controls.target.set(0, 0, 0);
  controls.update();
  needsRender = true;
  updateCompass();
});
for (const button of document.querySelectorAll('[data-view-facing]')) {
  button.addEventListener('click', () => viewFacing(button.dataset.viewFacing));
}
for (const input of document.querySelectorAll('[data-view3d]')) {
  input.addEventListener('change', () => setView3d(input.dataset.view3d, input.checked));
}
$('viewLayersBtn').addEventListener('click', () => {
  const panel = $('viewLayersPanel');
  panel.hidden = !panel.hidden;
  $('viewLayersBtn').setAttribute('aria-expanded', String(!panel.hidden));
});
document.addEventListener('pointerdown', (event) => {
  if (!$('viewLayersPanel').hidden && !event.target.closest('#viewLayersPanel, #viewLayersBtn')) {
    $('viewLayersPanel').hidden = true;
    $('viewLayersBtn').setAttribute('aria-expanded', 'false');
  }
});
document.querySelectorAll('[data-preset]').forEach((button) => {
  button.addEventListener('click', () => {
    applyPreset(button.dataset.preset);
    closePopovers();
  });
});
$('exerciseBtn').addEventListener('click', () => state.exercise ? closeExercise() : startExercise());
$('closeExerciseBtn').addEventListener('click', closeExercise);
$('checkExerciseBtn').addEventListener('click', () => {
  const { max } = terrainStats();
  const lines = countPositiveContourLevels();
  if (max >= 60 && lines >= 3) {
    showToast('כל הכבוד! הגבעה גבוהה מ־60 מ׳ ויש בה שלושה קווי גובה לפחות.');
    $('checkExerciseBtn').textContent = 'המשימה הושלמה ✓';
  } else if (max < 60) {
    showToast(`השיא הנוכחי הוא ${Math.round(max)} מ׳. המשיכו להגביה את מרכז הגבעה.`, true);
  } else {
    showToast('הגובה מספיק, אך חסרים קווי גובה. עצבו גבעה מדורגת ונסו שוב.', true);
  }
});

const helpDialog = $('helpDialog');
$('helpBtn').addEventListener('click', () => helpDialog.showModal());
$('closeHelpBtn').addEventListener('click', () => helpDialog.close());
$('doneHelpBtn').addEventListener('click', () => helpDialog.close());
helpDialog.addEventListener('click', (event) => {
  if (event.target === helpDialog) helpDialog.close();
});

// Static-scene verification hooks: no autonomous animation or time-dependent state.
window.__seek = () => {
  if (renderer && scene && camera) renderer.render(scene, camera);
};
window.__play = () => {};
window.__NAV_TELEPORT__ = () => navGame?.debugTeleport();
window.__NAV_LOOK_AT_NEXT__ = (meters) => navGame?.debugApproach(meters);
window.__NAV_PLACE__ = (u, v, heading) => navGame?.debugPlace(u, v, heading);
window.__NAV_DRONE__ = () => navGame?.debugDrone();
window.__NAV_CAMEL__ = (meters, camelState, turn) => navGame?.debugCamel(meters, camelState, turn);
window.__NAV_CLOCK__ = (hour) => navGame?.debugClock(hour);
window.__APP_STATS__ = () => ({
  gridVertices: N * N,
  gridResolution: N,
  sampleSpacingMeters: mapExtentMeters() / (N - 1),
  brushDiameterMeters: state.brush,
  mapSizeKm: state.mapSize,
  mapExtentMeters: mapExtentMeters(),
  baseScale: state.scale,
  mapZoom: state.mapView.zoom,
  mapPan: { x: state.mapView.panX, y: state.mapView.panY },
  gridCellMeters: gridCellMeters(),
  gridCellCount: gridCellCount(),
  worldSize: WORLD_SIZE,
  observer: { ...state.observer },
  observerGroundHeight: sampleHeight(state.observer.u, state.observer.v),
  randomTerrain: lastRandomTerrain,
  mapFeatures: mapFeatures?.stats() || null,
  rain: rainSimulation?.stats() || null,
  updateQueued,
  cameraPosition: camera ? camera.position.toArray() : null,
  cameraDirection: camera ? camera.getWorldDirection(new THREE.Vector3()).toArray() : null,
  triangles: renderer ? renderer.info.render.triangles : 0,
  drawCalls: renderer ? renderer.info.render.calls : 0,
  mode: state.topo ? 'topographic' : 'sculpt',
  course: { points: coursePoints(state.course).length, runnable: isRunnable(state.course) },
  navigation: navGame?.stats() || null,
});

const mapResizeObserver = new ResizeObserver(resizeMap);
mapResizeObserver.observe($('mapWrap'));
updateObserverUI();
initThree();
sheepGame = createSheepGame({
  scene: () => scene, camera: () => camera, terrain: () => terrainMesh,
  observer: () => state.observer, extent: mapExtentMeters,
  worldSize: () => WORLD_SIZE, height: sampleHeight,
  verticalScale: () => metersToWorld() * state.exaggeration,
  redraw: drawMap, invalidate: () => { needsRender = true; }, stop: stopDrawing,
  cancelObserverPlacement: () => { state.observer.placing = false; updateObserverUI(); },
});
mapFeatures = createMapFeatures({
  scene: () => scene,
  groundMode: () => state.navigating, // real-size, ground-level roads in the navigation game
  setAreaTint: (tint) => { areaTint = tint; updateTerrain(); },
  metersToWorld,
  surfaceHeight,
  worldSize: () => WORLD_SIZE,
  gridSize: () => N,
  height: sampleHeight,
  verticalScale: () => metersToWorld() * state.exaggeration,
  redraw: drawMap,
  invalidate: () => { needsRender = true; },
  notify: showToast,
  prepareDrawing: (type) => {
    stopDrawing();
    sheepGame?.cancelPlacement();
    state.observer.placing = false;
    updateObserverUI();
    closePopovers();
    state.lastFeatureType = type;
    $('trailColorControl').hidden = type !== 'markedTrail';
    if (state.tool !== 'features') {
      state.tool = 'features';
      syncToolUI();
    }
  },
  beforeChange: () => pushUndo(), // a finished or removed line is one undo step
  changed: () => scheduleSave(),
});
rainSimulation = createRainSimulation({
  scene: () => scene,
  setTerrainTint: (tint) => { terrainTint = tint; updateTerrain(); },
  setDropCursor: (on) => { mapCanvas.classList.toggle('drop-mode', on); updateBrushRing(); drawMap(); },
  surfaceHeight,
  extent: mapExtentMeters,
  worldSize: () => WORLD_SIZE,
  gridSize: () => N,
  heights: () => heights,
  height: sampleHeight,
  verticalScale: () => metersToWorld() * state.exaggeration,
  redraw: drawMap,
  invalidate: () => { needsRender = true; },
});
initPanelSplitter(() => { resizeMap(); resizeThree(); });
if (renderer) {
  renderer.domElement.addEventListener('pointerdown', () => renderer.domElement.focus());
  navigation = initNavigation(renderer.domElement, $('moveJoystick'), $('zoomJoystick'));
}
// ——— Course planning controls and the navigation game ———
for (const button of document.querySelectorAll('[data-course-place]')) {
  button.addEventListener('click', () => {
    state.coursePlace = button.dataset.coursePlace;
    if (!state.course.start && state.coursePlace !== 'start') showToast('קודם מציבים את נקודת הזינוק.');
    updateCourseUI();
  });
}
$('randomCourseBtn').addEventListener('click', () => {
  const count = Number($('courseCountSelect').value);
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  const generated = generateCourse({ heights, n: N, extentMeters: mapExtentMeters(), count, seed });
  setCourse({ start: generated.start, controls: generated.controls, finish: null }, `נוצר מסלול של ${count} נקודות. אפשר לגרור נקודות כדי לשנות.`);
});
$('undoCourseBtn').addEventListener('click', removeLastCoursePoint);
$('undoWaypointBtn').addEventListener('click', removeLastWaypoint);
$('clearWaypointsBtn').addEventListener('click', clearWaypoints);
syncGridOriginInputs();
const applyGridOriginInputs = () => setGridOrigin({ e: Number($('gridOriginE').value), n: Number($('gridOriginN').value) });
$('gridOriginApply').addEventListener('click', applyGridOriginInputs);
for (const id of ['gridOriginE', 'gridOriginN']) $(id).addEventListener('keydown', (event) => { if (event.key === 'Enter') applyGridOriginInputs(); });
$('gridOriginReset').addEventListener('click', () => setGridOrigin(DEFAULT_ORIGIN));
$('clearCourseBtn').addEventListener('click', () => setCourse(emptyCourse(), 'המסלול נמחק.'));
$('startNavBtn').addEventListener('click', openNavigation);
$('navBtn').addEventListener('click', openNavigation);

navGame = createNavGame({
  scene: () => scene,
  camera: () => camera,
  canvas: () => renderer?.domElement,
  observer: state.observer,
  extent: mapExtentMeters,
  mapSize: () => state.mapSize,
  worldSize: () => WORLD_SIZE,
  metersToWorld,
  height: sampleHeight,
  surfaceHeight,
  verticalScale: () => metersToWorld() * state.exaggeration,
  axes: () => navigation?.frame(),
  groundInfo: (u, v) => mapFeatures?.groundInfo(u, v),
  updateCamera: updateObserverCamera,
  gridOrigin: () => state.gridOrigin,
  // Drone mode: wider lens and a longer view (the fog moves out while flying).
  setDrone: (on) => {
    state.observer.drone = on;
    applyGameFog();
    resizeThree();
    updateObserverCamera();
  },
  // Dusk / night (sky.js skyState) or null to restore daylight.
  setLighting: setGameLighting,
  invalidate: () => { needsRender = true; },
  renderMapBase: (ctx, w, h, dpr) => drawPrintBlock(ctx, w, h, dpr, { mapStyle: 'hypsometric', tintOpacity: .4, showGrid: false, showCoordinates: false, showFeatures: true }),
  enter: enterGameMode,
  exit: exitGameMode,
});

// ——— Keyboard shortcuts, tooltips and the shortcut list (docs/UI-GUIDE.md) ———
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const keyLabel = (label) => (isMac ? label.replace('Ctrl', '⌘') : label);
for (const element of document.querySelectorAll('[data-shortcut]')) {
  const base = element.dataset.title || element.querySelector('span')?.textContent || element.getAttribute('aria-label') || '';
  element.title = `${base} (${keyLabel(shortcutLabel(element.dataset.shortcut))})`;
}
{
  const grouped = new Map();
  for (const shortcut of SHORTCUTS) {
    const entry = grouped.get(shortcut.id) || { labels: [], description: shortcut.description };
    entry.labels.push(keyLabel(shortcut.label));
    grouped.set(shortcut.id, entry);
  }
  const rows = [...grouped.values(), ...HOLD_HINTS.map((hint) => ({ labels: [hint.label], description: hint.description }))];
  $('shortcutList').innerHTML = rows.map((row) => `<dt>${row.labels.map((label) => `<kbd>${label}</kbd>`).join(' / ')}</dt><dd>${row.description}</dd>`).join('');
}
initShortcuts({
  'tool-raise': () => setTool('raise'),
  'tool-lower': () => setTool('lower'),
  'tool-smooth': () => setTool('smooth'),
  'tool-smudge': () => setTool('smudge'),
  'tool-pinch': () => setTool('pinch'),
  'tool-flatten': () => setTool('flatten'),
  'tool-pan': () => setTool('pan'),
  'tool-features': () => setTool('features'),
  'tool-course': () => setTool('course'),
  'tool-drop': () => setTool('drop'),
  'tool-waypoint': () => setTool('waypoint'),
  'open-navigation': () => openNavigation(),
  'toggle-topo': () => setTopo(!state.topo),
  'toggle-rain': () => rainSimulation?.toggle(),
  'new-terrain': () => toggleNewTerrainMenu(),
  'brush-smaller': () => setBrushSize(Math.min(state.brush - 5, state.brush * .9)),
  'brush-larger': () => setBrushSize(Math.max(state.brush + 5, state.brush * 1.1)),
  'strength-down': () => setStrength(state.strength - 2),
  'strength-up': () => setStrength(state.strength + 2),
  'zoom-in': () => stepMapZoom(1),
  'zoom-out': () => stepMapZoom(-1),
  'zoom-reset': () => resetMapView(false),
  undo: () => undo(),
  redo: () => redo(),
  help: () => helpDialog.showModal(),
});

// Hold Space over the map to pan temporarily (like most drawing apps).
document.addEventListener('keydown', (event) => {
  if (event.code !== 'Space' || state.navigating || !mouseIsOverMap() || document.querySelector('dialog[open]')) return;
  const target = event.target;
  if (target instanceof Element && target.closest('input:not([type="range"]), select, textarea')) return;
  event.preventDefault();
  setTempPan(true);
});
document.addEventListener('keyup', (event) => {
  if (event.code === 'Space' && state.tempPan) {
    event.preventDefault(); // don't let a focused button treat the release as a click
    setTempPan(false);
  }
  // Stop a lone Alt from moving focus to the browser menu bar on Windows.
  if (event.key === 'Alt' && state.drawing) event.preventDefault();
});
addEventListener('blur', () => setTempPan(false));

// ——— Autosave and restore (src/persistence.js) ———
function scheduleSave() {
  autosave?.schedule();
}

function collectProject() {
  if (state.exercise) return null;
  return {
    heights,
    mapSize: state.mapSize,
    settings: {
      localSpacing: state.localSpacing,
      brushMeters: state.brush,
      strength: state.strength,
      topo: state.topo,
      interval: state.interval,
      scale: state.scale,
      exaggeration: state.exaggeration,
      gridOrigin: { ...state.gridOrigin },
    },
    features: mapFeatures?.serialize() || [],
    course: cloneCourse(state.course),
    waypoints: state.waypoints.map((p) => ({ ...p })),
  };
}

let saveIndicatorTimer = null;
function flashSaved() {
  const indicator = $('saveIndicator');
  indicator.textContent = 'נשמר ✓';
  indicator.classList.add('visible');
  clearTimeout(saveIndicatorTimer);
  saveIndicatorTimer = setTimeout(() => indicator.classList.remove('visible'), 1600);
}

function restoreProject(saved) {
  const settings = saved.settings || {};
  const spacing = [5, 10].includes(settings.localSpacing) ? settings.localSpacing : state.localSpacing;
  if (gridResolution(saved.mapSize, spacing) ** 2 !== saved.heights.length) return false;
  if (saved.mapSize !== state.mapSize || spacing !== state.localSpacing) setMapSize(saved.mapSize, saved.heights, spacing);
  else heights.set(saved.heights);
  // Older saves stored the brush as a percentage (`brush`); only metre values are restored.
  if (settings.brushMeters) setBrushSize(settings.brushMeters);
  if (settings.strength) setStrength(settings.strength);
  if ([25000, 50000, 100000].includes(settings.scale)) {
    state.scale = settings.scale;
    $('scaleSelect').value = String(settings.scale);
  }
  if ([5, 10, 20].includes(settings.interval)) {
    state.interval = settings.interval;
    $('intervalSelect').value = String(settings.interval);
  }
  if (settings.exaggeration >= 1 && settings.exaggeration <= 10) {
    state.exaggeration = settings.exaggeration;
    $('exaggerationRange').value = String(settings.exaggeration);
    $('exaggerationValue').value = `×${settings.exaggeration.toFixed(1)}`;
  }
  mapFeatures?.load(saved.features);
  state.course = sanitizeCourse(saved.course);
  state.waypoints = Array.isArray(saved.waypoints)
    ? saved.waypoints.filter((p) => Number.isFinite(p?.u) && Number.isFinite(p?.v)).map((p) => ({ u: clamp(p.u, 0, 1), v: clamp(p.v, 0, 1) })).slice(0, 40)
    : [];
  state.gridOrigin = sanitizeOrigin(settings.gridOrigin);
  syncGridOriginInputs();
  updateCourseUI();
  setTopo(Boolean(settings.topo));
  scheduleUpdate();
  return true;
}

// ——— Clearing the map (the "ניקוי המפה" section of the new-terrain menu) ———
// Terrain, features and course can be cleared separately or together; one undo step.
function mapContents() {
  const { min, max } = terrainStats();
  return {
    terrain: Math.max(Math.abs(min), Math.abs(max)) > .05,
    features: mapFeatures?.stats().count || 0,
    course: coursePoints(state.course).length ? state.course.controls.length + 1 : 0,
    peak: Math.round(max),
  };
}

function updateResetUI() {
  const contents = mapContents();
  const info = {
    terrain: contents.terrain ? `שיא ${contents.peak} מ׳` : 'כבר שטוח',
    features: contents.features ? `${contents.features} ${contents.features === 1 ? 'קו' : 'קווים'}` : 'אין',
    course: contents.course ? `${contents.course} נקודות` : 'אין',
  };
  for (const button of document.querySelectorAll('[data-reset]')) {
    const kind = button.dataset.reset;
    if (kind === 'all') button.disabled = !contents.terrain && !contents.features && !contents.course;
    else {
      button.disabled = !contents[kind];
      button.querySelector('small').textContent = info[kind];
    }
  }
}

function resetMap({ terrain = false, features = false, course = false }) {
  const all = terrain && features && course;
  const contents = mapContents();
  terrain &&= contents.terrain;
  features &&= contents.features > 0;
  course &&= contents.course > 0;
  if (!terrain && !features && !course) return;
  stopDrawing();
  rainSimulation?.stop();
  mapFeatures?.cancel(false);
  pushUndo();
  if (terrain) heights.fill(0);
  if (features) mapFeatures?.clearAll();
  if (course) { state.course = emptyCourse(); updateCourseUI(); }
  if (all) state.waypoints = [];
  hideCursorReadout();
  scheduleUpdate();
  scheduleSave();
  updateResetUI();
  const parts = [terrain && 'התבליט', features && 'התכסית', course && 'המסלול'].filter(Boolean);
  const verb = parts.length > 1 ? 'נמחקו' : features ? 'נמחקה' : 'נמחק';
  const message = all ? 'המפה נוקתה.' : `${parts.join(' ו')} ${verb}.`;
  showToast(message, { action: { label: 'ביטול', run: undo } });
}

function startFresh() {
  resetMap({ terrain: true, features: true, course: true });
}

syncDetailControls(); // brush limits must match the map before saved settings are applied
const launchParams = new URLSearchParams(location.search);
const savedProject = launchParams.has('fresh') ? null : loadProject();
const restored = savedProject ? restoreProject(savedProject) : false;
autosave = createAutosave(collectProject, { onSaved: flashSaved });
if (restored) {
  showToast('העבודה הקודמת שוחזרה.', { action: { label: 'התחלה חדשה', run: startFresh } });
}
window.__TOPOLAB_CLEAR_SAVE__ = clearProject;

syncDetailControls();
syncToolUI();
updateHistoryButtons();
updateMapReferenceScale();
updateReadouts();
updateMapScaleText();
drawMap();

const timeParam = new URLSearchParams(location.search).get('t');
if (timeParam !== null) window.__seek(Number(timeParam));
