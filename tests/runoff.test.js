import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunoff } from '../src/runoff.js';

test('on a dome, drops run away from the summit in every direction', () => {
  const n = 61;
  const c = 30;
  const dome = Float64Array.from({ length: n * n }, (_, i) => 100 - .05 * ((i % n - c) ** 2 + (Math.floor(i / n) - c) ** 2));
  const runoff = createRunoff({ size: n, surface: dome, cellMeters: 40, count: 800, seed: 3 });
  const quadrants = new Set();
  let outward = 0;
  let checked = 0;
  for (let k = 0; k < 20; k++) {
    runoff.step(.05);
    for (const p of runoff.particles) {
      if (!p.alive || p.fresh) continue;
      const before = Math.hypot(p.px - c, p.py - c);
      const after = Math.hypot(p.x - c, p.y - c);
      if (before < 2) continue;
      checked++;
      if (after > before) outward++;
      quadrants.add(`${Math.sign(p.vx)}${Math.sign(p.vy)}`);
    }
  }
  assert.ok(outward / checked > .99, `${outward}/${checked} moved outward`);
  for (const q of ['11', '1-1', '-11', '-1-1']) assert.ok(quadrants.has(q), `missing direction ${q}`);
});

test('drops converge into a valley and never climb', () => {
  const n = 41;
  const valley = Float64Array.from({ length: n * n }, (_, i) => Math.abs(i % n - 20) * 2 + (n - 1 - Math.floor(i / n)));
  const runoff = createRunoff({ size: n, surface: valley, count: 300, seed: 5 });
  const height = (x, y) => Math.abs(x - 20) * 2 + (n - 1 - y);
  let climbs = 0;
  for (let k = 0; k < 40; k++) {
    runoff.step(.05);
    for (const p of runoff.particles) if (p.alive && !p.fresh && height(p.x, p.y) > height(p.px, p.py) + 1e-6) climbs++;
  }
  assert.equal(climbs, 0);
  const near = runoff.particles.filter((p) => p.alive && Math.abs(p.x - 20) < 2).length;
  assert.ok(near > 0, 'some drops reach the valley floor');
});

test('drops never start in a lake and stop when they reach one', () => {
  const n = 21;
  const surface = Float64Array.from({ length: n * n }, (_, i) => Math.hypot(i % n - 10, Math.floor(i / n) - 10));
  const wet = Float32Array.from({ length: n * n }, (_, i) => (Math.hypot(i % n - 10, Math.floor(i / n) - 10) < 4 ? 2 : 0));
  const runoff = createRunoff({ size: n, surface, wet, count: 200, seed: 9 });
  for (let k = 0; k < 60; k++) {
    runoff.step(.05);
    for (const p of runoff.particles) if (p.alive) assert.ok(wet[Math.round(p.y) * n + Math.round(p.x)] <= .3);
  }
});
