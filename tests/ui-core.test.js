import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistory } from '../src/history.js';
import { applyHeightBrush, applySmoothBrush, slopePercent } from '../src/brush.js';
import { encodeHeights, decodeHeights, serializeProject, parseProject } from '../src/persistence.js';
import { matchShortcut, SHORTCUTS } from '../src/shortcuts.js';

const snap = (value, mapSize = 4) => ({ heights: new Float32Array([value, value]), mapSize });

test('history: undo and redo walk back and forth', () => {
  const history = createHistory();
  history.push(snap(0));                       // before edit 1
  history.push(snap(1));                       // before edit 2
  const current = snap(2);
  const back = history.undo(current);
  assert.equal(back.heights[0], 1);
  assert.ok(history.canRedo);
  const forward = history.redo(back);
  assert.equal(forward.heights[0], 2);
  assert.equal(history.redo(forward), null);
});

test('history: a new edit clears redo, and the limit is respected', () => {
  const history = createHistory({ limit: 3 });
  for (let i = 0; i < 5; i++) history.push(snap(i));
  assert.equal(history.size.undo, 3);
  history.undo(snap(9));
  assert.ok(history.canRedo);
  history.push(snap(7));
  assert.equal(history.canRedo, false);
});

test('history: snapshots are copies, not live references', () => {
  const history = createHistory();
  const live = snap(5);
  history.push(live);
  live.heights[0] = 99;
  assert.equal(history.undo(live).heights[0], 5);
});

test('brush: raise peaks at the centre and respects bounds', () => {
  const n = 21;
  const heights = new Float32Array(n * n);
  applyHeightBrush(heights, n, 10, 10, 5, 50, -100, 200);
  assert.equal(heights[10 * n + 10], 50);
  assert.ok(heights[10 * n + 12] > 0 && heights[10 * n + 12] < 50);
  assert.equal(heights[0], 0);
  applyHeightBrush(heights, n, 10, 10, 5, 1000, -100, 200);
  assert.equal(heights[10 * n + 10], 200);
});

test('brush: smoothing reduces a spike without changing far cells', () => {
  const n = 21;
  const heights = new Float32Array(n * n);
  heights[10 * n + 10] = 90;
  applySmoothBrush(heights, n, 10, 10, 4, 1);
  assert.ok(heights[10 * n + 10] < 90);
  assert.ok(heights[10 * n + 11] > 0);
  assert.equal(heights[0], 0);
});

test('brush: slope of a 10 m rise per 100 m is 10%', () => {
  const n = 5;
  const heights = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) heights[y * n + x] = x * 10;
  assert.ok(Math.abs(slopePercent(heights, n, 2, 2, 100) - 10) < 1e-9);
});

test('persistence: heights round-trip at centimetre precision', () => {
  const heights = new Float32Array([0, 12.345, -99.99, 200, 57.5]);
  const back = decodeHeights(encodeHeights(heights), heights.length);
  for (let i = 0; i < heights.length; i++) assert.ok(Math.abs(back[i] - heights[i]) <= .0051);
  assert.throws(() => decodeHeights(encodeHeights(heights), 4));
});

test('persistence: a whole project round-trips', () => {
  const heights = new Float32Array(96 * 96).map((_, i) => (i % 300) - 100);
  const text = serializeProject({ heights, mapSize: 4, settings: { brush: 20 }, features: [{ type: 'trail', points: [{ u: 0, v: 0 }, { u: 1, v: 1 }] }] });
  const project = parseProject(text);
  assert.equal(project.mapSize, 4);
  assert.equal(project.settings.brush, 20);
  assert.equal(project.features[0].type, 'trail');
  assert.equal(project.heights[150], heights[150]);
});

test('shortcuts: physical keys work regardless of layout, modifiers are exact', () => {
  const key = (code, extra = {}) => ({ code, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...extra });
  assert.equal(matchShortcut(key('KeyR')), 'tool-raise');
  assert.equal(matchShortcut(key('KeyZ', { ctrlKey: true })), 'undo');
  assert.equal(matchShortcut(key('KeyZ', { metaKey: true, shiftKey: true })), 'redo');
  assert.equal(matchShortcut(key('KeyY', { ctrlKey: true })), 'redo');
  assert.equal(matchShortcut(key('BracketRight', { shiftKey: true })), 'strength-up');
  assert.equal(matchShortcut(key('KeyR', { ctrlKey: true })), null);
  assert.equal(matchShortcut(key('KeyR', { altKey: true })), null);
});

test('shortcuts: no two entries claim the same key combination', () => {
  const seen = new Set();
  for (const shortcut of SHORTCUTS) {
    for (const code of shortcut.codes) {
      const combo = `${code}|${Boolean(shortcut.mod)}|${Boolean(shortcut.shift)}`;
      assert.ok(!seen.has(combo), combo);
      seen.add(combo);
    }
  }
});

test('tall real relief is stored in decimetres and restored', () => {
  const heights = Float32Array.of(0, 475.37, 1890.04, -12.5);
  const text = serializeProject({ heights, mapSize: 4 });
  assert.equal(JSON.parse(text).heightStep, .1);
  const saved = parseProject(text);
  for (let i = 0; i < heights.length; i++) assert.ok(Math.abs(saved.heights[i] - heights[i]) <= .05);
  const small = parseProject(serializeProject({ heights: Float32Array.of(1.23, -99.99), mapSize: 4 }));
  assert.ok(Math.abs(small.heights[0] - 1.23) < 1e-6);
});
