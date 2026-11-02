import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTerrain, simulateRain, drainageBasins, tracePath, upstreamArea } from '../src/hydrology.js';

const n = 41;
const grid = (fn) => Float32Array.from({ length: n * n }, (_, i) => fn(i % n, Math.floor(i / n)));

test('a north–south ridge splits the map into an east and a west basin along its crest', () => {
  const ridge = grid((x, y) => 100 - Math.abs(x - 20) * 4 + y * .1);
  const base = analyzeTerrain(n, ridge);
  const { basinOf, basins } = drainageBasins(base, simulateRain(base), { minShare: .001, maxBasins: 200 });
  // Every cell west of the crest drains west, every cell east of it drains east.
  for (let y = 1; y < n - 1; y++) {
    for (let x = 1; x < n - 1; x++) {
      if (x === 20) continue;
      const basin = basins[basinOf[y * n + x]];
      assert.equal(basin.destination.type, 'edge');
      assert.ok(basin.destination.side.includes(x < 20 ? 'west' : 'east'), `cell ${x},${y} → ${basin.destination.side}`);
    }
  }
});

test('with little rain a bowl is a closed basin ending in its lake; with a lot it drains out', () => {
  const bowl = grid((x, y) => {
    let h = 20 + 30 * Math.min(1, Math.hypot(x - 20, y - 20) / 12);
    if (x >= 28 && Math.abs(y - 20) <= 1) h = Math.min(h, 40);
    return h;
  });
  const base = analyzeTerrain(n, bowl);
  const little = drainageBasins(base, simulateRain(base, { rainMeters: .2, cellArea: 1 }));
  const centre = little.basins[little.basinOf[20 * n + 20]];
  assert.equal(centre.destination.type, 'lake');
  const lots = drainageBasins(base, simulateRain(base, { rainMeters: 1e4, cellArea: 1 }));
  assert.equal(lots.basins[lots.basinOf[20 * n + 20]].destination.type, 'edge');
});

test('a drop path only goes downhill and ends where its basin says', () => {
  const slope = grid((x, y) => Math.abs(x - 20) * 2 + (n - 1 - y) * 1.5);
  const base = analyzeTerrain(n, slope);
  const water = simulateRain(base);
  const path = tracePath(base, water, 5 * n + 8);
  for (let k = 1; k < path.cells.length; k++) assert.ok(slope[path.cells[k]] <= slope[path.cells[k - 1]]);
  assert.equal(path.end.type, 'edge');
  assert.ok(path.end.side.includes('south'));
});

test('the upstream area of a valley outlet holds everything that drains through it', () => {
  const valley = grid((x, y) => Math.abs(x - 20) * 2 + (n - 1 - y) * 1.5);
  const base = analyzeTerrain(n, valley);
  const outlet = (n - 2) * n + 20; // on the valley floor, one row above the south edge
  const { mask, cells } = upstreamArea(base, outlet);
  assert.ok(cells > n * n * .4, `catchment ${cells} cells`);
  // Any cell in the catchment must actually flow through the outlet.
  for (let i = 0; i < n * n; i++) {
    if (!mask[i]) continue;
    let c = i;
    while (c !== outlet && c >= 0) c = base.receivers[c];
    assert.equal(c, outlet);
  }
});
