import test from 'node:test';
import assert from 'node:assert/strict';
import { pointInPolygon, polygonArea, rasterizeAreas, buildSpeedGrid, AREA_ORDER, AREA_TYPES } from '../src/areas.js';

const square = (u0, v0, u1, v1) => [{ u: u0, v: v0 }, { u: u1, v: v0 }, { u: u1, v: v1 }, { u: u0, v: v1 }];

test('point in polygon, including a concave shape', () => {
  const l = [{ u: 0, v: 0 }, { u: 1, v: 0 }, { u: 1, v: .4 }, { u: .4, v: .4 }, { u: .4, v: 1 }, { u: 0, v: 1 }];
  assert.ok(pointInPolygon(.2, .8, l));
  assert.ok(!pointInPolygon(.8, .8, l));
  assert.ok(Math.abs(polygonArea(square(0, 0, .5, .5)) - .25) < 1e-12);
});

test('areas rasterise onto the grid; a later area cuts a clearing', () => {
  const n = 21;
  const grid = rasterizeAreas(n, [
    { type: 'naturalForest', points: square(.1, .1, .9, .9) },
    { type: 'field', points: square(.4, .4, .6, .6) },
    { type: 'road', points: [{ u: 0, v: 0 }, { u: 1, v: 1 }] }, // lines are ignored
  ]);
  assert.equal(AREA_ORDER[grid[4 * n + 4]], 'naturalForest');
  assert.equal(AREA_ORDER[grid[10 * n + 10]], 'field');
  assert.equal(grid[0], -1);
});

test('speed grid: forests slow, roads through them are fast, open ground is 1', () => {
  const n = 41;
  const features = [
    { type: 'naturalForest', points: square(.2, .2, .8, .8) },
    { type: 'road', points: [{ u: .5, v: 0 }, { u: .5, v: 1 }] },
  ];
  const speed = buildSpeedGrid(n, features, 4000);
  assert.ok(Math.abs(speed[12 * n + 30] - AREA_TYPES.naturalForest.speed) < 1e-6); // forest, away from the road
  assert.equal(speed[20 * n + 20], 1.25); // road through the forest
  assert.equal(speed[2 * n + 2], 1); // open ground
});
