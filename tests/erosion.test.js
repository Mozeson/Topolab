import test from 'node:test';
import assert from 'node:assert/strict';
import { drainLandscape, erodeStreamPower, breachDepressions } from '../src/erosion.js';
import { computeHydrology } from '../src/hydrology.js';
import { generateTerrain } from '../src/terrain-generator.js';

test('drainage opens the landscape: far fewer lakes, same height range, deterministic', () => {
  const n = 96;
  for (const seed of [4242, 7, 99]) {
    const raw = generateTerrain(n, { seed });
    const drained = drainLandscape(Float32Array.from(raw), n, 60);
    const lakesBefore = computeHydrology(n, raw).lakes.length;
    const lakesAfter = computeHydrology(n, drained).lakes.length;
    assert.ok(lakesAfter <= Math.max(3, lakesBefore / 4), `seed ${seed}: ${lakesBefore} → ${lakesAfter} lakes`);
    const range = (h) => [Math.min(...h), Math.max(...h)];
    const [a, b] = range(raw);
    const [c, d] = range(drained);
    assert.ok(Math.abs(a - c) < 1e-3 && Math.abs(b - d) < 1e-3);
    assert.deepEqual(drained, drainLandscape(Float32Array.from(raw), n, 60));
  }
});

test('amount 0 leaves the terrain untouched', () => {
  const raw = generateTerrain(48, { seed: 3 });
  assert.deepEqual(drainLandscape(Float32Array.from(raw), 48, 0), raw);
});

test('erosion only lowers ground (no roughness), never moves the map edge, and carves gullies into a smooth hill', () => {
  const n = 64;
  const hill = Float32Array.from({ length: n * n }, (_, i) => {
    const x = (i % n) / (n - 1) - .5;
    const y = Math.floor(i / n) / (n - 1) - .5;
    return 80 * Math.exp(-(x * x + y * y) * 12);
  });
  const plain = erodeStreamPower(Float32Array.from(hill), n, { passes: 6, strength: 2, m: .6, diffusion: 0 });
  for (let i = 0; i < hill.length; i++) {
    const x = i % n;
    const y = Math.floor(i / n);
    if (x === 0 || y === 0 || x === n - 1 || y === n - 1) assert.equal(plain[i], hill[i]);
    else assert.ok(plain[i] <= hill[i] + 1e-6);
  }
  const rough = erodeStreamPower(Float32Array.from(hill), n, { passes: 12, strength: 2.6, m: .6, roughness: 2.5 });
  assert.ok(computeHydrology(n, rough).streams.length > computeHydrology(n, hill).streams.length);
});

test('breaching cuts small pits open and keeps big deep ones', () => {
  const n = 41;
  const h = Float32Array.from({ length: n * n }, (_, i) => (i % n) * 1.5); // slope down to the west
  h[10 * n + 30] -= 3; // small shallow pit
  for (let y = 18; y < 30; y++) for (let x = 10; x < 22; x++) h[y * n + x] -= 25; // big deep basin
  breachDepressions(h, n, { keepDepth: 8, keepCells: 40 });
  const lakes = computeHydrology(n, h).lakes;
  assert.equal(lakes.length, 1);
  assert.ok(lakes[0].cells.length >= 100);
});
