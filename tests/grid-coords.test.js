import test from 'node:test';
import assert from 'node:assert/strict';
import { readCoordinate, formatCoordinate, gridSquare, sanitizeOrigin, pointToGrid } from '../src/grid-coords.js';

test('corners of a 4 km map with the default origin', () => {
  assert.deepEqual(readCoordinate(0, 1, 4000), { e: 200000, n: 600000 }); // south-west
  assert.deepEqual(readCoordinate(1, 0, 4000), { e: 204000, n: 604000 }); // north-east
});

test('a point is read to the nearest 100 m inside its square', () => {
  // 200.2 km east, 603.2 km north on a 4 km map
  const u = 230 / 4000;
  const v = 1 - 3180 / 4000;
  assert.equal(formatCoordinate(readCoordinate(u, v, 4000)), '603200/200200');
  const square = gridSquare(u, v, 4000, 1000);
  assert.equal(square.e0, 200000);
  assert.equal(square.n0, 603000);
  assert.ok(Math.abs(square.de - 230) < 1e-6 && Math.abs(square.dn - 180) < 1e-6);
});

test('a custom origin shifts every coordinate', () => {
  const origin = { e: 160000, n: 604000 };
  assert.deepEqual(readCoordinate(.5, .5, 1000, origin), { e: 160500, n: 604500 });
  assert.deepEqual(pointToGrid(0, 0, 8000, origin), { e: 160000, n: 612000 });
});

test('bad origins fall back to the default', () => {
  assert.deepEqual(sanitizeOrigin({ e: 'x', n: -5 }), { e: 200000, n: 600000 });
  assert.deepEqual(sanitizeOrigin({ e: 123456.7, n: 654321 }), { e: 123457, n: 654321 });
});
