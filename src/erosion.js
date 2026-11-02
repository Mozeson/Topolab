// Landscape "ageing": makes noise-based terrain drain like real landscapes.
// Two processes, both pure (no DOM / Three.js) and deterministic:
//  - erodeStreamPower: implicit stream-power incision (Braun & Willett, 2013). Each pass
//    lowers every cell towards its downstream neighbour in proportion to √(upstream area),
//    carving branching valley networks that widen downstream. Map-edge cells are the base
//    level and never change. A little hillslope diffusion keeps valley sides smooth.
//  - breachDepressions: closed pits are cut open along their outflow path (like a stream
//    cutting through a natural dam) instead of being filled; only pits at least
//    `keepDepth` deep and `keepCells` large survive as real lakes.
// drainLandscape combines them for the random-map generator; see docs/RAIN.md.
import { analyzeTerrain } from './hydrology.js';

function hash01(value) {
  let x = value >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

// Flow directions on the depression-filled surface (so water can always leave the map),
// D8 accumulation, and the processing order from downstream to upstream.
function flowNetwork(n, heights) {
  const base = analyzeTerrain(n, heights, { minLakeDepth: Infinity });
  const count = n * n;
  const area = new Float32Array(count).fill(1);
  for (const i of base.order) if (base.receivers[i] >= 0) area[base.receivers[i]] += area[i];
  return { receivers: base.receivers, area, upstreamOrder: base.order.slice().reverse() };
}

// `roughness` (metres) adds tiny deterministic bumps first: on a perfectly smooth surface
// water spreads evenly and no channel can start; in nature small irregularities seed them.
export function erodeStreamPower(heights, n, { passes = 6, strength = .5, diffusion = .08, m = .5, roughness = 0, seed = 1 } = {}) {
  const count = n * n;
  if (roughness > 0) {
    // Smooth value noise (lattice every 4 cells) so a few larger gullies start rather than
    // many tiny ones, and only on slopes — flat ground stays flat.
    const cellNoise = (gx, gy) => hash01(gx * 73856093 ^ gy * 19349663 ^ seed * 83492791) - .5;
    const source = Float32Array.from(heights);
    for (let y = 1; y < n - 1; y++) {
      for (let x = 1; x < n - 1; x++) {
        const i = y * n + x;
        const gx = x / 4;
        const gy = y / 4;
        const x0 = Math.floor(gx);
        const y0 = Math.floor(gy);
        const tx = gx - x0;
        const ty = gy - y0;
        const noise = (cellNoise(x0, y0) * (1 - tx) + cellNoise(x0 + 1, y0) * tx) * (1 - ty)
          + (cellNoise(x0, y0 + 1) * (1 - tx) + cellNoise(x0 + 1, y0 + 1) * tx) * ty;
        const gradient = Math.hypot(source[i + 1] - source[i - 1], source[i + n] - source[i - n]) / 2;
        heights[i] += noise * roughness * Math.min(1, gradient / .5);
      }
    }
  }
  for (let pass = 0; pass < passes; pass++) {
    const { receivers, area, upstreamOrder } = flowNetwork(n, heights);
    // Erodibility scaled so `strength` means the same on every grid size.
    const k = strength * .9 / Math.sqrt(count);
    for (const i of upstreamOrder) { // receivers are always updated before their donors
      const r = receivers[i];
      if (r < 0) continue;
      const dx = (i % n !== r % n && Math.floor(i / n) !== Math.floor(r / n)) ? Math.SQRT2 : 1;
      const f = k * area[i] ** m / dx;
      const lowered = (heights[i] + f * heights[r]) / (1 + f);
      if (lowered < heights[i]) heights[i] = lowered;
    }
    if (diffusion > 0) {
      const source = Float32Array.from(heights);
      for (let y = 1; y < n - 1; y++) {
        for (let x = 1; x < n - 1; x++) {
          const i = y * n + x;
          const mean = (source[i - 1] + source[i + 1] + source[i - n] + source[i + n]) / 4;
          heights[i] += (mean - source[i]) * diffusion;
        }
      }
    }
  }
  return heights;
}

export function breachDepressions(heights, n, { keepDepth = 8, keepCells = 40, drop = .02, rounds = 4 } = {}) {
  for (let round = 0; round < rounds; round++) {
    const base = analyzeTerrain(n, heights, { minLakeDepth: .05, minLakeCells: 1 });
    const toBreach = base.lakes.filter((lake) => lake.maxDepth < keepDepth || lake.cells.length < keepCells);
    if (!toBreach.length) break;
    for (const lake of toBreach) {
      // Start at the lake bottom and follow the flow out over the spill point, lowering the
      // path so it keeps falling until it meets ground that is already lower.
      let current = lake.cells.reduce((a, b) => (heights[b] < heights[a] ? b : a));
      let level = heights[current];
      for (let guard = 0; guard < n * n; guard++) {
        const next = base.receivers[current];
        if (next < 0) break;
        level -= drop;
        if (heights[next] <= level) break;
        heights[next] = level;
        current = next;
      }
    }
  }
  return heights;
}

// amount 0..100: 0 leaves the terrain untouched; higher values erode longer and keep only
// larger, deeper lakes. Relief is restored afterwards so the map keeps its height range.
export function drainLandscape(heights, n, amount = 60, { min = -100, max = 200 } = {}) {
  if (amount <= 0) return heights;
  const t = Math.min(1, amount / 100);
  const before = rangeOf(heights);
  erodeStreamPower(heights, n, { passes: Math.round(3 + t * 9), strength: .5 + t * 1.3, m: .6, diffusion: .03, roughness: 1.5 });
  breachDepressions(heights, n, { keepDepth: 3 + t * 22, keepCells: Math.round(8 + t * n * .8) });
  // Erosion removes material mostly from high ground; stretch back to the original range.
  const after = rangeOf(heights);
  const scale = after.max > after.min ? (before.max - before.min) / (after.max - after.min) : 1;
  for (let i = 0; i < heights.length; i++) {
    heights[i] = Math.max(min, Math.min(max, before.min + (heights[i] - after.min) * scale));
  }
  return heights;
}

function rangeOf(heights) {
  let min = Infinity;
  let max = -Infinity;
  for (const h of heights) { if (h < min) min = h; if (h > max) max = h; }
  return { min, max };
}
