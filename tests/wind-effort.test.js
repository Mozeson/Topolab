import test from 'node:test';
import assert from 'node:assert/strict';
import { WIND, createWind, windAt, windSpeedFactor, describeWind } from '../src/wind.js';
import { effortLoad, stepFatigue, breathing, runFactor, EFFORT } from '../src/effort.js';
import { random } from '../src/course.js';

test('wind: strength stays in range, gusts come and go, direction drifts only a little', () => {
  const wind = createWind(random(3));
  let min = 1, max = 0;
  for (let t = 0; t < 600; t += .5) {
    const w = windAt(wind, t);
    assert.ok(w.strength >= 0 && w.strength <= 1);
    assert.ok(Math.abs(Math.hypot(w.toward.x, w.toward.z) - 1) < 1e-9);
    const drift = Math.abs(((w.from - wind.from + 540) % 360) - 180);
    assert.ok(drift <= 15.001);
    min = Math.min(min, w.strength); max = Math.max(max, w.strength);
  }
  assert.ok(max - min > wind.base * .5, 'gusts vary the strength');
});

test('wind blows away from where it comes from, and slows you walking into it', () => {
  const westerly = { from: 270, toward: { x: 1, z: 0 }, strength: 1, gust: 0 };
  const w = windAt({ from: 270, base: .5, seed: 0 }, 0);
  assert.ok(w.toward.x > .9, 'a west wind blows east');
  assert.ok(Math.abs(windSpeedFactor(westerly, 270) - (1 - WIND.headwind)) < 1e-9);
  assert.ok(Math.abs(windSpeedFactor(westerly, 90) - (1 + WIND.tailwind)) < 1e-9);
  assert.ok(Math.abs(windSpeedFactor(westerly, 0) - 1) < 1e-9);
  assert.equal(describeWind({ from: 268, strength: .7, gust: .2 }), 'רוח מערבית חזקה');
  assert.equal(describeWind({ from: 2, strength: .1, gust: 0 }), 'רוח צפונית חלשה');
});

test('fatigue builds running uphill and eases at rest; breathing follows it', () => {
  let fatigue = 0;
  const climb = effortLoad({ moving: true, running: true, grade: .2 });
  assert.equal(climb, 1);
  for (let i = 0; i < 100; i++) fatigue = stepFatigue(fatigue, climb, .1);
  assert.ok(fatigue > .9);
  assert.ok(breathing(fatigue).volume > .9 && breathing(fatigue).interval < 1.5);
  assert.ok(Math.abs(runFactor(1) - EFFORT.tiredRun) < 1e-9);
  for (let i = 0; i < 300; i++) fatigue = stepFatigue(fatigue, effortLoad({ moving: false }), .1);
  assert.ok(fatigue < .05);
  assert.equal(breathing(fatigue).volume, 0);
  assert.equal(runFactor(.3), 1);
  assert.ok(effortLoad({ moving: true, running: false, grade: 0 }) < .3, 'easy walking on the flat');
});
