import { createSheepGame } from './sheep.js';
import { initPanelSplitter } from './splitter.js';
import { initNavigation } from './nav.js';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { contours } from 'd3-contour';

const $ = (id) => document.getElementById(id);
const MAP_GRID_SIZES = { 4: 96, 6: 144, 8: 192 };
const MAP_ZOOM_LEVELS = [1, 1.25, 1.5, 2, 3, 4];
let N = MAP_GRID_SIZES[4];
let WORLD_SIZE = 10;

const MIN_HEIGHT = -100;
const MAX_HEIGHT = 200;
const BASE_Y = -4.15;
const EYE_HEIGHT_METERS = 1.7;
const OBSERVER_FOV = 65;
let heights = new Float32Array(N * N);
const state = {
  tool: 1,
  mapSize: 4,
  brush: 24,
  strength: 14,
  topo: false,
  focus: null,
  interval: 10,
  scale: 25000,
  exaggeration: 1.6,
  mapView: { zoom: 1, panX: 0, panY: 0 },
  panMode: false,
  pointer: null,
  drawing: false,
  observerDrag: null,
  observer: { placed: false, firstPerson: false, placing: false, u: .5, v: .5, heading: 0, tilt: -5 },
  exercise: false,
  exerciseBackup: null,
};

const undoStack = [];
let updateQueued = false;
let holdTimer = null;
let lastStamp = null;
let lastBrushTime = 0;
let toastTimer = null;
let needsRender = true;
let sheepGame = null;
let navigation = null;
let randomState = 0x72f4a91d;
let lastRandomHillCount = 0;
let mapPanDrag = null;
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
  return state.scale / 50;
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

function clampMapPan(baseSide = mapFitSide()) {
  const limit = Math.max(0, (baseSide * state.mapView.zoom - baseSide) / 2);
  state.mapView.panX = clamp(state.mapView.panX, -limit, limit);
  state.mapView.panY = clamp(state.mapView.panY, -limit, limit);
  if (state.mapView.zoom === 1) {
    state.mapView.panX = 0;
    state.mapView.panY = 0;
  }
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
  north.style.left = `${offsetX + 14}px`;
  north.style.top = `${offsetY + 13}px`;
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
  $('mapViewLabel').textContent = `קנה מידה ${scale} · זום ${zoomPct}%`;
  $('scaleNote').textContent = `קנה מידה בסיסי ${scale} · זום תצוגה ${zoomPct}%`;
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

function setPanMode(enabled) {
  stopDrawing();
  state.panMode = enabled;
  const button = $('panMapBtn');
  button.classList.toggle('active', enabled);
  button.setAttribute('aria-pressed', String(enabled));
  mapCanvas.classList.toggle('pan-mode', enabled);
  if (enabled) {
    state.observer.placing = false;
    sheepGame?.cancelPlacement?.();
    updateObserverUI();
  }
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
  ctx.strokeStyle = 'rgba(55,76,80,.78)';
  ctx.lineWidth = 1.1 * dpr;
  ctx.strokeRect(1 * dpr, 1 * dpr, w - 2 * dpr, h - 2 * dpr);
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
  for (let i = 0; i <= count; i++) {
    if (i !== count && i % labelEvery !== 0) continue;
    const value = String(Math.round(200000 + i * step));
    const x = clamp(i * w / count, 23 * dpr, w - 23 * dpr);
    const width = ctx.measureText(value).width + 5 * dpr;
    for (const y of [10 * dpr, h - 10 * dpr]) {
      ctx.fillStyle = 'rgba(253,252,248,.94)';
      ctx.fillRect(x - width / 2, y - 6 * dpr, width, 12 * dpr);
      ctx.fillStyle = '#4e6870';
      ctx.fillText(value, x, y);
    }
  }
  for (let i = 0; i <= count; i++) {
    if (i !== count && i % labelEvery !== 0) continue;
    const value = String(Math.round(600000 + (count - i) * step));
    const y = clamp(i * h / count, 10 * dpr, h - 10 * dpr);
    const width = ctx.measureText(value).width + 5 * dpr;
    for (const side of ['left', 'right']) {
      const left = side === 'left';
      const x = left ? 4 * dpr : w - 4 * dpr;
      ctx.fillStyle = 'rgba(253,252,248,.94)';
      ctx.fillRect(left ? 0 : w - width, y - 6 * dpr, width, 12 * dpr);
      ctx.fillStyle = '#4e6870';
      ctx.textAlign = left ? 'left' : 'right';
      ctx.fillText(value, x, y);
    }
  }
  ctx.restore();
}

function drawBrush() {
  if (!state.pointer) return;
  const { gx, gy } = state.pointer;
  const x = (gx / (N - 1)) * mapCanvas.width;
  const y = (gy / (N - 1)) * mapCanvas.height;
  const radius = (state.brush / 100 * N / (N - 1)) * mapCanvas.width;
  mapCtx.save();
  mapCtx.beginPath();
  mapCtx.arc(x, y, radius, 0, Math.PI * 2);
  mapCtx.fillStyle = state.tool > 0 ? 'rgba(238,248,217,.12)' : 'rgba(238,184,151,.13)';
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

function drawMap() {
  if (!mapCanvas.width || !mapCanvas.height) return;
  mapCtx.clearRect(0, 0, mapCanvas.width, mapCanvas.height);
  drawRaster();
  if (state.topo) {
    drawGridLines(mapCtx, mapCanvas.width, mapCanvas.height, mapDpr);
    drawContours(mapCtx, mapCanvas.width, mapCanvas.height, mapDpr);
    drawGridLabels(mapCtx, mapCanvas.width, mapCanvas.height, mapDpr);
  }
  sheepGame?.draw(mapCtx, mapCanvas, mapDpr);
  drawObserver();
  if (!sheepGame?.placing && !state.observer.placing && !state.observerDrag && (!state.observer.firstPerson || state.drawing)) drawBrush();
}

// Same drawing as the on-screen topographic map, composed on a paper background for print.
function drawPrintBlock(ctx, w, h, dpr) {
  ctx.fillStyle = '#fdfcf8';
  ctx.fillRect(0, 0, w, h);
  drawGridLines(ctx, w, h, dpr);
  drawContours(ctx, w, h, dpr);
  drawGridLabels(ctx, w, h, dpr);
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

function createSkirtGeometry() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(perimeter.length * 18), 3).setUsage(THREE.DynamicDrawUsage));
  return geometry;
}

function installContourShader(material) {
  contourUniforms = {
    uContours: { value: 0 },
    uInterval: { value: state.interval },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, contourUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aHeight;\nvarying float vTerrainHeight;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTerrainHeight = aHeight;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vTerrainHeight;
        uniform float uContours;
        uniform float uInterval;
      `)
      .replace('#include <color_fragment>', `#include <color_fragment>
        if (uContours > 0.5) {
          float coord = vTerrainHeight / uInterval;
          float fw = max(fwidth(coord), 0.0001);
          float distToLine = abs(fract(coord + 0.5) - 0.5);
          float line = 1.0 - smoothstep(fw * 0.35, fw * 1.35, distToLine);
          float majorCoord = vTerrainHeight / 100.0;
          float majorFw = max(fwidth(majorCoord), 0.0001);
          float majorDist = abs(fract(majorCoord + 0.5) - 0.5);
          float majorLine = 1.0 - smoothstep(majorFw * 0.35, majorFw * 1.25, majorDist);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.24, 0.22, 0.15), line * 0.62);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.17, 0.12), majorLine * 0.78);
        }
      `);
  };
  material.customProgramCacheKey = () => 'terrain-contour-v1';
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
    scene.background = new THREE.Color(0xdfe6da);
    scene.fog = new THREE.Fog(0xdfe6da, 31, 72);
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

    scene.add(new THREE.HemisphereLight(0xf4f3df, 0x526451, 1.45));
    sunLight = new THREE.DirectionalLight(0xfff3da, 2.15);
    sunLight.position.set(-9, 16, 10);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(1536, 1536);
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
      new THREE.MeshStandardMaterial({ color: 0xcbd5c5, roughness: 1 }),
    );
    groundMesh.position.y = BASE_Y - .05;
    groundMesh.receiveShadow = true;
    scene.add(groundMesh);

    baseMesh = new THREE.Mesh(
      new THREE.BoxGeometry(WORLD_SIZE + .12, .36, WORLD_SIZE + .12),
      new THREE.MeshStandardMaterial({ color: 0x40564a, roughness: .96 }),
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
    skirtMesh = new THREE.Mesh(skirtGeometry, new THREE.MeshStandardMaterial({ color: 0x62705a, roughness: 1 }));
    skirtMesh.castShadow = true;
    skirtMesh.receiveShadow = true;
    scene.add(skirtMesh);

    const resizeObserver = new ResizeObserver(resizeThree);
    resizeObserver.observe(sceneContainer);
    resizeThree();
    updateTerrain();
    let lastFrameTime = performance.now();
    renderer.setAnimationLoop(() => {
      const now = performance.now();
      const dt = Math.min((now - lastFrameTime) / 1000, .1);
      lastFrameTime = now;
      const axes = navigation?.frame();
      if (axes?.active) applyNavigation(axes, dt);
      const moved = state.observer.firstPerson ? false : controls.update();
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
  camera.fov = state.observer.firstPerson ? OBSERVER_FOV : camera.aspect < 0.85 ? 52 : 43;
  camera.near = state.observer.firstPerson ? .003 : .1;
  camera.updateProjectionMatrix();
  if (scene) renderer.render(scene, camera);
  needsRender = false;
}

function updateSkirt() {
  if (!skirtGeometry) return;
  const array = skirtGeometry.attributes.position.array;
  const { min } = terrainStats();
  const bottom = Math.min(-0.55, min * metersToWorld() * state.exaggeration - 0.35);
  if (baseMesh) baseMesh.position.y = bottom - 0.18;
  if (groundMesh) groundMesh.position.y = bottom - 0.24;
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

function updateTerrain() {
  if (!terrainGeometry) return;
  const positions = terrainGeometry.attributes.position;
  const colors = terrainGeometry.attributes.color;
  const meterValues = terrainGeometry.attributes.aHeight;
  for (let i = 0; i < heights.length; i++) {
    const h = heights[i];
    positions.array[i * 3 + 1] = h * metersToWorld() * state.exaggeration;
    meterValues.array[i] = h;
    const [r, g, b] = heightColor(h, !state.topo).map((v) => v / 255);
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
  if (contourUniforms) {
    contourUniforms.uContours.value = state.topo ? 1 : 0;
    contourUniforms.uInterval.value = state.interval;
  }
  if (state.observer.firstPerson) updateObserverCamera();
  sheepGame?.update3D();
  needsRender = true;
}

function updateObserverCamera() {
  const observer = state.observer;
  if (!camera || !observer.placed) return;
  const groundHeight = sampleHeight(observer.u, observer.v);
  const verticalScale = metersToWorld() * state.exaggeration;
  camera.position.set(
    (observer.u - .5) * WORLD_SIZE,
    groundHeight * verticalScale + EYE_HEIGHT_METERS * metersToWorld(),
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

function resetCamera() {
  if (state.observer.firstPerson) {
    updateObserverCamera();
    return;
  }
  if (!camera || !controls) return;
  const sizeFactor = state.mapSize / 4;
  camera.position.copy(defaultCamera).multiplyScalar(sizeFactor);
  controls.target.copy(defaultTarget);
  controls.update();
  needsRender = true;
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
    sunLight.position.set(-9 * sizeFactor, 16 * sizeFactor, 10 * sizeFactor);
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

function resampleForMapSize(oldHeights, oldN, oldSize, newN, newSize) {
  const next = new Float32Array(newN * newN);
  for (let y = 0; y < newN; y++) {
    for (let x = 0; x < newN; x++) {
      const oldU = ((x / (newN - 1) - .5) * newSize / oldSize) + .5;
      const oldV = ((y / (newN - 1) - .5) * newSize / oldSize) + .5;
      if (oldU < 0 || oldU > 1 || oldV < 0 || oldV > 1) continue;
      const gx = oldU * (oldN - 1);
      const gy = oldV * (oldN - 1);
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const x1 = Math.min(oldN - 1, x0 + 1);
      const y1 = Math.min(oldN - 1, y0 + 1);
      const tx = gx - x0;
      const ty = gy - y0;
      const top = lerp(oldHeights[y0 * oldN + x0], oldHeights[y0 * oldN + x1], tx);
      const bottom = lerp(oldHeights[y1 * oldN + x0], oldHeights[y1 * oldN + x1], tx);
      next[y * newN + x] = lerp(top, bottom, ty);
    }
  }
  return next;
}

function setMapSize(newSize, restoredHeights = null) {
  if (!MAP_GRID_SIZES[newSize] || newSize === state.mapSize) return;
  stopDrawing();
  const nextN = MAP_GRID_SIZES[newSize];
  const nextHeights = restoredHeights
    ? new Float32Array(restoredHeights)
    : resampleForMapSize(heights, N, state.mapSize, nextN, newSize);

  const previousMapSize = state.mapSize;
  state.mapSize = newSize;
  N = nextN;
  WORLD_SIZE = newSize * 2.5;
  heights = nextHeights;
  state.pointer = null;
  state.mapView.zoom = 1;
  state.mapView.panX = 0;
  state.mapView.panY = 0;
  lastStamp = null;
  $('mapSizeSelect').value = String(newSize);
  const center = Math.floor((N - 1) / 2);
  $('pointHeight').textContent = `${Math.round(heights[center * N + center])} מ׳`;

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
    baseMesh.geometry = new THREE.BoxGeometry(WORLD_SIZE + .12, .36, WORLD_SIZE + .12);
  }
  sheepGame?.resize(previousMapSize, newSize);
  updateSceneForMapSize();
  updateMapScaleText();
  resizeMap();
  scheduleUpdate();
  if (!restoredHeights) {
    showToast(`גודל המפה שונה ל־${newSize}×${newSize} ק״מ. פני השטח הקיימים נשמרו במרכז.`);
  }
}

// ——— Shared state updates ———
function updateReadouts() {
  const { max } = terrainStats();
  $('maxHeight').textContent = `שיא ${Math.round(max)} מ׳`;
  $('undoBtn').disabled = undoStack.length === 0;
  if (state.exercise) {
    const lines = countPositiveContourLevels();
    const complete = (max >= 60 ? 1 : 0) + (lines >= 3 ? 1 : 0);
    $('exerciseProgress').textContent = `${complete} מתוך 2`;
  }
}

function scheduleUpdate() {
  if (updateQueued) return;
  updateQueued = true;
  updateReadouts();
  requestAnimationFrame(() => {
    updateQueued = false;
    updateTerrain();
    drawMap();
  });
}

function pushUndo() {
  undoStack.push({ heights: new Float32Array(heights), mapSize: state.mapSize });
  if (undoStack.length > 24) undoStack.shift();
  $('undoBtn').disabled = false;
}

function setTool(tool) {
  if (state.panMode) setPanMode(false);
  state.tool = tool;
  const raising = tool > 0;
  $('raiseBtn').classList.toggle('active', raising);
  $('raiseBtn').setAttribute('aria-pressed', String(raising));
  $('lowerBtn').classList.toggle('active', !raising);
  $('lowerBtn').setAttribute('aria-pressed', String(!raising));
  $('toolMode').textContent = raising ? 'הגבהה' : 'הנמכה';
  drawMap();
}

function setTopo(enabled) {
  state.topo = enabled;
  $('topoBtn').setAttribute('aria-pressed', String(enabled));
  $('topoBtn').querySelector('span').textContent = enabled ? 'חזרה למצב פיסול' : 'הצג מפה טופוגרפית';
  $('mapKicker').textContent = enabled ? 'קריאת המפה' : 'משטח עריכה';
  $('mapTitle').textContent = enabled ? 'מפה טופוגרפית' : 'מבט מלמעלה';
  $('mapModeLabel').textContent = enabled ? `קו גובה כל ${state.interval} מ׳` : 'גובה 0 מ׳';
  document.querySelector('.map-panel').classList.toggle('topographic', enabled);
  $('intervalControl').hidden = !enabled;
  $('mapLegend').hidden = enabled;
  updateMapScaleText();
  updateTerrain();
  drawMap();
}

function clearHeights(record = true) {
  if (record) pushUndo();
  heights.fill(0);
  state.pointer = null;
  $('pointHeight').textContent = '0 מ׳';
  scheduleUpdate();
}

function applyPreset(name) {
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
  showToast({ hill: 'גבעה', ridge: 'רכס', valley: 'עמק', crater: 'מכתש' }[name] + ' נוספה למשטח. אפשר להמשיך ולפסל.');
}

function terrainRandom() {
  randomState = (randomState + 0x6D2B79F5) >>> 0;
  let value = randomState;
  value = Math.imul(value ^ value >>> 15, value | 1);
  value ^= value + Math.imul(value ^ value >>> 7, value | 61);
  return ((value ^ value >>> 14) >>> 0) / 4294967296;
}

function applyRandomTerrain() {
  stopDrawing();
  closePopovers();
  pushUndo();
  const hillCount = terrainRandom() < .5 ? 2 : 3;
  const angle = terrainRandom() * Math.PI;
  const axisX = Math.cos(angle);
  const axisY = Math.sin(angle);
  const span = hillCount === 2 ? .86 : .98;
  const centerX = (terrainRandom() - .5) * .08;
  const centerY = (terrainRandom() - .5) * .08;
  const hills = [];

  for (let i = 0; i < hillCount; i++) {
    const along = (i / (hillCount - 1) - .5) * span + (terrainRandom() - .5) * .07;
    const across = (terrainRandom() - .5) * .18;
    hills.push({
      x: centerX + axisX * along - axisY * across,
      y: centerY + axisY * along + axisX * across,
      height: 78 + terrainRandom() * 56,
      radiusX: .17 + terrainRandom() * .055,
      radiusY: .18 + terrainRandom() * .065,
      rotation: angle + (terrainRandom() - .5) * .9,
    });
  }

  const connectors = hills.slice(1).map((hill, i) => ({
    from: hills[i],
    to: hill,
    height: Math.min(hills[i].height, hill.height) * (.5 + terrainRandom() * .1),
    width: .065 + terrainRandom() * .025,
  }));

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const nx = (x / (N - 1) - .5) * 2;
      const ny = (y / (N - 1) - .5) * 2;
      let height = 0;

      for (const hill of hills) {
        const dx = nx - hill.x;
        const dy = ny - hill.y;
        const cos = Math.cos(hill.rotation);
        const sin = Math.sin(hill.rotation);
        const localX = (dx * cos + dy * sin) / hill.radiusX;
        const localY = (-dx * sin + dy * cos) / hill.radiusY;
        const dome = hill.height * Math.exp(-(localX * localX + localY * localY) * 1.65);
        height = Math.max(height, dome);
      }

      for (const connector of connectors) {
        const dx = connector.to.x - connector.from.x;
        const dy = connector.to.y - connector.from.y;
        const lengthSquared = dx * dx + dy * dy;
        const t = clamp(((nx - connector.from.x) * dx + (ny - connector.from.y) * dy) / lengthSquared, 0, 1);
        const distance = Math.hypot(nx - (connector.from.x + dx * t), ny - (connector.from.y + dy * t));
        const saddle = connector.height * (.86 + .14 * Math.sin(t * Math.PI));
        const ridge = saddle * Math.exp(-((distance / connector.width) ** 2) * 1.5);
        height = Math.max(height, ridge);
      }

      heights[y * N + x] = clamp(height, MIN_HEIGHT, MAX_HEIGHT);
    }
  }

  lastRandomHillCount = hillCount;
  state.pointer = null;
  scheduleUpdate();
  showToast(`נוצרו ${hillCount} כיפות מחוברות. אפשר להמשיך ולפסל או ליצור תצורה חדשה.`);
}

function applyBrush(gx, gy, amount) {
  const radius = state.brush / 100 * N;
  const minX = Math.max(0, Math.floor(gx - radius));
  const maxX = Math.min(N - 1, Math.ceil(gx + radius));
  const minY = Math.max(0, Math.floor(gy - radius));
  const maxY = Math.min(N - 1, Math.ceil(gy + radius));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const d = Math.hypot(x - gx, y - gy) / radius;
      if (d >= 1) continue;
      const falloff = (1 - d * d) ** 2;
      const i = y * N + x;
      heights[i] = clamp(heights[i] + amount * falloff, MIN_HEIGHT, MAX_HEIGHT);
    }
  }
  scheduleUpdate();
}

function applyTimedBrush(gx, gy) {
  const now = performance.now();
  const elapsed = clamp((now - lastBrushTime) / 1000, 0, .15);
  lastBrushTime = now;
  applyBrush(gx, gy, state.tool * state.strength * elapsed);
}

function eventToGrid(event) {
  const rect = mapCanvas.getBoundingClientRect();
  return {
    gx: clamp((event.clientX - rect.left) / rect.width * (N - 1), 0, N - 1),
    gy: clamp((event.clientY - rect.top) / rect.height * (N - 1), 0, N - 1),
  };
}

function updatePointReadout(pointer) {
  const x = Math.round(pointer.gx);
  const y = Math.round(pointer.gy);
  $('pointHeight').textContent = `${Math.round(heights[y * N + x])} מ׳`;
}

function stopDrawing(event) {
  if (mapPanDrag) {
    if (mapCanvas.hasPointerCapture(mapPanDrag.pointerId)) mapCanvas.releasePointerCapture(mapPanDrag.pointerId);
    mapPanDrag = null;
    mapCanvas.classList.remove('is-panning');
  }
  state.observerDrag = null;
  if (state.drawing) {
    state.drawing = false;
    lastStamp = null;
    clearInterval(holdTimer);
    holdTimer = null;
  }
  if (event && mapCanvas.hasPointerCapture(event.pointerId)) mapCanvas.releasePointerCapture(event.pointerId);
}

mapCanvas.addEventListener('pointerdown', (event) => {
  const panRequested = state.panMode || (event.pointerType === 'mouse' && event.button === 1);
  if (panRequested) {
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
    return;
  }
  if (event.button !== 0 && event.pointerType === 'mouse') return;
  event.preventDefault();
  const next = eventToGrid(event);
  if (sheepGame?.place(next.gx / (N - 1), next.gy / (N - 1))) return;
  if (state.observer.placing) {
    state.pointer = next;
    updatePointReadout(next);
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
  pushUndo();
  state.drawing = true;
  state.pointer = next;
  lastStamp = { ...state.pointer };
  mapCanvas.setPointerCapture(event.pointerId);
  lastBrushTime = performance.now() - 80;
  applyTimedBrush(state.pointer.gx, state.pointer.gy);
  updatePointReadout(state.pointer);
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
    $('pointHeight').textContent = '—';
    drawMap();
    return;
  }
  const next = eventToGrid(event);
  state.pointer = next;
  updatePointReadout(next);
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
    const previous = lastStamp || next;
    const distance = Math.hypot(next.gx - previous.gx, next.gy - previous.gy);
    const spacing = Math.max(1.5, state.brush / 100 * N * .18);
    const steps = Math.max(1, Math.ceil(distance / spacing));
    const now = performance.now();
    const elapsed = clamp((now - lastBrushTime) / 1000, 0, .15);
    const amount = state.tool * state.strength * elapsed / steps;
    lastBrushTime = now;
    for (let i = 1; i <= steps; i++) {
      applyBrush(lerp(previous.gx, next.gx, i / steps), lerp(previous.gy, next.gy, i / steps), amount);
    }
    lastStamp = { ...next };
  } else drawMap();
});

mapCanvas.addEventListener('pointerup', stopDrawing);
mapCanvas.addEventListener('pointercancel', stopDrawing);
mapCanvas.addEventListener('pointerleave', (event) => {
  if (state.observerDrag && event.pointerType === 'mouse') stopDrawing(event);
  else if (!state.drawing) { state.pointer = null; drawMap(); }
  else if (event.pointerType === 'mouse') stopDrawing(event);
});
mapCanvas.addEventListener('contextmenu', (event) => event.preventDefault());

$('mapWrap').addEventListener('wheel', (event) => {
  event.preventDefault();
  wheelZoomDelta += event.deltaY;
  if (Math.abs(wheelZoomDelta) < 35) return;
  stepMapZoom(wheelZoomDelta < 0 ? 1 : -1, event.clientX, event.clientY);
  wheelZoomDelta = 0;
}, { passive: false });

mapCanvas.addEventListener('keydown', (event) => {
  if (state.panMode) {
    const panStep = event.shiftKey ? 100 : 40;
    if (event.key === 'ArrowLeft') state.mapView.panX -= panStep;
    else if (event.key === 'ArrowRight') state.mapView.panX += panStep;
    else if (event.key === 'ArrowUp') state.mapView.panY -= panStep;
    else if (event.key === 'ArrowDown') state.mapView.panY += panStep;
    else if (event.key === '+' || event.key === '=') { stepMapZoom(1); event.preventDefault(); return; }
    else if (event.key === '-') { stepMapZoom(-1); event.preventDefault(); return; }
    else if (event.key === 'Home' || event.key === '0') { resetMapView(); event.preventDefault(); return; }
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
  else if (event.key === ' ' || event.key === 'Enter') {
    event.preventDefault();
    pushUndo();
    applyBrush(current.gx, current.gy, state.tool * state.strength * .12);
  } else if (event.key === '+' || event.key === '=') setTool(1);
  else if (event.key === '-') setTool(-1);
  else return;
  event.preventDefault();
  current.gx = clamp(current.gx, 0, N - 1);
  current.gy = clamp(current.gy, 0, N - 1);
  state.pointer = current;
  updatePointReadout(current);
  drawMap();
});

// ——— Controls and guided exercise ———
function showToast(message, error = false) {
  const toast = $('toast');
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.toggle('error', error);
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3600);
}

function updateExercise() {
  if (!state.exercise) return;
  updateReadouts();
}

function startExercise() {
  if (state.exercise) return;
  state.exerciseBackup = { heights: new Float32Array(heights), mapSize: state.mapSize, topo: state.topo };
  state.exercise = true;
  $('checkExerciseBtn').textContent = 'בדיקה';
  heights.fill(0);
  undoStack.length = 0;
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
  if (backup.mapSize !== state.mapSize) setMapSize(backup.mapSize, backup.heights);
  else heights.set(backup.heights);
  $('exerciseStrip').hidden = true;
  $('exerciseBtn').classList.remove('active');
  setTopo(backup.topo);
  scheduleUpdate();
}

function closePopovers() {
  for (const [popoverId, triggerId] of [['brushPopover', 'brushSettingsBtn'], ['presetsPopover', 'presetsBtn']]) {
    $(popoverId).hidden = true;
    $(triggerId).setAttribute('aria-expanded', 'false');
  }
}

function togglePopover(popoverId, triggerId) {
  const open = $(popoverId).hidden;
  closePopovers();
  if (open) {
    $(popoverId).hidden = false;
    $(triggerId).setAttribute('aria-expanded', 'true');
  }
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
    button.querySelector('span').textContent = active ? 'יציאה' : 'מסך מלא';
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
$('brushSettingsBtn').addEventListener('click', () => togglePopover('brushPopover', 'brushSettingsBtn'));
$('presetsBtn').addEventListener('click', () => togglePopover('presetsPopover', 'presetsBtn'));
$('closeBrushBtn').addEventListener('click', closePopovers);
$('closePresetsBtn').addEventListener('click', closePopovers);
document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('.rail-popover, .rail-button')) closePopovers();
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  sheepGame?.cancelPlacement();
  closePopovers();
  if (state.focus) { setFocus(state.focus); return; }
  if (state.observer.placing || state.observer.firstPerson) exitObserver();
});

$('observerBtn').addEventListener('click', () => {
  sheepGame?.cancelPlacement();
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
$('raiseBtn').addEventListener('click', () => setTool(1));
$('lowerBtn').addEventListener('click', () => setTool(-1));
$('panMapBtn').addEventListener('click', () => setPanMode(!state.panMode));
$('mapZoomInBtn').addEventListener('click', () => stepMapZoom(1));
$('mapZoomOutBtn').addEventListener('click', () => stepMapZoom(-1));
$('centerMapBtn').addEventListener('click', () => resetMapView());
$('randomTerrainBtn').addEventListener('click', applyRandomTerrain);
$('topoBtn').addEventListener('click', () => setTopo(!state.topo));
$('brushRange').addEventListener('input', (event) => {
  state.brush = Number(event.target.value);
  $('brushValue').value = event.target.value;
  drawMap();
});
$('strengthRange').addEventListener('input', (event) => {
  state.strength = Number(event.target.value);
  $('strengthValue').value = `${event.target.value} מ׳/ש׳`;
});
$('mapSizeSelect').addEventListener('change', (event) => {
  const newSize = Number(event.target.value);
  if (newSize === state.mapSize) return;
  pushUndo();
  closePopovers();
  setMapSize(newSize);
});
function updateMapReferenceScale(showMessage = false) {
  stopDrawing();
  state.pointer = null;
  $('pointHeight').textContent = '—';
  updateMapScaleText();
  resizeMap();
  if (showMessage) {
    showToast(`קנה המידה עודכן. כל משבצת מייצגת ${formatMapDistance(gridCellMeters())}; הזום ונתוני השטח לא השתנו.`);
  }
}

$('scaleSelect').addEventListener('change', (event) => {
  state.scale = Number(event.target.value);
  updateMapReferenceScale(true);
});
$('intervalSelect').addEventListener('change', (event) => {
  state.interval = Number(event.target.value);
  $('mapModeLabel').textContent = `קו גובה כל ${state.interval} מ׳`;
  updateTerrain();
  drawMap();
});
let exportBusy = false;
$('exportPdfBtn').addEventListener('click', async () => {
  if (exportBusy) return;
  exportBusy = true;
  $('exportPdfBtn').disabled = true;
  try {
    const { exportTopographicPdf } = await import('./print.js');
    await exportTopographicPdf({
      sizeKm: state.mapSize,
      interval: state.interval,
      scale: state.scale,
      stats: terrainStats(),
      colorStops,
      colorMin: MIN_HEIGHT,
      colorMax: MAX_HEIGHT,
      mapBlock: drawPrintBlock,
    });
    showToast('המפה יוצאה ל־PDF בהצלחה.');
  } catch (error) {
    console.error('PDF export failed', error);
    showToast('הייצוא ל־PDF נכשל. נסו שוב.', true);
  } finally {
    exportBusy = false;
    $('exportPdfBtn').disabled = false;
  }
});
$('exaggerationRange').addEventListener('input', (event) => {
  state.exaggeration = Number(event.target.value);
  $('exaggerationValue').value = `×${state.exaggeration.toFixed(1)}`;
  updateTerrain();
});
$('undoBtn').addEventListener('click', () => {
  const previous = undoStack.pop();
  if (!previous) return;
  if (previous.mapSize !== state.mapSize) setMapSize(previous.mapSize, previous.heights);
  else heights.set(previous.heights);
  scheduleUpdate();
  showToast('הפעולה האחרונה בוטלה.');
});
$('resetBtn').addEventListener('click', () => {
  clearHeights(true);
  showToast('המשטח חזר לגובה 0 מ׳.');
});
$('resetCameraBtn').addEventListener('click', () => {
  if (state.observer.firstPerson) exitObserver();
  resetCamera();
});
$('topCameraBtn').addEventListener('click', () => {
  if (state.observer.firstPerson) exitObserver();
  if (!camera || !controls) return;
  camera.position.set(0, 17 * state.mapSize / 4, .01);
  controls.target.set(0, 0, 0);
  controls.update();
  needsRender = true;
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
window.__APP_STATS__ = () => ({
  gridVertices: N * N,
  gridResolution: N,
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
  randomHillCount: lastRandomHillCount,
  updateQueued,
  cameraPosition: camera ? camera.position.toArray() : null,
  cameraDirection: camera ? camera.getWorldDirection(new THREE.Vector3()).toArray() : null,
  triangles: renderer ? renderer.info.render.triangles : 0,
  drawCalls: renderer ? renderer.info.render.calls : 0,
  mode: state.topo ? 'topographic' : 'sculpt',
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
initPanelSplitter(() => { resizeMap(); resizeThree(); });
if (renderer) {
  renderer.domElement.addEventListener('pointerdown', () => renderer.domElement.focus());
  navigation = initNavigation(renderer.domElement, $('moveJoystick'), $('zoomJoystick'));
}
updateMapReferenceScale();
updateReadouts();
updateMapScaleText();
drawMap();

const timeParam = new URLSearchParams(location.search).get('t');
if (timeParam !== null) window.__seek(Number(timeParam));
