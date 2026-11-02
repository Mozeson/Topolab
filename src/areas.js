// Area land cover (שטחים): forests, orchards, vineyards, fields, built-up areas.
// Pure helpers (no DOM / Three.js): the type table, point-in-polygon, rasterising the
// drawn polygons onto the terrain grid, and the walking-speed grid the navigation game
// uses (areas slow you down, roads and trails speed you up). See docs/UI-GUIDE.md.

// speed: walking-speed multiplier inside the area (1 = open ground).
// fill/ink: map colours (fill + pattern ink), tint: rgb 0..1 for the 3D terrain.
export const AREA_TYPES = {
  naturalForest: { label: 'יער טבעי', speed: .55, fill: '#cfe3b4', ink: '#4f8a3c', tint: [.36, .55, .27] },
  plantedForest: { label: 'יער נטוע', speed: .7, fill: '#d5e8bd', ink: '#3f7a35', tint: [.33, .5, .25] },
  orchard: { label: 'מטע', speed: .85, fill: '#e3eecb', ink: '#5d8f3e', tint: [.5, .62, .33] },
  vineyard: { label: 'כרם', speed: .8, fill: '#ece8c6', ink: '#7a7a33', tint: [.62, .6, .36] },
  field: { label: 'שדה', speed: .92, fill: '#f3ecc4', ink: '#c9b56a', tint: [.78, .71, .45] },
  builtUp: { label: 'שטח בנוי', speed: .9, fill: '#f0caa0', ink: '#b9784a', tint: [.72, .55, .43] },
};
export const AREA_ORDER = Object.keys(AREA_TYPES);

// Lines that make walking faster, and how wide (metres) their effect is.
export const PATH_SPEED = {
  road: { speed: 1.25, halfWidth: 6 },
  dirtRoad: { speed: 1.2, halfWidth: 4 },
  markedTrail: { speed: 1.1, halfWidth: 3 },
  trail: { speed: 1.1, halfWidth: 3 },
};

export const isArea = (type) => Boolean(AREA_TYPES[type]);

export function pointInPolygon(u, v, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    if ((a.v > v) !== (b.v > v) && u < (b.u - a.u) * (v - a.v) / (b.v - a.v) + a.u) inside = !inside;
  }
  return inside;
}

export function polygonArea(points) {
  let sum = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) sum += (points[j].u + points[i].u) * (points[j].v - points[i].v);
  return Math.abs(sum) / 2;
}

// Grid of area-type indices (index into AREA_ORDER, -1 = none). Later areas win, so
// drawing a field inside a forest makes a clearing.
export function rasterizeAreas(n, features) {
  const grid = new Int8Array(n * n).fill(-1);
  for (const feature of features) {
    const index = AREA_ORDER.indexOf(feature.type);
    if (index < 0 || feature.points.length < 3) continue;
    let minU = 1; let maxU = 0; let minV = 1; let maxV = 0;
    for (const p of feature.points) {
      minU = Math.min(minU, p.u); maxU = Math.max(maxU, p.u);
      minV = Math.min(minV, p.v); maxV = Math.max(maxV, p.v);
    }
    const x0 = Math.max(0, Math.floor(minU * (n - 1)));
    const x1 = Math.min(n - 1, Math.ceil(maxU * (n - 1)));
    const y0 = Math.max(0, Math.floor(minV * (n - 1)));
    const y1 = Math.min(n - 1, Math.ceil(maxV * (n - 1)));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (pointInPolygon(x / (n - 1), y / (n - 1), feature.points)) grid[y * n + x] = index;
      }
    }
  }
  return grid;
}

function segmentDistance(u, v, a, b) {
  const du = b.u - a.u;
  const dv = b.v - a.v;
  const t = Math.max(0, Math.min(1, ((u - a.u) * du + (v - a.v) * dv) / (du * du + dv * dv || 1)));
  return Math.hypot(u - (a.u + du * t), v - (a.v + dv * t));
}

// Walking-speed multiplier per grid cell. Paths beat areas (a trail through a forest is
// fast); otherwise the area's factor applies, open ground is 1.
export function buildSpeedGrid(n, features, extentMeters, areaGrid = rasterizeAreas(n, features)) {
  const speed = new Float32Array(n * n).fill(1);
  for (let i = 0; i < n * n; i++) if (areaGrid[i] >= 0) speed[i] = AREA_TYPES[AREA_ORDER[areaGrid[i]]].speed;
  const cell = extentMeters / (n - 1);
  for (const feature of features) {
    const path = PATH_SPEED[feature.type];
    if (!path || feature.points.length < 2) continue;
    // Never narrower than half a grid cell, or a road would miss the cells it crosses.
    const reach = Math.max(path.halfWidth, cell * .55) / extentMeters;
    for (let k = 1; k < feature.points.length; k++) {
      const a = feature.points[k - 1];
      const b = feature.points[k];
      const x0 = Math.max(0, Math.floor((Math.min(a.u, b.u) - reach) * (n - 1)));
      const x1 = Math.min(n - 1, Math.ceil((Math.max(a.u, b.u) + reach) * (n - 1)));
      const y0 = Math.max(0, Math.floor((Math.min(a.v, b.v) - reach) * (n - 1)));
      const y1 = Math.min(n - 1, Math.ceil((Math.max(a.v, b.v) + reach) * (n - 1)));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if (segmentDistance(x / (n - 1), y / (n - 1), a, b) <= reach) speed[y * n + x] = Math.max(speed[y * n + x], path.speed);
        }
      }
    }
  }
  return speed;
}
