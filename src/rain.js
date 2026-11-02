// Rain simulator: shows where water goes on the current terrain.
// The physics lives in hydrology.js (computeHydrology): pits fill into lakes up to their
// spill point, everything else drains to the map edge, and streams are traced from the
// flow accumulation. This file animates it:
//   'raining'  — rain falls (3D streaks, 2D drops) while streams grow from their heads and
//                lakes fill from their deepest point up to their spill level;
//   'flowing'  — the steady state: streams keep flowing (scrolling texture) until cleared.
// See docs/RAIN.md.
import { analyzeTerrain, simulateRain } from './hydrology.js';
import { contours } from 'd3-contour';
import * as THREE from 'three';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const RAIN_SECONDS = 3.2;      // how long the growth animation takes
const STREAK_COUNT = 1400;
const RAIN_KEY = 'topolab-rain-amount';

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
  let flowTexture = null;

  function updateUI(message = '') {
    const button = document.getElementById('rainBtn');
    const overlay = document.getElementById('rainStatusOverlay');
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
    button.querySelector('span').textContent = active ? 'ניקוי מים' : 'הפעלת גשם';
    document.getElementById('rainPanel').hidden = !active;
    if (message) overlay.textContent = message;
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

  // ——— 2D map overlay ———
  function draw2D(ctx, canvas, dpr) {
    if (!active || !model) return;
    const w = canvas.width;
    const h = canvas.height;
    const n = model.size;
    const p = phase === 'raining' ? growth : 1;
    ctx.save();
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

    scene.add(group);
    return { group, streaks, drops, ribbons, lakeMeshes, vs, materials: [streamMaterial, lakeMaterial, streaks.material] };
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
    buildPaths();
    buildLakeShapes();
    disposeWorld();
    world = buildWorld();
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
    simulate();
    active = true;
    phase = 'raining';
    growth = 0;
    lastTime = 0;
    lastMapDraw = 0;
    updateUI('יורד גשם… המים מתחילים לזרום במורד');
    cancelAnimationFrame(frameId);
    frameId = requestAnimationFrame(tick);
    api.redraw();
  }

  function stop() {
    active = false;
    phase = 'idle';
    cancelAnimationFrame(frameId);
    disposeWorld();
    base = null;
    model = null;
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
      outlets: model?.outlets.length || 0,
      biggestLakeDepth: model?.lakes.length ? Math.max(0, ...model.lakes.map((l) => l.wetDepth || 0)) : 0,
    };
  }

  document.getElementById('rainBtn').addEventListener('click', toggle);
  const slider = document.getElementById('rainAmount');
  try { const saved = localStorage.getItem(RAIN_KEY); if (saved !== null) slider.value = saved; } catch { /* storage unavailable */ }
  slider.addEventListener('input', onAmountInput);
  document.getElementById('rainAmountValue').value = rainLabel(sliderToMillimetres(Number(slider.value)));
  updateUI();

  // Kept for API compatibility with scene.js (terrain changes stop the rain).
  return { start, stop, toggle, draw2D, update3D: () => update3D(0), stats, get active() { return active; } };
}
