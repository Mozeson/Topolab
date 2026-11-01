import test from 'node:test';
import assert from 'node:assert/strict';
import {
  coursePoints, legs, courseLength, isRunnable, generateCourse, sanitizeCourse, courseProblems,
  slopeSpeedFactor, naismithMinutes, totalScore, reachRadiusMeters, courseKey,
} from '../src/course.js';
import { generateTerrain } from '../src/terrain-generator.js';

const course = { start: { u: .1, v: .1 }, controls: [{ u: .1, v: .6 }, { u: .6, v: .6 }], finish: null };

test('a course without a finish loops back to the start', () => {
  const points = coursePoints(course);
  assert.deepEqual(points.map((p) => p.kind), ['start', 'control', 'control', 'finish']);
  assert.equal(points[3].implicit, true);
  assert.equal(points[3].u, .1);
  assert.equal(legs(course).length, 3);
  // 500 + 500 + ~707 m on a 1 km map
  assert.ok(Math.abs(courseLength(course, 1000) - (1000 + Math.hypot(500, 500))) < 1e-6);
});

test('runnable needs a start and at least one control', () => {
  assert.equal(isRunnable({ start: null, controls: [{ u: 0, v: 0 }] }), false);
  assert.equal(isRunnable({ start: { u: 0, v: 0 }, controls: [] }), false);
  assert.equal(isRunnable(course), true);
});

test('sanitize drops broken points and clamps to the map', () => {
  const clean = sanitizeCourse({ start: { u: 2, v: -1 }, controls: [{ u: .5, v: .5 }, { u: 'x' }, null], finish: 7 });
  assert.deepEqual(clean, { start: { u: 1, v: 0 }, controls: [{ u: .5, v: .5 }], finish: null });
});

test('generated courses are seeded, sized and spaced', () => {
  const n = 96;
  const heights = generateTerrain(n, { seed: 5 });
  const a = generateCourse({ heights, n, extentMeters: 4000, count: 6, seed: 11 });
  const b = generateCourse({ heights, n, extentMeters: 4000, count: 6, seed: 11 });
  assert.deepEqual(a, b);
  assert.equal(a.controls.length, 6);
  const all = [a.start, ...a.controls];
  for (const p of all) assert.ok(p.u >= .08 && p.u <= .92 && p.v >= .08 && p.v <= .92);
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    assert.ok(Math.hypot(all[i].u - all[j].u, all[i].v - all[j].v) >= .07 - 1e-9);
  }
  assert.notDeepEqual(a, generateCourse({ heights, n, extentMeters: 4000, count: 6, seed: 12 }));
});

test('slope slows climbing, helps gentle descents, and stays bounded', () => {
  assert.equal(slopeSpeedFactor(0), 1);
  assert.ok(slopeSpeedFactor(.2) < .55);
  assert.ok(slopeSpeedFactor(-.2) > 1);
  assert.ok(slopeSpeedFactor(-1) < 1);
  for (const g of [-5, -1, -.4, 0, .4, 5]) assert.ok(slopeSpeedFactor(g) >= .2 && slopeSpeedFactor(g) <= 1.1);
});

test('scoring helpers', () => {
  assert.equal(naismithMinutes(5000, 600), 120);
  assert.equal(totalScore({ elapsed: 100, peeks: 3, penaltyPerPeek: 10 }), 130);
  assert.equal(reachRadiusMeters(1000), 15);
  assert.equal(reachRadiusMeters(4000), 48);
  assert.notEqual(courseKey(course, 4), courseKey(course, 6));
});

test('generated courses have no crossing or brushing legs', () => {
  const n = 96;
  for (const terrainSeed of [3, 8]) {
    const heights = generateTerrain(n, { seed: terrainSeed });
    for (let seed = 1; seed <= 60; seed++) {
      const count = 3 + (seed % 8);
      const generated = generateCourse({ heights, n, extentMeters: 4000, count, seed });
      assert.equal(generated.controls.length, count);
      assert.equal(courseProblems(generated), 0, `terrain ${terrainSeed} seed ${seed}`);
    }
  }
});
