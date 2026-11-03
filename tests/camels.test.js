import test from 'node:test';
import assert from 'node:assert/strict';
import { CAMEL, valleyScore, sampleGrid, spawnCamels, stepCamel, separateCamels, metersBetween, detectRadius, catchRadius } from '../src/camels.js';
import { random } from '../src/course.js';

// A V-shaped valley running north–south down the middle of the map.
const n = 41;
const heights = new Float32Array(n * n);
for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) heights[y * n + x] = Math.abs(x - (n - 1) / 2) * 10;
const extent = 4000;
const walkSpeed = extent / 150;

function ctxFor(player, rng, dt = .1) {
  return { dt, extent, walkSpeed, rng, player, heightAt: (u, v) => sampleGrid(heights, n, u, v) };
}

function camelAt(u, v, extra = {}) {
  return { u, v, heading: 0, state: 'graze', timer: 0, wanderTimer: 99, target: null, aggression: 1, gait: 0, speed: 0, chasedFor: 0, ...extra };
}

test('valley score is positive in the valley and negative on the ridges', () => {
  const score = valleyScore(heights, n, 4);
  const mid = 20;
  assert.ok(score[mid * n + 20] > 20, 'valley floor');
  assert.ok(score[mid * n + 0] < -10, 'west ridge');
  assert.ok(score[mid * n + 40] < -10, 'east ridge');
  assert.ok(Math.abs(sampleGrid(score, n, .5, .5) - score[mid * n + 20]) < 1e-3);
});

test('herds spawn mostly in valleys and away from the start', () => {
  const score = valleyScore(heights, n, 4);
  const start = { u: .5, v: .08 };
  const camels = spawnCamels({ score, n, count: 12, rng: random(7), extent, avoid: [start] });
  assert.equal(camels.length, 12);
  const inValley = camels.filter((c) => sampleGrid(score, n, c.u, c.v) > 0).length;
  assert.ok(inValley >= 9, `only ${inValley} of 12 in the valley`);
  for (const camel of camels) assert.ok(metersBetween(camel, start, extent) >= 250);
  assert.deepEqual(spawnCamels({ score, n, count: 0, rng: random(1), extent }), []);
});

test('given the course, herds gather along it but clear of the controls', () => {
  const score = valleyScore(heights, n, 4);
  const route = [{ u: .5, v: .08 }, { u: .5, v: .5 }, { u: .5, v: .92 }]; // down the valley
  const camels = spawnCamels({ score, n, count: 8, rng: random(4), extent, avoid: [route[0]], route, clearOf: route.slice(1) });
  assert.equal(camels.length, 8);
  for (const camel of camels) {
    assert.ok(Math.abs(camel.u - .5) * extent < 400, 'near the route');
    for (const control of route.slice(1)) assert.ok(metersBetween(camel, control, extent) >= 100 - 1e-6, 'not at a control');
  }
  // A course along the west slope pulls herds towards it, compared with no course at all.
  const west = [{ u: .15, v: .1 }, { u: .15, v: .9 }];
  const mean = (list) => list.reduce((sum, c) => sum + Math.abs(c.u - .15), 0) / list.length;
  const near = spawnCamels({ score, n, count: 12, rng: random(8), extent, route: west });
  const anywhere = spawnCamels({ score, n, count: 12, rng: random(8), extent });
  assert.ok(mean(near) < mean(anywhere), `${mean(near)} vs ${mean(anywhere)}`);
});

test('a grazing camel ignores a walker far away', () => {
  const rng = random(3);
  const camel = camelAt(.5, .5, { wanderTimer: 0 });
  const player = { u: .9, v: .9, onFoot: true };
  const events = [];
  for (let i = 0; i < 300; i++) { const e = stepCamel(camel, ctxFor(player, rng)); if (e) events.push(e); }
  assert.deepEqual(events, []);
  assert.ok(metersBetween(camel, { u: .5, v: .5 }, extent) < 300, 'strolls, but stays around');
});

test('a nearby walker is noticed, stared at, then chased and caught', () => {
  const rng = random(11);
  const camel = camelAt(.5, .5);
  const player = { u: .5, v: .5 + 50 / extent, onFoot: true }; // 50 m south, standing still
  const events = [];
  for (let i = 0; i < 200 && !events.includes('caught'); i++) { const e = stepCamel(camel, ctxFor(player, rng)); if (e) events.push(e); }
  assert.deepEqual(events, ['alert', 'chase', 'caught']);
  assert.equal(camel.state, 'rest');
  assert.ok(metersBetween(camel, player, extent) <= catchRadius(extent));
  // Satisfied: it leaves the walker alone for a while.
  for (let i = 0; i < 200; i++) assert.equal(stepCamel(camel, ctxFor(player, rng)), null);
});

test('walking away does not shake off a camel; running does', () => {
  const chase = (speedFactor) => {
    const rng = random(5);
    const camel = camelAt(.5, .5, { state: 'chase', timer: 60 });
    const player = { u: .5, v: .5 + 30 / extent, onFoot: true };
    for (let i = 0; i < 600; i++) {
      player.v += walkSpeed * speedFactor * .1 / extent; // straight south along the flat valley floor
      const event = stepCamel(camel, ctxFor(player, rng));
      if (event) return event;
    }
    return null;
  };
  assert.equal(chase(1), 'caught');
  assert.equal(chase(1.8), 'escaped');
});

test('a camel ignores the drone and drops the chase when you take off', () => {
  const rng = random(9);
  const camel = camelAt(.5, .5);
  const flying = { u: .5, v: .5 + 20 / extent, onFoot: false };
  for (let i = 0; i < 100; i++) assert.equal(stepCamel(camel, ctxFor(flying, rng)), null);
  const chaser = camelAt(.5, .5, { state: 'chase', timer: 30 });
  assert.equal(stepCamel(chaser, ctxFor({ ...flying, v: .5 + 200 / extent }, rng)), 'gaveUp');
});

test('darkness shrinks the detection radius, a headlamp grows it', () => {
  const rng = random(2);
  const distance = detectRadius(extent) * .8;
  const noticed = (visibility) => {
    const camel = camelAt(.5, .5);
    const player = { u: .5, v: .5 + distance / extent, onFoot: true, visibility };
    for (let i = 0; i < 100; i++) if (stepCamel(camel, ctxFor(player, rng)) === 'alert') return true;
    return false;
  };
  assert.equal(noticed(1), true);
  assert.equal(noticed(.5), false);
  assert.equal(noticed(1.5), true);
});

test('camels are pushed apart instead of piling up', () => {
  const a = camelAt(.5, .5);
  const b = camelAt(.5 + 1 / extent, .5);
  separateCamels([a, b], 4, extent);
  assert.ok(Math.abs(metersBetween(a, b, extent) - 4) < 1e-6);
  assert.ok(CAMEL.counts.many > CAMEL.counts.few);
});
