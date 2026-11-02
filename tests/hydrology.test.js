import test from 'node:test';
import assert from 'node:assert/strict';
import { computeHydrology, analyzeTerrain, simulateRain } from '../src/hydrology.js';
import { generateTerrain } from '../src/terrain-generator.js';

const reachesEdge = (model) => {
  const n = model.size;
  for (let i = 0; i < n * n; i++) {
    let c = i;
    for (let steps = 0; steps <= n * n; steps++) {
      if (model.receivers[c] < 0) break;
      c = model.receivers[c];
      if (steps === n * n) return false;
    }
    const x = c % n;
    const y = Math.floor(c / n);
    if (!(x === 0 || y === 0 || x === n - 1 || y === n - 1)) return false;
  }
  return true;
};

test('every drop eventually leaves the map across its edge', () => {
  const heights = generateTerrain(48, { seed: 9 });
  assert.ok(reachesEdge(computeHydrology(48, heights)));
  assert.ok(reachesEdge(computeHydrology(20, new Float32Array(400))));
});

test('a closed bowl fills to its rim and becomes one lake', () => {
  const n = 21;
  // Bowl 30 m deep, rim at ~50 m, with a notch at 40 m on the east side.
  const heights = Float32Array.from({ length: n * n }, (_, i) => {
    const x = i % n - 10;
    const y = Math.floor(i / n) - 10;
    const r = Math.hypot(x, y);
    let h = 20 + 30 * Math.min(1, r / 7);
    if (x >= 4 && Math.abs(y) <= 1) h = Math.min(h, 40);
    return h;
  });
  const model = computeHydrology(n, heights);
  assert.equal(model.lakes.length, 1);
  const lake = model.lakes[0];
  assert.ok(Math.abs(lake.level - 40) < 1e-6, `level ${lake.level}`);
  assert.ok(Math.abs(lake.maxDepth - 20) < 1e-6);
  assert.ok(lake.capacityCells > 0 && lake.full);
  const sx = lake.spill % n;
  assert.ok(sx > 10, 'spills through the eastern notch');
  assert.ok(reachesEdge(model));
});

test('tiny pits are filled but not reported as lakes', () => {
  const n = 21;
  const heights = Float32Array.from({ length: n * n }, (_, i) => (i % n) * 2);
  heights[10 * n + 10] -= .1;
  assert.equal(computeHydrology(n, heights).lakes.length, 0);
});

test('a tilted valley makes one main stream that reaches the edge and carries the flow', () => {
  const n = 31;
  const heights = Float32Array.from({ length: n * n }, (_, i) => Math.abs(i % n - 15) * 2 + (n - 1 - Math.floor(i / n)) * 1);
  const model = computeHydrology(n, heights);
  assert.equal(model.lakes.length, 0);
  assert.ok(model.streams.length >= 1);
  const main = model.outlets[0];
  assert.ok(main.flow > n * n * .5, `main outlet carries ${main.flow}`);
  assert.equal(Math.floor(main.index / n), n - 1, 'outlet on the downhill (south) edge');
});

test('no streams are invented on perfectly flat ground', () => {
  const n = 25;
  const model = computeHydrology(n, new Float32Array(n * n));
  assert.equal(model.streams.length, 0);
  assert.equal(model.lakes.length, 0);
});

test('a cone sheds water in every direction without inventing streams', () => {
  const n = 96; // the smallest real map grid
  const heights = Float32Array.from({ length: n * n }, (_, i) => 150 - 3 * Math.hypot(i % n - 47.5, Math.floor(i / n) - 47.5));
  assert.equal(computeHydrology(n, heights).streams.length, 0);
});

test('a little rain makes a puddle; a lot fills the lake and it overflows downstream', () => {
  const n = 21;
  const heights = Float32Array.from({ length: n * n }, (_, i) => {
    const x = i % n - 10;
    const y = Math.floor(i / n) - 10;
    let h = 20 + 30 * Math.min(1, Math.hypot(x, y) / 7);
    if (x >= 4 && Math.abs(y) <= 1) h = Math.min(h, 40);
    return h;
  });
  const base = analyzeTerrain(n, heights);
  const little = simulateRain(base, { rainMeters: .5, cellArea: 1 });
  const lots = simulateRain(base, { rainMeters: 1000, cellArea: 1 });
  assert.equal(little.lakes[0].full, false);
  assert.ok(little.lakes[0].wetLevel > 20 && little.lakes[0].wetLevel < 40);
  // The water held equals the rain that fell on the catchment.
  const held = base.lakes[0].cells.reduce((v, c) => v + Math.max(0, little.lakes[0].wetLevel - heights[c]), 0);
  assert.ok(Math.abs(held - base.lakes[0].catchmentCells * .5) < .5);
  assert.equal(lots.lakes[0].full, true);
  assert.ok(Math.abs(lots.lakes[0].wetLevel - 40) < 1e-6);
});
