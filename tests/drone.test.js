import test from 'node:test';
import assert from 'node:assert/strict';
import { DRONE, FPV, stepAltitude, stepLanding, stepBattery, canReadNote, feedCheat, fpvTopSpeed, fpvVelocity, fpvGround, terrainAhead } from '../src/drone.js';

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
  assert.equal(feedCheat('fp', 'v').mode, 'fpv');
  assert.equal(feedCheat('כפ', 'ה').mode, 'fpv');
  assert.equal(feedCheat('dron', 'e').mode, 'drone');
  assert.equal(type('dron').matched, false);
  assert.equal(feedCheat('dron', 'ArrowUp').matched, false);
});

test('FPV: full throttle settles at the top speed, boost goes faster', () => {
  const top = fpvTopSpeed(4000);
  assert.equal(top, 140);
  let vel = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < 600; i++) vel = fpvVelocity({ vel, heading: 90, tilt: 0, throttle: 1, dt: 1 / 60, topSpeed: top });
  const speed = Math.hypot(vel.x, vel.y, vel.z);
  assert.ok(Math.abs(speed - top) < 2, `cruise ${speed}`);
  assert.ok(vel.x > 0 && Math.abs(vel.z) < 1e-6, 'heading 90° flies east');
  for (let i = 0; i < 600; i++) vel = fpvVelocity({ vel, heading: 90, tilt: 0, throttle: 1, boost: true, dt: 1 / 60, topSpeed: top });
  assert.ok(Math.hypot(vel.x, vel.y, vel.z) > top * 1.7);
  assert.ok(fpvTopSpeed(1000) === FPV.minSpeed && fpvTopSpeed(100000) === FPV.maxSpeed);
});

test('FPV: pointing the nose down dives, letting go coasts to a stop', () => {
  let vel = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < 120; i++) vel = fpvVelocity({ vel, heading: 0, tilt: -45, throttle: 1, dt: 1 / 60, topSpeed: 100 });
  assert.ok(vel.y < -20 && vel.z < -20, 'down and north');
  for (let i = 0; i < 600; i++) vel = fpvVelocity({ vel, heading: 0, tilt: -45, throttle: 0, dt: 1 / 60, topSpeed: 100 });
  assert.ok(Math.hypot(vel.x, vel.y, vel.z) < 1);
});

test('FPV: skimming the ground lifts the drone, a hard hit is a crash', () => {
  const skim = fpvGround({ altitude: 101, vel: { x: 50, y: -2, z: 0 }, ground: 100, dt: .1 });
  assert.equal(skim.crashed, false);
  assert.equal(skim.altitude, 100 + FPV.minClearance);
  assert.ok(skim.vel.y >= 0 && skim.vel.x < 50 && skim.vel.x > 40);
  const crash = fpvGround({ altitude: 80, vel: { x: 120, y: -60, z: 0 }, ground: 100, dt: .1 });
  assert.equal(crash.crashed, true);
  assert.ok(crash.altitude > 100 && crash.vel.x < 50 && crash.vel.y > 0);
  const air = fpvGround({ altitude: 200, vel: { x: 1, y: 1, z: 1 }, ground: 100, dt: .1 });
  assert.equal(air.crashed, false);
  assert.equal(air.altitude, 200);
});

test('terrain warning looks ahead along the flight path', () => {
  const flat = () => 0;
  // Skimming level over flat ground is allowed: no warning.
  assert.equal(terrainAhead({ altitude: FPV.minClearance, vel: { x: 100, y: 0, z: 0 }, groundAt: flat }), Infinity);
  // A steep dive: 53 m up at −50 m/s reaches the ground in about a second.
  assert.ok(Math.abs(terrainAhead({ altitude: 53, vel: { x: 0, y: -50, z: 0 }, groundAt: flat }) - 1.2) < 1e-9);
  // Level flight towards a hillside (30% slope) at 100 m/s.
  const hill = (dx) => dx * .3;
  assert.ok(Math.abs(terrainAhead({ altitude: 20, vel: { x: 100, y: 0, z: 0 }, groundAt: hill }) - .8) < 1e-9);
  // Climbing as steeply as the hill rises: clear.
  assert.equal(terrainAhead({ altitude: 20, vel: { x: 100, y: 30, z: 0 }, groundAt: hill }), Infinity);
});
