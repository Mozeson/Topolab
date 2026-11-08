import test from 'node:test';
import assert from 'node:assert/strict';
import { GHOST, convexHull, sectorBoundary, insidePolygon, signedDistance, spawnGhosts, stepGhost, pushInside, marginMeters } from '../src/ghosts.js';

const course = [{ u: .3, v: .3 }, { u: .7, v: .35 }, { u: .6, v: .7 }, { u: .35, v: .65 }, { u: .5, v: .5 }];

test('convex hull drops inner points', () => {
  const hull = convexHull(course);
  assert.equal(hull.length, 4);
  assert.ok(!hull.some((p) => p.u === .5 && p.v === .5));
});

test('the sector surrounds the course with the margin and stays on the map', () => {
  const extent = 4000;
  const poly = sectorBoundary(course, extent);
  assert.ok(poly.length > 8);
  for (const p of course) {
    assert.ok(insidePolygon(p, poly));
    assert.ok(signedDistance(p, poly, extent) > marginMeters(extent) * .97, `${signedDistance(p, poly, extent)}`);
  }
  assert.ok(poly.every((p) => p.u >= .02 && p.u <= .98 && p.v >= .02 && p.v <= .98));
  assert.ok(signedDistance({ u: .01, v: .01 }, poly, extent) < 0);
  assert.equal(marginMeters(1000), GHOST.minMargin);
  assert.equal(marginMeters(8000), GHOST.maxMargin);
});

test('ghosts come out beyond the line, chase, and catch a walker but not a runner', () => {
  const extent = 4000;
  const poly = sectorBoundary(course, extent);
  let seed = 7;
  const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // A walker standing just inside the western line.
  const edge = poly.reduce((a, b) => (b.u < a.u ? b : a));
  const player = { u: edge.u + 20 / extent, v: edge.v };
  const ghosts = spawnGhosts({ player, poly, extent, rng });
  assert.equal(ghosts.length, GHOST.count);
  assert.ok(ghosts.every((g) => signedDistance(g, poly, extent) < 0), 'all start outside');
  let caught = false;
  for (let t = 0; t < 30 && !caught; t += .1) for (const g of ghosts) if (stepGhost(g, { dt: .1, player, extent, walkSpeed: 1.4, time: t }) === 'caught') caught = true;
  assert.ok(caught, 'a standing walker is caught');
  // A runner moving away at 2.4× faster than they chase is not caught.
  const runner = { ...player };
  const pack = spawnGhosts({ player: runner, poly, extent, rng });
  let got = false;
  for (let t = 0; t < 20; t += .1) {
    runner.u += 1.4 * 2.4 * 2 * .1 / extent; // running east, into the sector
    for (const g of pack) if (stepGhost(g, { dt: .1, player: runner, extent, walkSpeed: 1.4 * 2, time: t }) === 'caught') got = true;
  }
  assert.equal(got, false);
  const back = pushInside({ u: edge.u - 10 / extent, v: edge.v }, poly, extent);
  assert.ok(Math.abs(signedDistance(back, poly, extent) - GHOST.pushBack) < 5);
});
