// Pure terrain-brush math, kept free of DOM/Three.js so it can be unit-tested.
// Coordinates are grid cells (0..n-1); `radius` is in cells.

export const SHAPE_TOOLS = ['smudge', 'pinch', 'flatten'];
export const SCULPT_TOOLS = ['raise', 'lower', 'smooth', ...SHAPE_TOOLS];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function forEachCell(n, gx, gy, radius, visit) {
  const minX = Math.max(0, Math.floor(gx - radius));
  const maxX = Math.min(n - 1, Math.ceil(gx + radius));
  const minY = Math.max(0, Math.floor(gy - radius));
  const maxY = Math.min(n - 1, Math.ceil(gy + radius));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const d = Math.hypot(x - gx, y - gy) / radius;
      if (d >= 1) continue;
      visit(x, y, (1 - d * d) ** 2);
    }
  }
}

// Raise (amount > 0) or lower (amount < 0) with a smooth bell falloff.
export function applyHeightBrush(heights, n, gx, gy, radius, amount, min = -100, max = 200) {
  forEachCell(n, gx, gy, radius, (x, y, falloff) => {
    const i = y * n + x;
    heights[i] = clamp(heights[i] + amount * falloff, min, max);
  });
}

// Pull every cell toward its 5×5 neighbourhood average. `rate` is 0..1 per stamp.
const SMOOTH_REACH = 2;
export function applySmoothBrush(heights, n, gx, gy, radius, rate) {
  const source = new Map();
  forEachCell(n, gx, gy, radius + SMOOTH_REACH + 1, (x, y) => source.set(y * n + x, heights[y * n + x]));
  const read = (x, y) => {
    const i = clamp(y, 0, n - 1) * n + clamp(x, 0, n - 1);
    return source.has(i) ? source.get(i) : heights[i];
  };
  forEachCell(n, gx, gy, radius, (x, y, falloff) => {
    let sum = 0;
    for (let dy = -SMOOTH_REACH; dy <= SMOOTH_REACH; dy++) {
      for (let dx = -SMOOTH_REACH; dx <= SMOOTH_REACH; dx++) sum += read(x + dx, y + dy);
    }
    const i = y * n + x;
    const t = clamp(rate * falloff, 0, 1);
    heights[i] = heights[i] + (sum / (2 * SMOOTH_REACH + 1) ** 2 - heights[i]) * t;
  });
}

// Slope in percent at a grid cell, using central differences. cellMeters = ground distance between cells.
export function slopePercent(heights, n, x, y, cellMeters) {
  const xi = clamp(Math.round(x), 0, n - 1);
  const yi = clamp(Math.round(y), 0, n - 1);
  const xm = Math.max(0, xi - 1), xp = Math.min(n - 1, xi + 1);
  const ym = Math.max(0, yi - 1), yp = Math.min(n - 1, yi + 1);
  const dx = (heights[yi * n + xp] - heights[yi * n + xm]) / (Math.max(1, xp - xm) * cellMeters);
  const dy = (heights[yp * n + xi] - heights[ym * n + xi]) / (Math.max(1, yp - ym) * cellMeters);
  return Math.hypot(dx, dy) * 100;
}

// ——— Shape tools: move existing terrain instead of adding or removing height ———

// Bilinear read from a height grid, clamped to its edges.
function sample(src, n, x, y) {
  const cx = clamp(x, 0, n - 1);
  const cy = clamp(y, 0, n - 1);
  const x0 = Math.min(n - 2, Math.floor(cx));
  const y0 = Math.min(n - 2, Math.floor(cy));
  const tx = cx - x0;
  const ty = cy - y0;
  const top = src[y0 * n + x0] + (src[y0 * n + x0 + 1] - src[y0 * n + x0]) * tx;
  const bottom = src[(y0 + 1) * n + x0] + (src[(y0 + 1) * n + x0 + 1] - src[(y0 + 1) * n + x0]) * tx;
  return top + (bottom - top) * ty;
}

// Generic warp: every cell inside the brush takes the height found at `source(x, y, falloff)`
// in a snapshot of the grid. Terrain is moved, not created.
export function applyWarpBrush(heights, n, gx, gy, radius, source) {
  const src = Float32Array.from(heights);
  forEachCell(n, gx, gy, radius, (x, y, falloff) => {
    const [sx, sy] = source(x, y, falloff);
    heights[y * n + x] = sample(src, n, sx, sy);
  });
}

// Smudge ("מריחה"): drags the terrain along the pointer's motion (dx, dy in cells),
// most strongly at the brush centre. `strength` 0..1.
export function applySmudgeBrush(heights, n, gx, gy, radius, dx, dy, strength = 1) {
  applyWarpBrush(heights, n, gx, gy, radius, (x, y, f) => [x - dx * f * strength, y - dy * f * strength]);
}

// Pinch ("צביטה"): amount > 0 pulls the terrain towards the brush centre (a valley under
// the brush gets narrower, a ridge sharper); amount < 0 pushes it outwards ("הרחבה":
// a valley widens, a dome spreads). |amount| is the fractional pull per stamp.
export function applyPinchBrush(heights, n, gx, gy, radius, amount) {
  applyWarpBrush(heights, n, gx, gy, radius, (x, y, f) => {
    const k = 1 + amount * f;
    return [gx + (x - gx) * k, gy + (y - gy) * k];
  });
}

// Flatten ("השטחה"): pulls heights towards `target` (the height where the stroke began).
export function applyFlattenBrush(heights, n, gx, gy, radius, target, rate) {
  forEachCell(n, gx, gy, radius, (x, y, falloff) => {
    const i = y * n + x;
    heights[i] += (target - heights[i]) * clamp(rate * falloff, 0, 1);
  });
}
