import * as THREE from 'three';

export const MAP_FEATURE_TYPES = {
  trail: { label: 'שביל', family: 'land' },
  markedTrail: { label: 'שביל מסומן', family: 'land' },
  dirtRoad: { label: 'דרך עפר', family: 'land' },
  road: { label: 'כביש', family: 'land' },
  perennialStream: { label: 'נחל איתן', family: 'water' },
  intermittentStream: { label: 'נחל אכזב', family: 'water' },
};

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

function drawFeature2D(ctx, canvas, dpr, feature, previewPoint = null) {
  const source = previewPoint ? [...feature.points, previewPoint] : feature.points;
  const points = source.map((point) => ({ x: point.u * canvas.width, y: point.v * canvas.height }));
  if (points.length < 2) return;
  ctx.save();
  if (feature.type === 'trail') {
    strokePolyline(ctx, points, 1.7 * dpr, '#343b38', [6 * dpr, 5 * dpr]);
  } else if (feature.type === 'markedTrail') {
    strokePolyline(ctx, points, 3.8 * dpr, 'rgba(255,255,247,.82)');
    strokePolyline(ctx, points, 2.1 * dpr, TRAIL_COLORS[feature.color] || TRAIL_COLORS.red);
  } else if (feature.type === 'dirtRoad') {
    strokeParallelSegments(ctx, points, 2.2 * dpr, 1.25 * dpr, '#4f4a3e', [7 * dpr, 4 * dpr]);
  } else if (feature.type === 'road') {
    strokePolyline(ctx, points, 7 * dpr, '#454b48');
    strokePolyline(ctx, points, 4.6 * dpr, '#e9c77b');
  } else if (feature.type === 'perennialStream') {
    strokePolyline(ctx, points, 3 * dpr, '#237eb1');
    drawFlowArrow(ctx, points, '#237eb1', dpr);
  } else if (feature.type === 'intermittentStream') {
    strokePolyline(ctx, points, 2.6 * dpr, '#368bb7', [9 * dpr, 6 * dpr]);
    drawFlowArrow(ctx, points, '#368bb7', dpr);
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
    child.geometry?.dispose?.();
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

function addFeature3D(api, group, feature) {
  const add = (mesh) => { if (mesh) group.add(mesh); };
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
    if (!isWater(feature.type) || feature.points.length < 2) return null;
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

  function redrawAll() {
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
    document.getElementById('finishFeatureBtn').disabled = !draft || draft.points.length < 2;
    document.getElementById('cancelFeatureBtn').disabled = !draft;
    document.getElementById('removeLastFeatureBtn').disabled = features.length === 0;
    document.getElementById('mapCanvas').classList.toggle('drawing-feature', Boolean(activeType));
    for (const button of document.querySelectorAll('[data-feature-type]')) {
      const selected = button.dataset.featureType === activeType;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
    if (message) status.textContent = message;
    else if (draft) status.textContent = `${activeLabel}: ${draft.points.length} נקודות. לחיצה כפולה או Enter לסיום.`;
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
    if (!draft || draft.points.length < 2) {
      updateStatus('נדרשות לפחות שתי נקודות כדי ליצור קו.');
      return false;
    }
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

  function draw2D(ctx, canvas, dpr, includeDraft = true) {
    for (const feature of features) drawFeature2D(ctx, canvas, dpr, feature);
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
    for (let i = features.length - 1; i >= 0; i--) if (features[i].points.length < 2) features.splice(i, 1);
    cancel(false);
    refreshValidation();
    updateLegend();
    rebuild3D();
  }

  function serialize() {
    return features.map(({ type, color, points }) => ({ type, color, points: points.map(({ u, v }) => ({ u, v })) }));
  }

  function load(list = []) {
    features.length = 0;
    for (const item of list) {
      if (!MAP_FEATURE_TYPES[item?.type] || !Array.isArray(item.points) || item.points.length < 2) continue;
      features.push({ id: nextId++, type: item.type, color: item.color || 'red', points: item.points.map(({ u, v }) => ({ u: clamp(u, 0, 1), v: clamp(v, 0, 1) })) });
    }
    cancel(false);
    refreshValidation();
    updateLegend();
    updateStatus();
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
    get active() { return Boolean(activeType); },
    get activeType() { return activeType; },
    get drafting() { return Boolean(draft); },
  };
}
