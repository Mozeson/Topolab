import test from 'node:test';
import assert from 'node:assert/strict';
import { similarityFromPairs, imageToItm, itmToImage, checkPairs, drapeTransform, coverage, squareOrigin } from '../src/map-import.js';

// A north-up scan, 2 m per pixel, whose top-left pixel is at 230000/740000.
const scan = (x, y) => ({ x, y, e: 230000 + 2 * x, n: 740000 - 2 * y });

test('two points give the scan its scale and place', () => {
  const t = similarityFromPairs(scan(100, 200), scan(3100, 2600));
  assert.ok(Math.abs(t.metersPerPixel - 2) < 1e-9);
  assert.ok(Math.abs(t.rotation) < 1e-9);
  const p = imageToItm(t, 1500, 900);
  assert.ok(Math.abs(p.e - 233000) < 1e-6 && Math.abs(p.n - 738200) < 1e-6);
  const back = itmToImage(t, 233000, 738200);
  assert.ok(Math.abs(back.x - 1500) < 1e-6 && Math.abs(back.y - 900) < 1e-6);
});

test('a scan turned by a few degrees is still placed exactly', () => {
  const turn = 4 * Math.PI / 180;
  // Image axes turned: ITM from pixels with rotation, scale 1.5 m/px.
  const at = (x, y) => {
    const ex = 1.5 * (x * Math.cos(turn) + y * Math.sin(turn));
    const ny = 1.5 * (x * Math.sin(turn) - y * Math.cos(turn));
    return { x, y, e: 200000 + ex, n: 650000 + ny };
  };
  const t = similarityFromPairs(at(50, 80), at(2000, 1500));
  assert.ok(Math.abs(t.rotation - 4) < 1e-6, String(t.rotation));
  const q = at(1234, 567);
  const p = imageToItm(t, q.x, q.y);
  assert.ok(Math.hypot(p.e - q.e, p.n - q.n) < 1e-6);
});

test('bad point pairs are explained', () => {
  assert.equal(checkPairs(scan(100, 100), scan(3000, 2000)).length, 0);
  assert.match(checkPairs(scan(100, 100), scan(120, 110))[0], /קרובות מדי/);
  // East and north swapped on the second point: a crazy scale or rotation.
  const swapped = { ...scan(3000, 2000) };
  [swapped.e, swapped.n] = [swapped.n, swapped.e];
  assert.ok(checkPairs(scan(100, 100), swapped).length > 0);
});

test('the drape transform maps grid corners to the canvas corners', () => {
  const t = similarityFromPairs(scan(0, 0), scan(4000, 3000));
  const origin = { e: 231000, n: 733000 };
  const extent = 4000;
  const size = 1000;
  const [a, b, c, d, e, f] = drapeTransform(t, origin, extent, size);
  const toCanvas = (x, y) => ({ x: a * x + c * y + e, y: b * x + d * y + f });
  // The pixel at the square's NW corner (231000/737000) and SE corner (235000/733000).
  const nw = itmToImage(t, 231000, 737000);
  const se = itmToImage(t, 235000, 733000);
  const p = toCanvas(nw.x, nw.y);
  const q = toCanvas(se.x, se.y);
  assert.ok(Math.abs(p.x) < 1e-6 && Math.abs(p.y) < 1e-6, JSON.stringify(p));
  assert.ok(Math.abs(q.x - size) < 1e-6 && Math.abs(q.y - size) < 1e-6, JSON.stringify(q));
  assert.equal(coverage(t, origin, extent, 4000, 3000), .75); // the scan starts at N 734000
  assert.equal(coverage(t, { e: 231000, n: 735000 }, extent, 4000, 3000), 1);
  assert.ok(coverage(t, { e: 236000, n: 733000 }, extent, 4000, 3000) < .5);
  assert.deepEqual(squareOrigin(236900, 732500, 4000), { e: 235000, n: 731000 });
});
