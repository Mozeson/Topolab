import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { AREA_TYPES, AREA_ORDER, isArea, rasterizeAreas, buildSpeedGrid, polygonArea, pointInPolygon } from './areas.js';

export const MAP_FEATURE_TYPES = {
  trail: { label: 'שביל', family: 'land' },
  markedTrail: { label: 'שביל מסומן', family: 'land' },
  dirtRoad: { label: 'דרך עפר', family: 'land' },
  road: { label: 'כביש', family: 'land' },
  perennialStream: { label: 'נחל איתן', family: 'water' },
  intermittentStream: { label: 'נחל אכזב', family: 'water' },
  ...Object.fromEntries(Object.entries(AREA_TYPES).map(([type, area]) => [type, { label: area.label, family: 'area' }])),
};
const minPoints = (type) => (isArea(type) ? 3 : 2);

const TRAIL_COLORS = {
  red: '#c9563f',
  green: '#3f8456',
  blue: '#3479a9',
  black: '#343b38',
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const distance = (a, b) => Math.hypot(a.u - b.u, a.v - b.v);
const isWater = (type) => MAP_FEATURE_TYPES[type]?.family === 'water';

function strokePolyline(ctx, points, width, color, dash = []) {
  if (points.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.setLineDash(dash);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.setLineDash([]);
}

function strokeParallelSegments(ctx, points, offset, width, color, dash = []) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.setLineDash(dash);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = -(b.y - a.y) / length * offset;
    const ny = (b.x - a.x) / length * offset;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(a.x + nx * side, a.y + ny * side);
      ctx.lineTo(b.x + nx * side, b.y + ny * side);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawFlowArrow(ctx, points, color, dpr) {
  if (points.length < 2) return;
  const end = points[points.length - 1];
  const before = points[points.length - 2];
  const angle = Math.atan2(end.y - before.y, end.x - before.x);
  const size = 7 * dpr;
  ctx.save();
  ctx.translate(end.x, end.y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-size, size * .55);
  ctx.lineTo(-size, -size * .55);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

// Small repeating tiles in the style of a printed topographic map.
const patternCache = new Map();
function areaPattern(ctx, type, dpr) {
  const key = `${type}:${dpr}`;
  if (patternCache.has(key)) return patternCache.get(key);
  const area = AREA_TYPES[type];
  const size = Math.round(14 * dpr);
  const tile = document.createElement('canvas');
  tile.width = size;
  tile.height = size;
  const t = tile.getContext('2d');
  t.fillStyle = area.fill;
  t.fillRect(0, 0, size, size);
  t.strokeStyle = area.ink;
  t.fillStyle = area.ink;
  t.lineWidth = Math.max(1, .9 * dpr);
  const circle = (x, y, r, fill = false) => { t.beginPath(); t.arc(x * size, y * size, r * dpr, 0, Math.PI * 2); fill ? t.fill() : t.stroke(); };
  if (type === 'naturalForest') { circle(.28, .3, 2.6); circle(.75, .72, 2.2); circle(.8, .22, 1.4); }
  else if (type === 'plantedForest') { circle(.5, .5, 2.6); circle(0, 0, 2.6); circle(1, 0, 2.6); circle(0, 1, 2.6); circle(1, 1, 2.6); }
  else if (type === 'orchard') { circle(.25, .25, 1.4, true); circle(.75, .75, 1.4, true); }
  else if (type === 'vineyard') {
    for (const x of [.25, .75]) { t.beginPath(); t.moveTo(x * size, .15 * size); t.lineTo(x * size, .85 * size); t.stroke(); }
  } else if (type === 'field') {
    t.globalAlpha = .5;
    t.beginPath(); t.moveTo(0, .5 * size); t.lineTo(size, .5 * size); t.stroke();
  } else if (type === 'builtUp') {
    t.beginPath(); t.moveTo(0, size); t.lineTo(size, 0); t.moveTo(-size / 2, size / 2); t.lineTo(size / 2, -size / 2); t.moveTo(size / 2, size * 1.5); t.lineTo(size * 1.5, size / 2); t.stroke();
  }
  const pattern = ctx.createPattern(tile, 'repeat');
  patternCache.set(key, pattern);
  return pattern;
}

function drawArea2D(ctx, canvas, dpr, feature, previewPoint) {
  const source = previewPoint ? [...feature.points, previewPoint] : feature.points;
  if (source.length < 2) return;
  const area = AREA_TYPES[feature.type];
  ctx.save();
  ctx.beginPath();
  source.forEach((p, i) => (i ? ctx.lineTo(p.u * canvas.width, p.v * canvas.height) : ctx.moveTo(p.u * canvas.width, p.v * canvas.height)));
  ctx.closePath();
  // Translucent so the contour lines underneath stay readable, as on a printed map.
  ctx.globalAlpha = previewPoint ? .45 : .42;
  ctx.fillStyle = areaPattern(ctx, feature.type, dpr);
  ctx.fill('evenodd');
  ctx.globalAlpha = previewPoint ? 1 : .6;
  ctx.lineWidth = .8 * dpr;
  ctx.strokeStyle = area.ink;
  if (previewPoint) ctx.setLineDash([5 * dpr, 4 * dpr]);
  ctx.stroke();
  ctx.restore();
}

function drawFeature2D(ctx, canvas, dpr, feature, previewPoint = null) {
  if (isArea(feature.type)) { drawArea2D(ctx, canvas, dpr, feature, previewPoint); return; }
  const source = previewPoint ? [...feature.points, previewPoint] : feature.points;
  const points = source.map((point) => ({ x: point.u * canvas.width, y: point.v * canvas.height }));
  if (points.length < 2) return;
  ctx.save();
  // Thin and a little transparent so the contour lines keep the lead, as on a printed map.
  // Imported streams (real-terrain.js) come in many short pieces: no arrow on each one.
  ctx.globalAlpha = previewPoint ? 1 : .88;
  const arrows = !feature.imported;
  if (feature.type === 'trail') {
    strokePolyline(ctx, points, 1.15 * dpr, '#343b38', [5 * dpr, 4 * dpr]);
  } else if (feature.type === 'markedTrail') {
    strokePolyline(ctx, points, 2.7 * dpr, 'rgba(255,255,247,.7)');
    strokePolyline(ctx, points, 1.5 * dpr, TRAIL_COLORS[feature.color] || TRAIL_COLORS.red);
  } else if (feature.type === 'dirtRoad') {
    strokeParallelSegments(ctx, points, 1.6 * dpr, .85 * dpr, '#4f4a3e', [6 * dpr, 4 * dpr]);
  } else if (feature.type === 'road') {
    strokePolyline(ctx, points, 4.6 * dpr, '#5a5f5c');
    strokePolyline(ctx, points, 3 * dpr, '#ecd08f');
  } else if (feature.type === 'perennialStream') {
    strokePolyline(ctx, points, 2 * dpr, '#237eb1');
    if (arrows) drawFlowArrow(ctx, points, '#237eb1', dpr);
  } else if (feature.type === 'intermittentStream') {
    strokePolyline(ctx, points, 1.6 * dpr, '#368bb7', [7 * dpr, 5 * dpr]);
    if (arrows) drawFlowArrow(ctx, points, '#368bb7', dpr);
  }
  if (feature.validation?.invalidSegments?.length) {
    for (const [a, b] of feature.validation.invalidSegments) {
      strokePolyline(ctx, [
        { x: a.u * canvas.width, y: a.v * canvas.height },
        { x: b.u * canvas.width, y: b.v * canvas.height },
      ], 5 * dpr, 'rgba(205,66,49,.88)', [4 * dpr, 3 * dpr]);
    }
  }
  ctx.restore();
}

function samplePolyline(points, step = .008) {
  const sampled = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const steps = Math.max(1, Math.ceil(distance(a, b) / step));
    for (let n = i === 1 ? 0 : 1; n <= steps; n++) {
      const t = n / steps;
      sampled.push({ u: a.u + (b.u - a.u) * t, v: a.v + (b.v - a.v) * t });
    }
  }
  return sampled;
}

function disposeObject(object) {
  object.traverse((child) => {
    if (!child.isInstancedMesh) child.geometry?.dispose?.(); // instanced area geometries are shared
    if (Array.isArray(child.material)) child.material.forEach((material) => material.dispose());
    else child.material?.dispose?.();
  });
}

// Ribbons are built in one of two scales:
// - overview (default): widths/lift in world units, exaggerated so lines read on the
//   whole-map 3D model;
// - ground (api.groundMode(), the navigation game): real sizes in metres, sitting just
//   above the terrain and sampled every few metres so they follow it.
function makeRibbon(api, points, width, color, options = {}) {
  const sampled = samplePolyline(points, options.step);
  if (sampled.length < 2) return null;
  const vertices = [];
  const indices = [];
  let vertexIndex = 0;
  let accumulated = 0;
  for (let i = 1; i < sampled.length; i++) {
    const a = sampled[i - 1];
    const b = sampled[i];
    const ax = (a.u - .5) * api.worldSize();
    const az = (a.v - .5) * api.worldSize();
    const bx = (b.u - .5) * api.worldSize();
    const bz = (b.v - .5) * api.worldSize();
    const length = Math.hypot(bx - ax, bz - az);
    const drawSegment = !options.dashed || Math.floor(accumulated / options.dashLength) % 2 === 0;
    accumulated += length;
    if (!drawSegment || !length) continue;
    const nx = -(bz - az) / length;
    const nz = (bx - ax) / length;
    const lateral = options.lateral || 0;
    const half = width / 2;
    const ground = options.surface || api.height;
    const ay = ground(a.u, a.v) * api.verticalScale() + (options.lift || .016);
    const by = ground(b.u, b.v) * api.verticalScale() + (options.lift || .016);
    vertices.push(
      ax + nx * (lateral - half), ay, az + nz * (lateral - half),
      ax + nx * (lateral + half), ay, az + nz * (lateral + half),
      bx + nx * (lateral - half), by, bz + nz * (lateral - half),
      bx + nx * (lateral + half), by, bz + nz * (lateral + half),
    );
    indices.push(vertexIndex, vertexIndex + 2, vertexIndex + 1, vertexIndex + 1, vertexIndex + 2, vertexIndex + 3);
    vertexIndex += 4;
  }
  if (!vertices.length) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: options.water ? .32 : .88,
    metalness: 0,
    transparent: Boolean(options.opacity && options.opacity < 1),
    opacity: options.opacity ?? 1,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  return new THREE.Mesh(geometry, material);
}

// Real-world look for the first-person view. Sizes in metres.
const GROUND_STYLES = {
  trail: [{ width: 1.2, color: 0x7d6a4c }],
  markedTrail: [{ width: 1.3, color: 0x7d6a4c }, { width: .3, colorFrom: 'trail', dashed: true, dash: 4, lift: .18 }],
  dirtRoad: [{ width: 3.6, color: 0x9a7d55 }, { width: .5, color: 0x5f4b31, lateral: -.95, lift: .16 }, { width: .5, color: 0x5f4b31, lateral: .95, lift: .16 }],
  road: [{ width: 6.5, color: 0x4c514e }, { width: .18, color: 0xf1e7c4, dashed: true, dash: 4, lift: .17 }],
  perennialStream: [{ width: 3.2, color: 0x2f86ba, water: true }],
  intermittentStream: [{ width: 2.6, color: 0xc4b89c }],
};

function addGroundFeature3D(api, group, feature) {
  const mtw = api.metersToWorld();
  const extent = api.worldSize() / mtw;
  // A vertex every ~4 m (and at least three per grid cell) keeps the ribbon on the ground.
  const cell = extent / Math.max(1, api.gridSize() - 1);
  const step = Math.min(4, cell / 3) / extent;
  for (const layer of GROUND_STYLES[feature.type] || []) {
    const color = layer.colorFrom === 'trail' ? new THREE.Color(TRAIL_COLORS[feature.color] || TRAIL_COLORS.red) : layer.color;
    const mesh = makeRibbon(api, feature.points, layer.width * mtw, color, {
      step,
      lateral: (layer.lateral || 0) * mtw,
      lift: (layer.lift ?? .12) * mtw,
      dashed: layer.dashed,
      dashLength: (layer.dash || 1) * mtw,
      water: layer.water,
      surface: api.surfaceHeight,
    });
    if (mesh) group.add(mesh);
  }
}

function hash01(value) {
  let x = value >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

// What each area grows: shape, size (metres in the navigation game; exaggerated in the
// overview so it reads on a whole-map model), colour and spacing.
const AREA_OBJECTS = {
  naturalForest: { shape: 'tree', ground: [5, 8], overview: .09, color: [.28, .42, .2], density: 3200, groundSpacing: 9, jitter: 1 },
  plantedForest: { shape: 'cone', ground: [8, 12], overview: .12, color: [.2, .36, .19], density: 2600, groundSpacing: 7, jitter: .15 },
  orchard: { shape: 'tree', ground: [3, 4], overview: .07, color: [.36, .52, .24], density: 2400, groundSpacing: 6, jitter: .05 },
  vineyard: { shape: 'box', ground: [1.2, 1.6], overview: .04, color: [.42, .5, .23], density: 2600, groundSpacing: 3, jitter: .05 },
  builtUp: { shape: 'house', ground: [4, 9], overview: .07, color: [.86, .8, .7], density: 700, groundSpacing: 22, jitter: .3 },
};
const geometryCache = {};
function areaGeometry(shape) {
  if (geometryCache[shape]) return geometryCache[shape];
  let geometry;
  // Vertex colours: the trunk stays brown, the instance colour tints the crown.
  const painted = (geo, rgb) => {
    const colors = new Float32Array(geo.attributes.position.count * 3);
    for (let i = 0; i < colors.length; i += 3) colors.set(rgb, i);
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geo.index ? geo.toNonIndexed() : geo;
  };
  const trunk = (height) => painted(new THREE.CylinderGeometry(.05, .07, height, 6).translate(0, height / 2, 0), [1.6, 1.1, .75]);
  if (shape === 'tree') geometry = mergeGeometries([trunk(.4), painted(new THREE.IcosahedronGeometry(.5, 0).scale(1, .85, 1).translate(0, .72, 0), [1, 1, 1])]);
  else if (shape === 'cone') geometry = mergeGeometries([trunk(.2), painted(new THREE.ConeGeometry(.32, .85, 7).translate(0, .6, 0), [1, 1, 1])]);
  else if (shape === 'cone-plain') geometry = new THREE.ConeGeometry(.32, 1, 7).translate(0, .5, 0);
  else if (shape === 'blob') geometry = new THREE.IcosahedronGeometry(.5, 0).scale(1, .9, 1).translate(0, .45, 0);
  else if (shape === 'box') geometry = painted(new THREE.BoxGeometry(.5, 1, .5).translate(0, .5, 0), [1, 1, 1]);
  else geometry = painted(new THREE.BoxGeometry(1, 1, 1.3).translate(0, .5, 0), [1, 1, 1]);
  geometryCache[shape] = geometry;
  return geometry;
}

function addArea3D(api, group, feature) {
  const spec = AREA_OBJECTS[feature.type];
  if (!spec) return; // fields: colour only
  const W = api.worldSize();
  const ground = api.groundMode?.();
  const mtw = api.metersToWorld?.() || W / 4000;
  const extent = W / mtw;
  const share = polygonArea(feature.points);
  // Spacing: real metres in the game, a fixed density in the overview; capped either way.
  const spacingUV = ground ? spec.groundSpacing / extent : 1 / Math.sqrt(spec.density);
  const target = Math.min(4000, Math.round(share / (spacingUV * spacingUV)));
  if (target < 1) return;
  const step = Math.sqrt(share / target);
  let minU = 1; let maxU = 0; let minV = 1; let maxV = 0;
  for (const p of feature.points) { minU = Math.min(minU, p.u); maxU = Math.max(maxU, p.u); minV = Math.min(minV, p.v); maxV = Math.max(maxV, p.v); }
  const mesh = new THREE.InstancedMesh(areaGeometry(spec.shape), new THREE.MeshStandardMaterial({ flatShading: true, roughness: .9, vertexColors: true }), target);
  const matrix = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const color = new THREE.Color();
  const surface = api.surfaceHeight || api.height;
  const vs = api.verticalScale();
  let count = 0;
  let k = 0;
  // A jittered lattice: planted forests and orchards stay in rows, natural forest is irregular.
  for (let v = minV + step / 2; v < maxV && count < target; v += step) {
    for (let u = minU + step / 2; u < maxU && count < target; u += step, k++) {
      const pu = u + (hash01(feature.id * 7919 + k * 3) - .5) * step * spec.jitter;
      const pv = v + (hash01(feature.id * 104729 + k * 5) - .5) * step * spec.jitter;
      if (!pointInPolygon(pu, pv, feature.points)) continue;
      const r = hash01(k * 13 + feature.id);
      const size = ground ? (spec.ground[0] + (spec.ground[1] - spec.ground[0]) * r) * mtw : spec.overview * (W / 10) * (.75 + r * .5);
      const width = spec.shape === 'house' ? size * (.9 + hash01(k * 17) * .6) : size * (spec.shape === 'box' ? 1.4 : spec.shape === 'tree' ? 1 : .9);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), spec.jitter > .5 ? r * Math.PI * 2 : 0);
      matrix.compose(new THREE.Vector3((pu - .5) * W, surface(pu, pv) * vs, (pv - .5) * W), q, new THREE.Vector3(width, size, width));
      mesh.setMatrixAt(count, matrix);
      const shade = .85 + hash01(k * 29) * .3;
      color.setRGB(spec.color[0] * shade, spec.color[1] * shade, spec.color[2] * shade);
      if (spec.shape === 'house' && hash01(k * 31) > .6) color.setRGB(.78, .5, .42); // some red roofs
      mesh.setColorAt(count, color);
      count++;
    }
  }
  mesh.count = count;
  mesh.castShadow = !ground;
  mesh.frustumCulled = false;
  group.add(mesh);
}

function addFeature3D(api, group, feature) {
  const add = (mesh) => { if (mesh) group.add(mesh); };
  if (isArea(feature.type)) { addArea3D(api, group, feature); return; }
  if (api.groundMode?.()) { addGroundFeature3D(api, group, feature); return; }
  if (feature.type === 'trail') {
    add(makeRibbon(api, feature.points, .035, 0x3c3c34, { dashed: true, dashLength: .12 }));
  } else if (feature.type === 'markedTrail') {
    add(makeRibbon(api, feature.points, .06, 0xf7f2df));
    add(makeRibbon(api, feature.points, .032, new THREE.Color(TRAIL_COLORS[feature.color] || TRAIL_COLORS.red), { lift: .022 }));
  } else if (feature.type === 'dirtRoad') {
    add(makeRibbon(api, feature.points, .028, 0x665b43, { lateral: -.045, dashed: true, dashLength: .14 }));
    add(makeRibbon(api, feature.points, .028, 0x665b43, { lateral: .045, dashed: true, dashLength: .14 }));
  } else if (feature.type === 'road') {
    add(makeRibbon(api, feature.points, .16, 0x4f5551));
    add(makeRibbon(api, feature.points, .11, 0xd6b56d, { lift: .023 }));
  } else if (feature.type === 'perennialStream') {
    add(makeRibbon(api, feature.points, .075, 0x258dc3, { water: true, lift: .025 }));
  } else if (feature.type === 'intermittentStream') {
    add(makeRibbon(api, feature.points, .065, 0x3a91b9, { water: true, dashed: true, dashLength: .14, lift: .025 }));
  }
}

export function createMapFeatures(api) {
  const features = [];
  let activeType = null;
  let draft = null;
  let hoverPoint = null;
  let nextId = 1;
  const group = new THREE.Group();
  group.name = 'map-features';
  api.scene()?.add(group);

  function validateFeature(feature) {
    // Imported real streams (real-terrain.js) are not graded: they disagree with the ~30 m
    // elevation data by a cell or two, which would flag every wadi.
    if (!isWater(feature.type) || feature.points.length < 2 || feature.imported) return null;
    const samples = samplePolyline(feature.points, 1 / Math.max(80, api.gridSize() * 1.5));
    const invalidSegments = [];
    let totalRise = 0;
    let maxRise = 0;
    for (let i = 1; i < samples.length; i++) {
      const previousHeight = api.height(samples[i - 1].u, samples[i - 1].v);
      const height = api.height(samples[i].u, samples[i].v);
      const rise = height - previousHeight;
      if (rise > .6) {
        invalidSegments.push([samples[i - 1], samples[i]]);
        totalRise += rise;
        maxRise = Math.max(maxRise, rise);
      }
    }
    return {
      valid: invalidSegments.length === 0,
      invalidSegments,
      totalRise,
      maxRise,
      startHeight: api.height(feature.points[0].u, feature.points[0].v),
      endHeight: api.height(feature.points.at(-1).u, feature.points.at(-1).v),
    };
  }

  function refreshValidation() {
    for (const feature of features) feature.validation = validateFeature(feature);
    updateLegend();
    updateStatus();
  }

  function rebuild3D() {
    while (group.children.length) {
      const child = group.children[0];
      group.remove(child);
      disposeObject(child);
    }
    for (const feature of features) addFeature3D(api, group, feature);
    api.invalidate();
  }

  let speedGrid = null;
  let areaGrid = null;
  // Colours the 3D terrain under the areas and rebuilds the walking-speed grid.
  function refreshAreas() {
    const n = api.gridSize();
    areaGrid = rasterizeAreas(n, features);
    speedGrid = null;
    let any = false;
    const tint = new Float32Array(n * n * 4);
    for (let i = 0; i < n * n; i++) {
      const index = areaGrid[i];
      if (index < 0) continue;
      any = true;
      tint.set([...AREA_TYPES[AREA_ORDER[index]].tint, .55], i * 4);
    }
    api.setAreaTint?.(any ? tint : null);
  }

  // Walking speed and land cover at a map point (navigation game).
  function groundInfo(u, v) {
    const n = api.gridSize();
    if (!areaGrid || areaGrid.length !== n * n) refreshAreas();
    if (!speedGrid) speedGrid = buildSpeedGrid(n, features, api.worldSize() / (api.metersToWorld?.() || api.worldSize() / 4000), areaGrid);
    const i = Math.round(Math.min(1, Math.max(0, v)) * (n - 1)) * n + Math.round(Math.min(1, Math.max(0, u)) * (n - 1));
    const index = areaGrid[i];
    return { speed: speedGrid[i], area: index >= 0 ? AREA_TYPES[AREA_ORDER[index]].label : null, onPath: speedGrid[i] > 1 };
  }

  function redrawAll() {
    refreshAreas();
    api.redraw();
    rebuild3D();
  }

  function updateLegend() {
    const legend = document.getElementById('featureLegend');
    const used = [...new Set(features.map((feature) => feature.type))];
    legend.hidden = used.length === 0;
    const warning = features.some((feature) => isWater(feature.type) && feature.validation?.valid === false)
      ? '<span class="feature-validation-warning">⚠ נחל עולה בשטח</span>'
      : '';
    legend.innerHTML = used.map((type) => `<span class="feature-legend-item feature-${type}"><i></i>${MAP_FEATURE_TYPES[type].label}</span>`).join('') + warning;
  }

  function updateStatus(message = '') {
    const status = document.getElementById('featureStatus');
    const activeLabel = activeType ? MAP_FEATURE_TYPES[activeType].label : null;
    document.getElementById('finishFeatureBtn').disabled = !draft || draft.points.length < minPoints(draft.type);
    document.getElementById('cancelFeatureBtn').disabled = !draft;
    document.getElementById('removeLastFeatureBtn').disabled = features.length === 0;
    document.getElementById('mapCanvas').classList.toggle('drawing-feature', Boolean(activeType));
    for (const button of document.querySelectorAll('[data-feature-type]')) {
      const selected = button.dataset.featureType === activeType;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
    if (message) status.textContent = message;
    else if (draft && isArea(draft.type)) status.textContent = `${activeLabel}: ${draft.points.length} פינות. לחיצה כפולה או Enter סוגרים את השטח.`;
    else if (draft) status.textContent = `${activeLabel}: ${draft.points.length} נקודות. לחיצה כפולה או Enter לסיום.`;
    else if (activeType && isArea(activeType)) status.textContent = `${activeLabel}: לחצו על המפה פינה אחר פינה סביב השטח. שטח שמצויר בתוך שטח אחר "חותך" אותו (קרחת יער).`;
    else if (activeType) status.textContent = `${activeLabel}: לחצו על המפה ממקום למקום. בנחל—ציירו מהמעלה למורד.`;
    else if (features.length) status.textContent = `נוספו ${features.length} פריטי תכסית למפה.`;
    else status.textContent = 'בחרו סוג קו ואז לחצו לאורך המסלול במפה.';
  }

  function activate(type) {
    if (!MAP_FEATURE_TYPES[type]) return;
    api.prepareDrawing(type);
    if (activeType === type) return;
    activeType = type;
    draft = null;
    hoverPoint = null;
    updateStatus();
    api.redraw();
  }

  function pointFromGrid(gx, gy) {
    const denominator = Math.max(1, api.gridSize() - 1);
    return { u: clamp(gx / denominator, 0, 1), v: clamp(gy / denominator, 0, 1) };
  }

  function handlePointerDown(gx, gy) {
    if (!activeType) return false;
    const point = pointFromGrid(gx, gy);
    if (!draft) {
      draft = {
        type: activeType,
        color: document.getElementById('trailColorSelect').value,
        points: [],
      };
    }
    const previous = draft.points.at(-1);
    if (!previous || distance(previous, point) > .004) draft.points.push(point);
    hoverPoint = point;
    updateStatus();
    api.redraw();
    return true;
  }

  function handlePointerMove(gx, gy) {
    if (!activeType) return false;
    hoverPoint = pointFromGrid(gx, gy);
    if (draft) api.redraw();
    return true;
  }

  function finish() {
    if (!draft || draft.points.length < minPoints(draft.type)) {
      updateStatus(isArea(draft?.type) ? 'שטח צריך לפחות שלוש פינות.' : 'נדרשות לפחות שתי נקודות כדי ליצור קו.');
      return false;
    }
    api.beforeChange?.();
    const feature = { id: nextId++, type: draft.type, color: draft.color, points: draft.points.map((point) => ({ ...point })) };
    feature.validation = validateFeature(feature);
    features.push(feature);
    draft = null;
    hoverPoint = null;
    updateLegend();
    if (feature.validation?.valid === false) {
      updateStatus(`אזהרה: ${MAP_FEATURE_TYPES[feature.type].label} עולה בכ־${Math.round(feature.validation.totalRise)} מ׳. המקטעים הבעייתיים סומנו באדום.`);
      api.notify('הנחל כולל מקטעים שעולים בגובה. הם סומנו באדום לבדיקה.', true);
    } else if (feature.validation) {
      const drop = Math.max(0, feature.validation.startHeight - feature.validation.endHeight);
      updateStatus(`הנחל תקין טופוגרפית ויורד בכ־${Math.round(drop)} מ׳ מתחילתו לסופו.`);
      api.notify('הנחל עובר בירידה רציפה ומתאים לתבליט.');
    } else {
      updateStatus(`${MAP_FEATURE_TYPES[feature.type].label} נוסף למפה.`);
    }
    redrawAll();
    api.changed?.();
    return true;
  }

  function cancel(deactivate = false) {
    draft = null;
    hoverPoint = null;
    if (deactivate) activeType = null;
    updateStatus();
    api.redraw();
  }

  function removeLast() {
    if (!features.length) return;
    api.beforeChange?.();
    const removed = features.pop();
    updateLegend();
    updateStatus(`${MAP_FEATURE_TYPES[removed.type].label} האחרון הוסר.`);
    redrawAll();
    api.changed?.();
  }

  function handleKey(event) {
    if (!activeType) return false;
    if (event.key === 'Enter') finish();
    else if (event.key === 'Escape' && draft) cancel(false);
    else if (event.key === 'Backspace' && draft?.points.length) {
      draft.points.pop();
      updateStatus();
      api.redraw();
    } else return false;
    event.preventDefault();
    return true;
  }

  // `layers` lets the editor put the land cover under its contour lines and the lines above
  // them, as on a printed map.
  function draw2D(ctx, canvas, dpr, includeDraft = true, { areas = true, lines = true } = {}) {
    if (areas) for (const feature of features) if (isArea(feature.type)) drawFeature2D(ctx, canvas, dpr, feature);
    if (lines) for (const feature of features) if (!isArea(feature.type)) drawFeature2D(ctx, canvas, dpr, feature);
    if (!includeDraft || !draft) return;
    drawFeature2D(ctx, canvas, dpr, draft, hoverPoint);
    ctx.save();
    for (const point of draft.points) {
      ctx.beginPath();
      ctx.arc(point.u * canvas.width, point.v * canvas.height, 4 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = '#fffdf4';
      ctx.fill();
      ctx.lineWidth = 1.5 * dpr;
      ctx.strokeStyle = '#263f38';
      ctx.stroke();
    }
    ctx.restore();
  }

  function terrainChanged() {
    refreshValidation();
    rebuild3D();
  }

  function resize(oldSize, newSize) {
    for (const feature of features) {
      feature.points = feature.points
        .map((point) => ({ u: .5 + (point.u - .5) * oldSize / newSize, v: .5 + (point.v - .5) * oldSize / newSize }))
        .filter((point) => point.u >= 0 && point.u <= 1 && point.v >= 0 && point.v <= 1);
    }
    for (let i = features.length - 1; i >= 0; i--) if (features[i].points.length < minPoints(features[i].type)) features.splice(i, 1);
    cancel(false);
    refreshValidation();
    updateLegend();
    refreshAreas();
    rebuild3D();
  }

  function serialize() {
    return features.map(({ type, color, points, imported }) => ({ type, color, ...(imported ? { imported: true } : {}), points: points.map(({ u, v }) => ({ u, v })) }));
  }

  function load(list = []) {
    features.length = 0;
    for (const item of list) {
      if (!MAP_FEATURE_TYPES[item?.type] || !Array.isArray(item.points) || item.points.length < minPoints(item.type)) continue;
      features.push({ id: nextId++, type: item.type, color: item.color || 'red', imported: item.imported === true, points: item.points.map(({ u, v }) => ({ u: clamp(u, 0, 1), v: clamp(v, 0, 1) })) });
    }
    cancel(false);
    refreshValidation();
    updateLegend();
    updateStatus();
    refreshAreas();
    rebuild3D();
  }

  function clearAll() {
    load([]);
  }

  function stats() {
    const invalidStreams = features.filter((feature) => isWater(feature.type) && feature.validation?.valid === false).length;
    return { count: features.length, invalidStreams, activeType, drafting: Boolean(draft) };
  }

  document.querySelectorAll('[data-feature-type]').forEach((button) => button.addEventListener('click', () => activate(button.dataset.featureType)));
  document.getElementById('finishFeatureBtn').addEventListener('click', finish);
  document.getElementById('cancelFeatureBtn').addEventListener('click', () => cancel(false));
  document.getElementById('removeLastFeatureBtn').addEventListener('click', removeLast);
  document.getElementById('trailColorSelect').addEventListener('change', (event) => {
    if (draft?.type === 'markedTrail') draft.color = event.target.value;
    api.redraw();
  });
  updateStatus();

  return {
    handlePointerDown,
    handlePointerMove,
    handleDoubleClick: finish,
    handleKey,
    draw2D,
    refreshValidation,
    terrainChanged,
    resize,
    cancel,
    stats,
    activate,
    serialize,
    load,
    clearAll,
    groundInfo,
    refreshAreas,
    get active() { return Boolean(activeType); },
    get activeType() { return activeType; },
    get drafting() { return Boolean(draft); },
  };
}
