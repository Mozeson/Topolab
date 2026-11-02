// Route every strictly positive downhill slope; flat cells and real sinks retain water.
export function computeFlowModel(size, heights) {
  const count = size * size;
  const receivers = new Int32Array(count);
  const accumulation = new Float32Array(count);
  accumulation.fill(1);
  const neighbors = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0], [1, 0],
    [-1, 1], [0, 1], [1, 1],
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = y * size + x;
      let receiver = index;
      let bestSlope = 0;
      for (const [dx, dy] of neighbors) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= size || ny < 0 || ny >= size) continue;
        const next = ny * size + nx;
        const drop = heights[index] - heights[next];
        const slope = drop / Math.hypot(dx, dy);
        if (slope > bestSlope) {
          bestSlope = slope;
          receiver = next;
        }
      }
      receivers[index] = receiver;
    }
  }
  const order = Array.from({ length: count }, (_, index) => index).sort((a, b) => heights[b] - heights[a]);
  for (const index of order) {
    const receiver = receivers[index];
    if (receiver !== index) accumulation[receiver] += accumulation[index];
  }
  const sinks = [];
  let flowingCells = 0;
  const flowAmounts = [];
  for (let index = 0; index < count; index++) {
    if (receivers[index] === index) sinks.push(index);
    else {
      flowingCells++;
      flowAmounts.push(accumulation[index]);
    }
  }
  flowAmounts.sort((a, b) => a - b);
  const percentileIndex = Math.floor(flowAmounts.length * .90);
  const flowThreshold = Math.max(4, size * .06, flowAmounts[percentileIndex] || 4);
  return { size, receivers, accumulation, sinks, flowingCells, flowThreshold };
}

// ——— Full hydrology for the rain simulator ———
// Two stages:
//  computeHydrology(n, heights)  — terrain analysis, done once per terrain:
//    1. Priority-flood (Barnes et al., 2014) from the map edge: every pit is raised to its
//       spill level (`filled`); a tiny epsilon on flats (`routed`) gives every cell a
//       strictly downhill path to the edge.
//    2. D8 receivers (steepest neighbour) for tracing; MFD weights (water split among all
//       lower neighbours, Quinn-style) for accumulation, so flow spreads on cones and
//       concentrates in valleys instead of drawing artificial straight lines.
//    3. Depressions deeper than `minLakeDepth` over `minLakeCells` cells become potential
//       lakes, with their spill point and the area that drains into them.
//  simulateRain(base, { rainMeters, cellArea }) — what a given amount of rain does:
//    lakes fill with the water of their catchment (upstream first); only full lakes
//    overflow downstream. Streams are traced where enough water flows over sloped ground.
// computeHydrology returns base + simulateRain(base) with unlimited rain (every lake full).

class MinHeap {
  constructor() { this.keys = []; this.values = []; }
  get size() { return this.keys.length; }
  push(key, value) {
    const keys = this.keys; const values = this.values;
    let i = keys.length;
    keys.push(key); values.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      keys[i] = keys[parent]; values[i] = values[parent];
      i = parent;
    }
    keys[i] = key; values[i] = value;
  }
  pop() {
    const keys = this.keys; const values = this.values;
    const top = values[0];
    const lastKey = keys.pop(); const lastValue = values.pop();
    if (keys.length) {
      let i = 0;
      const n = keys.length;
      while (true) {
        let child = 2 * i + 1;
        if (child >= n) break;
        if (child + 1 < n && keys[child + 1] < keys[child]) child++;
        if (keys[child] >= lastKey) break;
        keys[i] = keys[child]; values[i] = values[child];
        i = child;
      }
      keys[i] = lastKey; values[i] = lastValue;
    }
    return top;
  }
}

const D8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
const EPSILON = 1e-6;
const MFD_EXPONENT = 1.1;

export function analyzeTerrain(n, heights, { minLakeDepth = .3, minLakeCells = 4, minStreamDrop = .02 } = {}) {
  const count = n * n;
  const filled = new Float64Array(count);
  const routed = new Float64Array(count);
  const closed = new Uint8Array(count);
  const heap = new MinHeap();
  const isEdge = (x, y) => x === 0 || y === 0 || x === n - 1 || y === n - 1;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!isEdge(x, y)) continue;
      const i = y * n + x;
      filled[i] = heights[i];
      routed[i] = heights[i];
      closed[i] = 1;
      heap.push(routed[i], i);
    }
  }
  while (heap.size) {
    const c = heap.pop();
    const cx = c % n;
    const cy = (c - cx) / n;
    for (const [dx, dy] of D8) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= n || y >= n) continue;
      const i = y * n + x;
      if (closed[i]) continue;
      closed[i] = 1;
      filled[i] = Math.max(heights[i], filled[c]);
      routed[i] = Math.max(heights[i], routed[c] + EPSILON);
      heap.push(routed[i], i);
    }
  }

  // D8 receivers and MFD weights (up to 8 per cell).
  const receivers = new Int32Array(count);
  const mfdTo = new Int32Array(count * 8).fill(-1);
  const mfdWeight = new Float32Array(count * 8);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      let receiver = -1;
      let best = 0;
      let total = 0;
      let k = 0;
      // Water that reaches the map edge leaves the map (it must not run along the border).
      if (isEdge(x, y)) { receivers[i] = -1; continue; }
      for (const [dx, dy] of D8) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        const j = ny * n + nx;
        const slope = (routed[i] - routed[j]) / Math.hypot(dx, dy);
        if (slope <= 0) continue;
        if (slope > best) { best = slope; receiver = j; }
        const w = slope ** MFD_EXPONENT;
        mfdTo[i * 8 + k] = j;
        mfdWeight[i * 8 + k] = w;
        total += w;
        k++;
      }
      for (let m = 0; m < k; m++) mfdWeight[i * 8 + m] /= total;
      receivers[i] = receiver; // -1: an edge cell with no lower neighbour drains off the map
    }
  }
  const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => routed[b] - routed[a]);

  const sloped = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const r = receivers[i];
    if (r >= 0 && heights[i] - heights[r] > minStreamDrop) sloped[i] = 1;
  }

  // Potential lakes (depressions filled to their spill level).
  const depth = new Float32Array(count);
  for (let i = 0; i < count; i++) depth[i] = Math.max(0, filled[i] - heights[i]);
  const lakeId = new Int32Array(count).fill(-1);
  const lakes = [];
  const seen = new Uint8Array(count);
  for (let start = 0; start < count; start++) {
    if (seen[start] || depth[start] <= minLakeDepth) continue;
    const cells = [];
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const c = stack.pop();
      cells.push(c);
      const cx = c % n;
      const cy = (c - cx) / n;
      for (const [dx, dy] of D8) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        const j = y * n + x;
        if (!seen[j] && depth[j] > minLakeDepth) { seen[j] = 1; stack.push(j); }
      }
    }
    if (cells.length < minLakeCells) continue;
    const id = lakes.length;
    let maxDepth = 0;
    let capacity = 0;
    let level = -Infinity;
    for (const c of cells) {
      lakeId[c] = id;
      maxDepth = Math.max(maxDepth, depth[c]);
      capacity += depth[c];
      level = Math.max(level, filled[c]);
    }
    let spill = cells.reduce((a, b) => (depth[b] > depth[a] ? b : a));
    for (let guard = 0; guard < count && receivers[spill] >= 0 && lakeId[receivers[spill]] === id; guard++) spill = receivers[spill];
    const bottoms = cells.map((c) => heights[c]).sort((a, b) => a - b);
    lakes.push({ id, cells, level, maxDepth, capacityCells: capacity, spill, outflow: receivers[spill], bottoms });
  }

  // Which lake (if any) each cell's water reaches first, following D8.
  const lakeOf = new Int32Array(count).fill(-1);
  for (let k = count - 1; k >= 0; k--) {
    const i = order[k]; // lowest first, so receivers are already resolved
    if (lakeId[i] >= 0) lakeOf[i] = lakeId[i];
    else if (receivers[i] >= 0) lakeOf[i] = lakeOf[receivers[i]];
  }
  const catchmentCells = new Float64Array(lakes.length);
  for (let i = 0; i < count; i++) if (lakeOf[i] >= 0) catchmentCells[lakeOf[i]]++;
  for (const lake of lakes) {
    lake.catchmentCells = catchmentCells[lake.id];
    lake.downstream = lake.outflow >= 0 ? lakeOf[lake.outflow] : -1;
  }

  return { size: n, heights, filled, routed, receivers, mfdTo, mfdWeight, order, sloped, depth, lakeId, lakes, minLakeDepth };
}

export function simulateRain(base, { rainMeters = Infinity, cellArea = 1, streamFraction = .006 } = {}) {
  const { size: n, heights, receivers, mfdTo, mfdWeight, order, sloped, lakeId } = base;
  const count = n * n;

  // Fill lakes upstream-first; only full lakes pass water on.
  const overflowIn = new Float64Array(base.lakes.length);
  const lakes = base.lakes.map((lake) => ({ ...lake }));
  for (const lake of [...lakes].sort((a, b) => b.level - a.level)) {
    const inflow = lake.catchmentCells * cellArea * rainMeters + overflowIn[lake.id];
    const capacity = lake.capacityCells * cellArea;
    if (!(inflow < capacity)) {
      lake.full = true;
      lake.fill = 1;
      lake.wetLevel = lake.level;
      if (lake.downstream >= 0) overflowIn[lake.downstream] += inflow - capacity;
    } else {
      // Water level holding exactly `inflow`: bisect over the lake's bottom profile.
      let lo = lake.bottoms[0];
      let hi = lake.level;
      for (let k = 0; k < 40; k++) {
        const mid = (lo + hi) / 2;
        let v = 0;
        for (const b of lake.bottoms) { if (b >= mid) break; v += mid - b; }
        if (v * cellArea > inflow) hi = mid; else lo = mid;
      }
      lake.full = false;
      lake.wetLevel = lo;
      lake.fill = inflow / capacity;
    }
    lake.wetDepth = lake.wetLevel - lake.bottoms[0];
    lake.wetCells = lake.bottoms.filter((b) => b < lake.wetLevel - base.minLakeDepth).length;
  }
  const wet = new Float32Array(count);
  for (const lake of lakes) for (const c of lake.cells) wet[c] = Math.max(0, lake.wetLevel - heights[c]);

  // Two accumulations; lakes that are not full swallow what reaches them.
  //  - MFD (`accumulation`): physically spread flow — decides whether enough water gathers
  //    for a stream (no invented streams on cones and convex slopes);
  //  - D8 (`channel`): single-thread flow — gives the stream network clean, single lines
  //    (MFD alone produces bundles of parallel strands where flow is spread).
  const accumulation = new Float32Array(count).fill(1);
  const channel = new Float32Array(count).fill(1);
  const outflow = new Float32Array(count);
  for (const i of order) {
    const id = lakeId[i];
    if (id >= 0 && !lakes[id].full) continue;
    if (receivers[i] >= 0) channel[receivers[i]] += channel[i];
    let passed = false;
    for (let k = 0; k < 8; k++) {
      const j = mfdTo[i * 8 + k];
      if (j < 0) break;
      accumulation[j] += accumulation[i] * mfdWeight[i * 8 + k];
      passed = true;
    }
    if (!passed) outflow[i] = accumulation[i];
  }

  // Streams over sloped, dry ground, traced along D8 from their heads.
  const threshold = Math.max(6, count * streamFraction);
  const isStream = (i) => channel[i] >= threshold && accumulation[i] >= threshold * .4 && sloped[i] && wet[i] <= base.minLakeDepth;
  const hasStreamDonor = new Uint8Array(count);
  for (let i = 0; i < count; i++) if (receivers[i] >= 0 && isStream(i)) hasStreamDonor[receivers[i]] = 1;
  const heads = [];
  for (let i = 0; i < count; i++) if (isStream(i) && !hasStreamDonor[i]) heads.push(i);
  heads.sort((a, b) => base.routed[b] - base.routed[a]);
  const visited = new Uint8Array(count);
  const streams = [];
  const outlets = new Map();
  for (const head of heads) {
    const cells = [head];
    visited[head] = 1;
    let current = receivers[head];
    let end = 'edge';
    while (current >= 0) {
      cells.push(current);
      if (wet[current] > base.minLakeDepth) { end = 'lake'; break; }
      if (!sloped[current] && receivers[current] >= 0) { end = 'flat'; break; }
      if (visited[current]) { end = 'junction'; break; }
      visited[current] = 1;
      current = receivers[current];
    }
    const last = cells[cells.length - 1];
    if (end === 'edge') outlets.set(last, Math.max(outlets.get(last) || 0, accumulation[last]));
    if (cells.length >= 2) streams.push({ cells, end });
  }
  for (const lake of lakes) if (lake.full && lake.outflow < 0) outlets.set(lake.spill, accumulation[lake.spill]);

  return {
    lakes,
    wet,
    accumulation,
    streams,
    outlets: [...outlets.entries()].map(([index, flow]) => ({ index, flow })).sort((a, b) => b.flow - a.flow),
    threshold,
  };
}

export function computeHydrology(n, heights, options = {}) {
  const base = analyzeTerrain(n, heights, options);
  const water = simulateRain(base, options);
  return { ...base, ...water, depth: water.wet, receivers: base.receivers };
}
