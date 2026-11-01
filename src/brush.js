// Pure terrain-brush math, kept free of DOM/Three.js so it can be unit-tested.
// Coordinates are grid cells (0..n-1); `radius` is in cells.

export const SCULPT_TOOLS = ['raise', 'lower', 'smooth'];

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
export function applyHeightBrush(heights, n, gx, gy, radius, amount, min, max) {
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
