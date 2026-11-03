import test from 'node:test';
import assert from 'node:assert/strict';
import { pickCaveSpot } from '../src/cave.js';
import { valleyScore, sampleGrid } from '../src/camels.js';
import { random } from '../src/course.js';

test('the cave is always in a gully, away from the start and controls', () => {
  const n = 41;
  const heights = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) heights[y * n + x] = Math.abs(x - 20) * 10 + Math.abs(y - 20) * 2;
  const score = valleyScore(heights, n, 4);
  const avoid = [{ u: .5, v: .5 }];
  for (let seed = 1; seed <= 20; seed++) {
    const spot = pickCaveSpot({ score, n, rng: random(seed), extent: 4000, avoid });
    assert.ok(spot);
    assert.ok(Math.abs(spot.u - .5) < .08, `in the valley: u=${spot.u}`);
    assert.ok(sampleGrid(score, n, spot.u, spot.v) > 0);
    assert.ok(Math.hypot(spot.u - .5, spot.v - .5) * 4000 >= 270, "clear of the start (less the small jitter)");
  }
  assert.equal(pickCaveSpot({ score: new Float32Array(n * n), n, rng: random(1), extent: 4000, avoid: [{ u: .5, v: .5 }], clearMeters: 1e6 }), null);
});
