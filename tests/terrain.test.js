import test from 'node:test';
import assert from 'node:assert/strict';
import { generateTerrain } from '../src/terrain-generator.js';
import { computeFlowModel } from '../src/hydrology.js';

test('seed reproduces the map and different seeds change it', () => {
  const original = generateTerrain(96, { seed: 42 });
  assert.deepEqual(original, generateTerrain(96, { seed: 42 }));
  assert.notDeepEqual(original, generateTerrain(96, { seed: 43 }));
});
test('all controls influence the terrain; zero relief is flat', () => {
  const base = { seed: 42, relief: 120, variation: 60, detail: 35, valleys: 40 };
  const original = generateTerrain(96, base);
  for (const key of ['relief', 'variation', 'detail', 'valleys']) {
    assert.notDeepEqual(original, generateTerrain(96, { ...base, [key]: 0 }), key);
  }
  assert.ok(generateTerrain(96, { relief: 0 }).every(h => h === 0));
  const shallow = generateTerrain(96, { ...base, valleys: 0 });
  const deep = generateTerrain(96, { ...base, valleys: 100 });
  assert.ok(deep.every((h, i) => h <= shallow[i]));
});
test('all map sizes and parameter extremes stay finite and within editor bounds', () => {
  for (const size of [96, 144, 192]) {
    for (const seed of [0, 12345, 4294967295]) {
      for (const level of [0, 100]) {
        const h = generateTerrain(size, { seed, relief: 200, variation: level, detail: level, valleys: level });
        assert.equal(h.length, size * size);
        assert.ok(h.every(v => Number.isFinite(v) && v >= -100 && v <= 200));
      }
    }
  }
});
test('rain follows a subtle valley to its outlet and conserves accumulation', () => {
  const n = 9;
  // Every drop is smaller than the old 0.02 cutoff.
  const heights = Float32Array.from({ length: n*n }, (_, i) =>
    Math.abs(i % n - 4) * .003 + (n - 1 - Math.floor(i/n)) * .001);
  const model = computeFlowModel(n, heights);
  assert.deepEqual(model.sinks, [76]);
  assert.equal(model.accumulation[76], n*n);
  for (let i = 0; i < heights.length; i++) {
    const r = model.receivers[i];
    assert.ok(i === r || heights[r] < heights[i]);
  }
});
test('rain selects the steepest downhill neighbor even for tiny slope differences', () => {
  const h = new Float32Array(9).fill(2);
  h[4] = 1; h[1] = .990; h[3] = .989;
  assert.equal(computeFlowModel(3, h).receivers[4], 3);
});
test('flat terrain retains water; a closed basin collects it', () => {
  const flat = computeFlowModel(9, new Float32Array(81));
  assert.equal(flat.flowingCells, 0);
  assert.equal(flat.sinks.length, 81);
  const basin = Float32Array.from({ length: 81 }, (_, i) => (i % 9 - 4)**2 + (Math.floor(i/9) - 4)**2);
  const flow = computeFlowModel(9, basin);
  assert.deepEqual(flow.sinks, [40]);
  assert.equal(flow.accumulation[40], 81);
});
