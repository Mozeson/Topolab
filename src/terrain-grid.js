// Grid geometry for each map size: how many samples, and how to resample between sizes.
// 4/6/8 km maps keep their historical resolutions; the 1 km map is sampled every 5 m or 10 m.
const lerp = (a, b, t) => a + (b - a) * t;
export function gridResolution(sizeKm, localSpacing = 5) {
  if (sizeKm === 1 && [5, 10].includes(localSpacing)) return 1000 / localSpacing + 1;
  return { 4: 96, 6: 144, 8: 192 }[sizeKm];
}
export function brushRadiusCells(diameterMeters, extentMeters, size) {
  return diameterMeters / 2 / extentMeters * (size - 1);
}
// Kept for compatibility with existing callers/tests; the implementation lives in brush.js.
export { applyHeightBrush as sculpt } from './brush.js';

export function resampleForMapSize(oldHeights, oldN, oldSize, newN, newSize) {
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

