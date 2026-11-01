import test from 'node:test';
import assert from 'node:assert/strict';
import { applySmudgeBrush, applyPinchBrush, applyFlattenBrush } from '../src/brush.js';

const n = 61;
const peakX = (h, row) => { let best = 0; for (let x = 1; x < n; x++) if (h[row * n + x] > h[row * n + best]) best = x; return best; };
const widthBelow = (h, row, level) => { let w = 0; for (let x = 0; x < n; x++) if (h[row * n + x] < level) w++; return w; };

function bump(cx, cy, r, height) {
  const h = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) h[y * n + x] = height * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (r * r));
  return h;
}
// A north–south valley 40 m deep centred on x = 30.
function valley() {
  const h = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) h[y * n + x] = 50 - 40 * Math.exp(-((x - 30) ** 2) / 60);
  return h;
}

test('smudge drags a hill in the direction of the stroke', () => {
  const h = bump(25, 30, 5, 80);
  for (let i = 0; i < 6; i++) applySmudgeBrush(h, n, 25 + i, 30, 12, 1, 0, 1);
  assert.ok(peakX(h, 30) > 27, `peak moved to ${peakX(h, 30)}`);
  assert.ok(Math.max(...h) <= 80 + 1e-4, 'smudge never creates height');
});

test('pinch narrows a valley, expand widens it', () => {
  const base = widthBelow(valley(), 30, 30);
  const pinched = valley();
  for (let i = 0; i < 8; i++) applyPinchBrush(pinched, n, 30, 30, 20, .08);
  const expanded = valley();
  for (let i = 0; i < 8; i++) applyPinchBrush(expanded, n, 30, 30, 20, -.08);
  assert.ok(widthBelow(pinched, 30, 30) < base, 'pinched valley is narrower');
  assert.ok(widthBelow(expanded, 30, 30) > base, 'expanded valley is wider');
});

test('expand spreads a dome: lower peak, wider footprint', () => {
  const h = bump(30, 30, 5, 80);
  const footprint = (a) => a.filter((v) => v > 20).length;
  const before = footprint(h);
  for (let i = 0; i < 8; i++) applyPinchBrush(h, n, 30, 30, 18, -.08);
  assert.ok(footprint(h) > before);
});

test('flatten pulls towards the target height and leaves the outside alone', () => {
  const h = bump(30, 30, 6, 80);
  const far = h[0];
  for (let i = 0; i < 30; i++) applyFlattenBrush(h, n, 30, 30, 10, 20, .3);
  assert.ok(Math.abs(h[30 * n + 30] - 20) < 1);
  assert.equal(h[0], far);
});
