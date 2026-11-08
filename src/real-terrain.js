// "שטח אמיתי": a real place on the Topolab grid. Elevations come from the open Terrain Tiles
// (Mapzen / AWS Open Data, "Terrarium" PNGs: SRTM ~30 m in Israel), roads, trails, streams and
// land cover from OpenStreetMap (Overpass API). Everything is placed by ITM coordinates (itm.js)
// so the map's grid shows true Israeli grid references. See docs/REAL-TERRAIN.md.

import { itmToWgs84, wgs84ToItm } from './itm.js';

export const TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const OSM_API_URL = 'https://api.openstreetmap.org/api/0.6/map';
export const OVERPASS_URLS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const OVERPASS_WAIT = 25000; // ms per server: public servers sometimes queue a request for minutes
const OSM_API_WAIT = 25000;
export const ATTRIBUTION = 'גבהים: Terrain Tiles (Mapzen, AWS Open Data; SRTM) · דרכים ותכסית: © OpenStreetMap contributors (ODbL)';
const TILE = 256;
const MAX_ZOOM = 14; // the source is ~30 m: finer tiles only interpolate

// ——— Web Mercator tiles ———
export function lonLatToPixel(lon, lat, z) {
  const size = TILE * 2 ** z;
  const s = Math.sin(lat * Math.PI / 180);
  return {
    x: (lon + 180) / 360 * size,
    y: (.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size,
  };
}

// The coarsest zoom whose pixels are no larger than the grid spacing (metres).
export function zoomForSpacing(spacing, lat) {
  const ground = 156543.03392 * Math.cos(lat * Math.PI / 180); // metres per pixel at z0
  return Math.max(8, Math.min(MAX_ZOOM, Math.ceil(Math.log2(ground / Math.max(1, spacing)))));
}

// Corners of the map (ITM) in WGS84, for tiles and the Overpass bounding box.
export function mapCorners(origin, extent) {
  return [[0, 0], [1, 0], [0, 1], [1, 1]].map(([a, b]) => itmToWgs84(origin.e + a * extent, origin.n + b * extent));
}

export function tilesFor(origin, extent, z) {
  const px = mapCorners(origin, extent).map((p) => lonLatToPixel(p.lon, p.lat, z));
  const x0 = Math.floor((Math.min(...px.map((p) => p.x)) - 1) / TILE);
  const x1 = Math.floor((Math.max(...px.map((p) => p.x)) + 1) / TILE);
  const y0 = Math.floor((Math.min(...px.map((p) => p.y)) - 1) / TILE);
  const y1 = Math.floor((Math.max(...px.map((p) => p.y)) + 1) / TILE);
  const tiles = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) tiles.push({ z, x, y });
  return tiles;
}

export const tileUrl = ({ z, x, y }) => TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);

// Terrarium: height = R·256 + G + B/256 − 32768 (metres).
export function decodeTerrarium(rgba) {
  const out = new Float32Array(rgba.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4] * 256 + rgba[i * 4 + 1] + rgba[i * 4 + 2] / 256 - 32768;
  return out;
}

// Fill an N×N grid (row 0 = north edge, column 0 = west edge, as in Topolab) by bilinear
// sampling of decoded tiles: `tiles` maps "z/x/y" → Float32Array(256·256).
export function sampleGrid({ origin, extent, n, z, tiles }) {
  const heights = new Float32Array(n * n);
  const pixel = (gx, gy) => {
    const tx = Math.floor(gx / TILE);
    const ty = Math.floor(gy / TILE);
    const data = tiles.get(`${z}/${tx}/${ty}`);
    if (!data) return NaN;
    return data[(gy - ty * TILE) * TILE + (gx - tx * TILE)];
  };
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const e = origin.e + col / (n - 1) * extent;
      const north = origin.n + (1 - row / (n - 1)) * extent;
      const { lat, lon } = itmToWgs84(e, north);
      const p = lonLatToPixel(lon, lat, z);
      const fx = p.x - .5;
      const fy = p.y - .5;
      const x = Math.floor(fx);
      const y = Math.floor(fy);
      const ax = fx - x;
      const ay = fy - y;
      const h = (pixel(x, y) * (1 - ax) + pixel(x + 1, y) * ax) * (1 - ay) + (pixel(x, y + 1) * (1 - ax) + pixel(x + 1, y + 1) * ax) * ay;
      heights[row * n + col] = h;
    }
  }
  // Holes (missing tile, sea "no data" values) take their neighbours' height.
  for (let i = 0; i < heights.length; i++) if (!Number.isFinite(heights[i]) || heights[i] < -1000) heights[i] = NaN;
  fillHoles(heights, n);
  return heights;
}

function fillHoles(heights, n) {
  for (let pass = 0; pass < n; pass++) {
    let left = 0;
    for (let i = 0; i < heights.length; i++) {
      if (!Number.isNaN(heights[i])) continue;
      const x = i % n;
      const y = (i - x) / n;
      let sum = 0;
      let count = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
        const v = heights[yy * n + xx];
        if (!Number.isNaN(v)) { sum += v; count++; }
      }
      if (count) heights[i] = sum / count;
      else left++;
    }
    if (!left) return;
  }
  for (let i = 0; i < heights.length; i++) if (Number.isNaN(heights[i])) heights[i] = 0;
}

// A vertical datum for the map: a round hundred under its lowest point, so contour levels
// stay round numbers while Topolab keeps working on heights that start near zero.
export function chooseDatum(heights) {
  let min = Infinity;
  for (const h of heights) min = Math.min(min, h);
  return Number.isFinite(min) ? Math.floor(min / 100) * 100 : 0;
}

// ——— OpenStreetMap ———
// [west, south, east, north] in degrees.
export function bboxOf(origin, extent) {
  const c = mapCorners(origin, extent);
  return [
    Math.min(...c.map((p) => p.lon)).toFixed(6), Math.min(...c.map((p) => p.lat)).toFixed(6),
    Math.max(...c.map((p) => p.lon)).toFixed(6), Math.max(...c.map((p) => p.lat)).toFixed(6),
  ];
}

export function overpassQuery(origin, extent) {
  const [w, s, e, nn] = bboxOf(origin, extent);
  const bbox = `${s},${w},${nn},${e}`;
  return `[out:json][timeout:25];(
way[highway~"^(motorway|trunk|primary|secondary|tertiary|unclassified|service|track|path|footway|bridleway|steps|cycleway)(_link)?$"](${bbox});
way[waterway~"^(river|stream|wadi)$"](${bbox});
way[landuse~"^(forest|orchard|vineyard|farmland|meadow|residential|industrial|commercial|retail)$"](${bbox});
way[natural~"^(wood|scrub)$"](${bbox});
relation[type=multipolygon][landuse~"^(forest|orchard|vineyard|farmland|residential|industrial|commercial)$"](${bbox});
relation[type=multipolygon][natural=wood](${bbox});
relation[route=hiking](${bbox});
node[place~"^(city|town|village|hamlet|suburb|neighbourhood|isolated_dwelling|locality)$"][name](${bbox});
node[natural~"^(peak|hill|spring|cave_entrance)$"][name](${bbox});
);out geom qt;`;
}

// Village streets and driveways are left out: the built-up area stands for them, as on
// printed 1:50,000 maps, and hundreds of short roads would bury the contours.
const ROAD = /^(motorway|trunk|primary|secondary|tertiary|unclassified)(_link)?$/;
function lineType(tags) {
  const hw = tags.highway;
  if (hw) {
    if (ROAD.test(hw)) return 'road';
    if (hw === 'service') return tags.surface && !/asphalt|paved|concrete/.test(tags.surface) ? 'dirtRoad' : null;
    if (hw === 'track') return 'dirtRoad';
    if (/^(path|footway|bridleway|steps|cycleway)$/.test(hw)) return 'trail';
  }
  const ww = tags.waterway;
  if (ww) {
    if (tags.intermittent === 'yes' || tags.seasonal === 'yes' || ww === 'wadi') return 'intermittentStream';
    if (ww === 'river' || tags.intermittent === 'no') return 'perennialStream';
    return 'intermittentStream'; // most streams in Israel run only after rain
  }
  return null;
}

function areaType(tags) {
  const lu = tags.landuse;
  if (lu === 'forest') return 'plantedForest';
  if (lu === 'orchard') return 'orchard';
  if (lu === 'vineyard') return 'vineyard';
  if (lu === 'farmland' || lu === 'meadow') return 'field';
  if (/^(residential|industrial|commercial|retail)$/.test(lu || '')) return 'builtUp';
  if (tags.natural === 'wood' || tags.natural === 'scrub') return 'naturalForest';
  return null;
}

// Israeli trail marks are colours: red, blue, green and black (and a few others).
export function trailColor(tags) {
  const raw = (tags.colour || tags['osmc:symbol']?.split(':')[0] || '').toLowerCase();
  if (/red|אדום/.test(raw)) return 'red';
  if (/blue|כחול/.test(raw)) return 'blue';
  if (/green|ירוק/.test(raw)) return 'green';
  if (/black|שחור/.test(raw)) return 'black';
  if (/orange|purple|violet/.test(raw)) return 'red';
  return 'red';
}

// Clip a polyline to the unit square (Liang–Barsky per segment); may split it in pieces.
export function clipPolyline(points) {
  const pieces = [];
  let current = [];
  const flush = () => { if (current.length >= 2) pieces.push(current); current = []; };
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const seg = clipSegment(a, b);
    if (!seg) { flush(); continue; }
    const [p, q, enteredInside, leftInside] = seg;
    if (!enteredInside || !current.length) { flush(); current.push(p); }
    current.push(q);
    if (!leftInside) flush();
  }
  flush();
  return pieces;
}

function clipSegment(a, b) {
  let t0 = 0;
  let t1 = 1;
  const du = b.u - a.u;
  const dv = b.v - a.v;
  for (const [p, q] of [[-du, a.u], [du, 1 - a.u], [-dv, a.v], [dv, 1 - a.v]]) {
    if (p === 0) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [{ u: a.u + t0 * du, v: a.v + t0 * dv }, { u: a.u + t1 * du, v: a.v + t1 * dv }, t0 === 0, t1 === 1];
}

// Sutherland–Hodgman against the unit square.
export function clipPolygon(points) {
  let out = points;
  const edges = [
    [(p) => p.u >= 0, (a, b) => a.u / (a.u - b.u)],
    [(p) => p.u <= 1, (a, b) => (1 - a.u) / (b.u - a.u)],
    [(p) => p.v >= 0, (a, b) => a.v / (a.v - b.v)],
    [(p) => p.v <= 1, (a, b) => (1 - a.v) / (b.v - a.v)],
  ];
  for (const [inside, cut] of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      const at = (t) => ({ u: prev.u + (cur.u - prev.u) * t, v: prev.v + (cur.v - prev.v) * t });
      if (inside(cur)) {
        if (!inside(prev)) out.push(at(cut(prev, cur)));
        out.push(cur);
      } else if (inside(prev)) out.push(at(cut(prev, cur)));
    }
    if (!out.length) return [];
  }
  return out.map(({ u, v }) => ({ u: Math.min(1, Math.max(0, u)), v: Math.min(1, Math.max(0, v)) }));
}

// Douglas–Peucker in map units.
export function simplify(points, tolerance) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    const a = points[i];
    const b = points[j];
    const len = Math.hypot(b.u - a.u, b.v - a.v) || 1e-12;
    let worst = -1;
    let at = -1;
    for (let k = i + 1; k < j; k++) {
      const p = points[k];
      const d = Math.abs((b.u - a.u) * (a.v - p.v) - (a.u - p.u) * (b.v - a.v)) / len;
      if (d > worst) { worst = d; at = k; }
    }
    if (worst > tolerance) { keep[at] = 1; stack.push([i, at], [at, j]); }
  }
  return points.filter((_, i) => keep[i]);
}

// A closed ring (first point repeated at the end) simplified as two open halves.
export function simplifyRing(points, tolerance) {
  const ring = points.length > 1 && points[0].u === points.at(-1).u && points[0].v === points.at(-1).v ? points.slice(0, -1) : points;
  if (ring.length < 4) return ring;
  const mid = Math.floor(ring.length / 2);
  return [...simplify(ring.slice(0, mid + 1), tolerance).slice(0, -1), ...simplify([...ring.slice(mid), ring[0]], tolerance).slice(0, -1)];
}

// Join a multipolygon's outer member ways into closed rings by matching their ends.
export function joinRings(ways) {
  const pending = ways.filter((w) => w.length >= 2).map((w) => [...w]);
  const rings = [];
  const same = (a, b) => Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lon - b.lon) < 1e-9;
  while (pending.length) {
    let ring = pending.shift();
    let grew = true;
    while (!same(ring[0], ring[ring.length - 1]) && grew) {
      grew = false;
      for (let i = 0; i < pending.length; i++) {
        const w = pending[i];
        const end = ring[ring.length - 1];
        if (same(end, w[0])) ring = ring.concat(w.slice(1));
        else if (same(end, w[w.length - 1])) ring = ring.concat(w.slice(0, -1).reverse());
        else continue;
        pending.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}

// OSM XML (the main API's /map) → the same shape as Overpass `out geom` elements.
export function osmXmlToElements(xml) {
  const unescape = (t) => t.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const attr = (text, name) => { const m = text.match(new RegExp(`\\s${name}="([^"]*)"`)); return m ? unescape(m[1]) : null; };
  const tagsOf = (body) => {
    const tags = {};
    for (const m of body.matchAll(/<tag\s[^>]*>/g)) tags[attr(m[0], 'k')] = attr(m[0], 'v');
    return tags;
  };
  const nodes = new Map();
  const elements = [];
  for (const m of xml.matchAll(/<node\s([^>]*?)(?:\/>|>([\s\S]*?)<\/node>)/g)) {
    const head = ' ' + m[1];
    const node = { lat: Number(attr(head, 'lat')), lon: Number(attr(head, 'lon')) };
    nodes.set(attr(head, 'id'), node);
    // Named places and peaks become labels (osmToLabels); other tagged nodes are not needed.
    if (m[2] && /k="(place|natural)"/.test(m[2])) elements.push({ type: 'node', id: Number(attr(head, 'id')), ...node, tags: tagsOf(m[2]) });
  }
  const ways = new Map();
  for (const m of xml.matchAll(/<way\s([^>]*)>([\s\S]*?)<\/way>/g)) {
    const id = Number(attr(' ' + m[1], 'id'));
    const geometry = [...m[2].matchAll(/<nd\s[^>]*ref="(\d+)"/g)].map((r) => nodes.get(r[1])).filter(Boolean);
    ways.set(id, geometry);
    elements.push({ type: 'way', id, tags: tagsOf(m[2]), geometry });
  }
  for (const m of xml.matchAll(/<relation\s([^>]*)>([\s\S]*?)<\/relation>/g)) {
    const members = [...m[2].matchAll(/<member\s[^>]*>/g)].map((r) => {
      const type = attr(r[0], 'type');
      const ref = Number(attr(r[0], 'ref'));
      return { type, ref, role: attr(r[0], 'role') || '', geometry: type === 'way' ? ways.get(ref) : undefined };
    });
    elements.push({ type: 'relation', id: Number(attr(' ' + m[1], 'id')), tags: tagsOf(m[2]), members });
  }
  return elements;
}

// Names on the map: settlements, quarters, named spots, peaks and springs. Hebrew name when
// there is one. `rank` orders them (bigger places first) when labels would collide.
const LABEL_KINDS = {
  city: { kind: 'city', rank: 0 }, town: { kind: 'town', rank: 1 }, village: { kind: 'village', rank: 2 },
  suburb: { kind: 'quarter', rank: 3 }, hamlet: { kind: 'hamlet', rank: 4 }, neighbourhood: { kind: 'quarter', rank: 5 },
  isolated_dwelling: { kind: 'hamlet', rank: 6 }, locality: { kind: 'locality', rank: 7 },
  peak: { kind: 'peak', rank: 4 }, hill: { kind: 'peak', rank: 6 }, spring: { kind: 'spring', rank: 6 }, cave_entrance: { kind: 'cave', rank: 7 },
};

export function osmToLabels(elements, { origin, extent }) {
  const labels = [];
  const seen = new Set();
  for (const el of elements) {
    if (el.type !== 'node' || !el.tags) continue;
    const spec = LABEL_KINDS[el.tags.place] || LABEL_KINDS[el.tags.natural];
    const name = (el.tags['name:he'] || el.tags.name || '').trim();
    if (!spec || !name) continue;
    const p = wgs84ToItm(el.lat, el.lon);
    const u = (p.e - origin.e) / extent;
    const v = 1 - (p.n - origin.n) / extent;
    if (u < 0 || u > 1 || v < 0 || v > 1) continue;
    const key = `${name}|${spec.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ele = spec.kind === 'peak' && Number.isFinite(Number(el.tags.ele)) ? Math.round(Number(el.tags.ele)) : null;
    labels.push({ u, v, name, kind: spec.kind, rank: spec.rank, ...(ele !== null ? { ele } : {}) });
  }
  return labels.sort((a, b) => a.rank - b.rank).slice(0, 80);
}

// Overpass elements (`out geom`) → Topolab map features clipped to the map. `cell` is the
// grid spacing in map units: lines are simplified to about half of it.
export function osmToFeatures(elements, { origin, extent, cell = 1 / 200 }) {
  const toUV = ({ lat, lon }) => {
    const p = wgs84ToItm(lat, lon);
    return { u: (p.e - origin.e) / extent, v: 1 - (p.n - origin.n) / extent };
  };
  const tolerance = cell * .5;
  const lines = [];
  const areas = [];
  const marked = new Map(); // way id → trail colour from hiking route relations
  for (const el of elements) {
    if (el.type !== 'relation' || el.tags?.route !== 'hiking') continue;
    const color = trailColor(el.tags);
    for (const m of el.members || []) if (m.type === 'way') marked.set(m.ref, color);
  }
  const addArea = (type, ring) => {
    const pts = clipPolygon(simplifyRing(ring.map(toUV), tolerance));
    if (pts.length >= 3 && polygonArea(pts) > cell * cell * 2) areas.push({ type, color: 'red', imported: true, points: pts });
  };
  for (const el of elements) {
    const tags = el.tags || {};
    if (el.type === 'way' && el.geometry) {
      const line = lineType(tags);
      if (line) {
        const isMarked = line === 'trail' || line === 'dirtRoad' ? marked.get(el.id) : null;
        const type = isMarked && line === 'trail' ? 'markedTrail' : line;
        for (const piece of clipPolyline(el.geometry.map(toUV))) {
          const pts = simplify(piece, tolerance);
          if (pts.length >= 2) lines.push({ type, color: isMarked || 'red', imported: true, points: pts });
        }
        continue;
      }
      const area = areaType(tags);
      if (area && el.geometry.length >= 4) addArea(area, el.geometry);
    } else if (el.type === 'relation' && tags.type === 'multipolygon') {
      const area = areaType(tags);
      if (!area) continue;
      const outers = (el.members || []).filter((m) => m.type === 'way' && m.role !== 'inner' && m.geometry).map((m) => m.geometry);
      for (const ring of joinRings(outers)) addArea(area, ring);
    }
  }
  // Big areas first so small ones (a village in a forest) are drawn and counted on top.
  areas.sort((a, b) => polygonArea(b.points) - polygonArea(a.points));
  return [...areas, ...lines];
}

function polygonArea(points) {
  let s = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) s += (points[j].u + points[i].u) * (points[j].v - points[i].v);
  return Math.abs(s) / 2;
}

// ——— Network (browser) ———
async function loadTile(tile, signal) {
  const response = await fetch(tileUrl(tile), { signal, mode: 'cors' });
  if (!response.ok) throw new Error(`tile ${tile.z}/${tile.x}/${tile.y}: ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = new OffscreenCanvas(TILE, TILE);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  return decodeTerrarium(ctx.getImageData(0, 0, TILE, TILE).data);
}

// Elevations for an N×N grid whose south-west corner is `origin` (ITM metres).
export async function fetchHeights({ origin, extent, n, signal, onProgress = () => {} }) {
  const centre = itmToWgs84(origin.e + extent / 2, origin.n + extent / 2);
  const z = zoomForSpacing(extent / (n - 1), centre.lat);
  const list = tilesFor(origin, extent, z);
  const tiles = new Map();
  let done = 0;
  await Promise.all(list.map(async (tile) => {
    tiles.set(`${tile.z}/${tile.x}/${tile.y}`, await loadTile(tile, signal));
    onProgress(++done, list.length);
  }));
  return sampleGrid({ origin, extent, n, z, tiles });
}

// fetch() with a deadline that also follows the caller's abort signal.
async function fetchWithin(url, options, ms, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${ms} ms`)), ms);
  const follow = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', follow, { once: true });
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`${new URL(url).host} ${response.status}`);
    return options.method === 'POST' ? await response.json() : await response.text();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', follow);
  }
}

// Start several sources one after another and keep the first that answers; the rest are
// cancelled. A source that fails starts the next one at once. `tasks` take an abort signal.
export function raceStaggered(tasks, { stagger = [], signal } = {}) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let next = 0;
    let running = 0;
    let settled = false;
    let lastError = null;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      controller.abort();
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, signal.reason ?? new Error('aborted'));
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    const launch = () => {
      clearTimeout(timer);
      if (settled || next >= tasks.length) return;
      const index = next++;
      running++;
      Promise.resolve().then(() => tasks[index](controller.signal)).then((value) => finish(resolve, value), (error) => {
        running--;
        lastError = error;
        if (settled) return;
        if (next < tasks.length) launch();
        else if (!running) finish(reject, lastError);
      });
      if (next < tasks.length) timer = setTimeout(launch, stagger[index] ?? 4000);
    };
    launch();
  });
}

const CACHE_NAME = 'topolab-osm-v2'; // v2: with place and peak names
const CACHE_DAYS = 30;
const cacheKey = (origin, extent) => `https://topolab.local/osm?bbox=${bboxOf(origin, extent).join(',')}`;

async function cachedOsm(origin, extent) {
  try {
    if (typeof caches === 'undefined') return null;
    const response = await (await caches.open(CACHE_NAME)).match(cacheKey(origin, extent));
    if (!response) return null;
    const age = Date.now() - Number(response.headers.get('x-saved') || 0);
    if (age > CACHE_DAYS * 864e5) return null;
    return await response.json();
  } catch { return null; }
}

async function storeOsm(origin, extent, elements) {
  try {
    if (typeof caches === 'undefined') return;
    const response = new Response(JSON.stringify(elements), { headers: { 'content-type': 'application/json', 'x-saved': String(Date.now()) } });
    await (await caches.open(CACHE_NAME)).put(cacheKey(origin, extent), response);
  } catch { /* storage full or unavailable: just no cache */ }
}

// Roads, trails, streams and land cover for the map. A place loaded before comes from the
// browser's cache. Otherwise Overpass first; if it has not answered within 3 s the main OSM
// API (fast for country boxes, refuses dense cities) joins, then the other Overpass servers.
export async function fetchOsm({ origin, extent, signal }) {
  const cached = await cachedOsm(origin, extent);
  if (cached) return cached;
  const body = 'data=' + encodeURIComponent(overpassQuery(origin, extent));
  const overpass = (url) => async (s) => {
    const data = await fetchWithin(url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, OVERPASS_WAIT, s);
    if (!Array.isArray(data?.elements)) throw new Error(`${url}: no elements`);
    return data.elements;
  };
  const osmApi = async (s) => osmXmlToElements(await fetchWithin(`${OSM_API_URL}?bbox=${bboxOf(origin, extent).join(',')}`, {}, OSM_API_WAIT, s));
  const elements = await raceStaggered([overpass(OVERPASS_URLS[0]), osmApi, overpass(OVERPASS_URLS[1]), overpass(OVERPASS_URLS[2])], { stagger: [3000, 4000, 5000], signal });
  storeOsm(origin, extent, elements);
  return elements;
}

// ——— Place search (Nominatim, OpenStreetMap's geocoder) ———
// Called only when the user submits a search (Nominatim's usage policy: no search-as-you-type).
export const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

// A map size that fits a result's bounding box [south, north, west, east] (degrees).
export function suggestSize(box) {
  if (!Array.isArray(box) || box.length !== 4) return 4;
  const [s, n, w, e] = box.map(Number);
  const lat = (s + n) / 2;
  const km = Math.max((n - s) * 111.2, (e - w) * 111.2 * Math.cos(lat * Math.PI / 180));
  if (!Number.isFinite(km) || km <= 3) return 4;
  return km <= 5 ? 6 : 8;
}

export function parsePlaces(list) {
  return (Array.isArray(list) ? list : []).map((r) => {
    const { e, n } = wgs84ToItm(Number(r.lat), Number(r.lon));
    const parts = String(r.display_name || '').split(',').map((x) => x.trim()).filter(Boolean);
    return {
      name: r.name || parts[0] || '',
      detail: parts.slice(1, 3).join(', '),
      e: Math.round(e / 100) * 100,
      n: Math.round(n / 100) * 100,
      sizeKm: suggestSize(r.boundingbox),
    };
  }).filter((p) => p.name && isItmPoint(p.e, p.n));
}

const isItmPoint = (e, n) => e >= 100000 && e <= 300000 && n >= 350000 && n <= 820000;

export async function searchPlaces(query, { signal } = {}) {
  const url = `${NOMINATIM_URL}?format=jsonv2&limit=8&countrycodes=il,ps&accept-language=he&q=${encodeURIComponent(query)}`;
  return parsePlaces(JSON.parse(await fetchWithin(url, {}, 12000, signal)));
}
