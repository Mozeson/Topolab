import test from 'node:test';
import assert from 'node:assert/strict';
import { DRONE, stepAltitude, stepLanding, stepBattery, canReadNote, feedCheat } from '../src/drone.js';

test('the drone climbs towards its target at the climb rate', () => {
  let state = { altitude: 102, target: 160 };
  state = stepAltitude({ ...state, ground: 100, dt: 1 });
  assert.equal(state.altitude, 102 + DRONE.climbRate);
  for (let i = 0; i < 10; i++) state = stepAltitude({ ...state, ground: 100, dt: 1 });
  assert.equal(state.altitude, 160);
  assert.equal(state.agl, 60);
});

test('rising ground pushes the drone up instead of letting it crash', () => {
  // Holding 150 m while the ground rises to 200 m.
  const state = stepAltitude({ altitude: 150, target: 150, ground: 200, dt: .016 });
  assert.equal(state.altitude, 200 + DRONE.minClearance);
  assert.ok(state.target >= state.altitude);
  assert.equal(state.agl, DRONE.minClearance);
});

test('the target altitude is kept between the minimum clearance and the ceiling', () => {
  const low = stepAltitude({ altitude: 50, target: -100, ground: 40, dt: 10 });
  assert.equal(low.altitude, 40 + DRONE.minClearance);
  const high = stepAltitude({ altitude: 50, target: 1e6, ground: 40, dt: 100 });
  assert.equal(high.altitude, 40 + DRONE.maxAgl);
});

test('landing descends to the ground and reports when the pilot can step out', () => {
  let state = { altitude: 130 };
  let landed = false;
  for (let i = 0; i < 100 && !landed; i++) ({ altitude: state.altitude, landed } = stepLanding({ ...state, ground: 100, dt: .1 }));
  assert.equal(landed, true);
  assert.ok(state.altitude - 100 <= DRONE.landAgl && state.altitude >= 100);
});

test('the battery lasts the set flight time and recharges while walking', () => {
  assert.equal(stepBattery(100, DRONE.batterySeconds / 2, true), 50);
  assert.equal(stepBattery(10, 1000, true), 0);
  assert.equal(stepBattery(40, 10, false), 40 + 10 * DRONE.rechargePerSecond);
  assert.equal(stepBattery(99, 100, false), 100);
});

test('a note can only be read low over the control', () => {
  assert.equal(canReadNote({ horizontalDistance: 10, reach: 48, agl: 30 }), true);
  assert.equal(canReadNote({ horizontalDistance: 10, reach: 48, agl: 120 }), false);
  assert.equal(canReadNote({ horizontalDistance: 60, reach: 48, agl: 10 }), false);
});

test('the cheat code works in English and Hebrew and ignores other keys', () => {
  const type = (text) => [...text].reduce((acc, key) => {
    const result = feedCheat(acc.buffer, key);
    return { buffer: result.buffer, matched: acc.matched || result.matched };
  }, { buffer: '', matched: false });
  assert.equal(type('xxDRONE').matched, true);
  assert.equal(type('רחפן').matched, true);
  assert.equal(type('dron').matched, false);
  assert.equal(feedCheat('dron', 'ArrowUp').matched, false);
});
