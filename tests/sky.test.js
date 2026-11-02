import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LATITUDE, hebrewDay, formatHour, moonPhase, sunDirection, moonDirection, moonTimes, skyState,
  equatorialToWorld, skyBasis, starVector, altitude, azimuth, directionName, DAY_SKY,
} from '../src/sky.js';

const near = (actual, expected, tolerance, label = '') => assert.ok(Math.abs(actual - expected) <= tolerance, `${label} ${actual} ≉ ${expected} ±${tolerance}`);

test('Hebrew month days and clock formatting', () => {
  assert.equal(hebrewDay(1), 'א׳');
  assert.equal(hebrewDay(11), 'י״א');
  assert.equal(hebrewDay(15), 'ט״ו');
  assert.equal(hebrewDay(16), 'ט״ז');
  assert.equal(hebrewDay(20), 'כ׳');
  assert.equal(hebrewDay(30), 'ל׳');
  assert.equal(formatHour(18.5), '18:30');
  assert.equal(formatHour(25.25), '01:15');
  assert.equal(formatHour(23.999), '00:00');
});

test('the moon is new at the start of the month and full on ט״ו', () => {
  assert.ok(moonPhase(1).illumination < .01);
  assert.ok(moonPhase(15).illumination > .99);
  assert.equal(moonPhase(15).name, 'ירח מלא');
  const firstQuarter = moonPhase(8);
  assert.ok(firstQuarter.waxing && firstQuarter.illumination > .4 && firstQuarter.illumination < .6);
  assert.equal(firstQuarter.name, 'רבע ראשון');
  const lastQuarter = moonPhase(23);
  assert.ok(!lastQuarter.waxing && lastQuarter.illumination > .35 && lastQuarter.illumination < .65);
  assert.equal(moonPhase(15).emoji, '🌕');
});

test('the equinox sun: due south at noon, setting due west at 18:00', () => {
  const noon = sunDirection(12);
  near(altitude(noon), 90 - LATITUDE, .01, 'noon altitude');
  near(azimuth(noon), 180, .01, 'noon azimuth');
  const sunset = sunDirection(18);
  near(altitude(sunset), 0, .01, 'sunset altitude');
  near(azimuth(sunset), 270, .01, 'sunset azimuth');
  assert.ok(altitude(sunDirection(21)) < -18, 'full night by 21:00');
});

test('Polaris marks north at the latitude angle, all night', () => {
  for (const lst of [0, 7, 15]) {
    const polaris = equatorialToWorld(37.95, 89.26, lst);
    const az = azimuth(polaris);
    assert.ok(az < 1.2 || az > 358.8, `azimuth ${az}`);
    near(altitude(polaris), LATITUDE, .8, 'altitude');
  }
  assert.equal(directionName(2), 'צפון');
  assert.equal(directionName(268), 'מערב');
});

test('the star basis is a rotation that agrees with equatorialToWorld', () => {
  const [ex, ey, ez] = skyBasis(9.3);
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  near(dot(ex, ey), 0, 1e-12);
  near(dot(ex, ez), 0, 1e-12);
  near(dot(ey, ez), 0, 1e-12);
  const s = starVector(201.3, -11.16); // Spica
  const viaBasis = { x: ex.x * s.x + ey.x * s.y + ez.x * s.z, y: ex.y * s.x + ey.y * s.y + ez.y * s.z, z: ex.z * s.x + ey.z * s.y + ez.z * s.z };
  const direct = equatorialToWorld(201.3, -11.16, 9.3);
  near(viaBasis.x, direct.x, 1e-12);
  near(viaBasis.y, direct.y, 1e-12);
  near(viaBasis.z, direct.z, 1e-12);
});

test('moonrise follows the phase: full moon at sunset, last quarter near midnight', () => {
  const full = moonTimes(15);
  near(full.rise, 18, 1, 'full moon rise');
  assert.ok(altitude(moonDirection(24, 15)) > 45, 'full moon high at midnight');
  near(azimuth(moonDirection(24, 15)), 180, 15, 'and in the south');
  const firstQuarter = moonTimes(8);
  assert.ok(altitude(moonDirection(18, 8)) > 40, 'first quarter high at dusk');
  assert.ok(firstQuarter.set > 23 && firstQuarter.set < 26, `first quarter sets ${formatHour(firstQuarter.set)}`);
  const lastQuarter = moonTimes(22);
  assert.ok(lastQuarter.rise > 22.5 && lastQuarter.rise < 25.5, `last quarter rises ${formatHour(lastQuarter.rise)}`);
});

test('light: day unchanged, a moonless night is dark and starry, a full moon lights it up', () => {
  const day = skyState(12, 15);
  assert.equal(day.daylight, 1);
  assert.equal(day.key.body, 'sun');
  near(day.key.intensity, 2.6, 1e-9);
  near(day.hemi.intensity, 1.15, 1e-9);
  near(day.exposure, .96, 1e-9);
  assert.deepEqual(day.sky.top, DAY_SKY.top);
  near(DAY_SKY.top[2], .584, .001, 'the game sky, 0x4f8fc9 passed through linear');
  assert.equal(day.stars, 0);

  const moonless = skyState(22, 1);
  assert.ok(moonless.moonlight < .01);
  assert.ok(moonless.hemi.intensity < .05);
  near(moonless.stars, 1, 1e-6);

  const fullMoon = skyState(22, 15);
  assert.equal(fullMoon.key.body, 'moon');
  assert.ok(fullMoon.moonlight > .9);
  assert.ok(fullMoon.hemi.intensity > moonless.hemi.intensity * 4);
  assert.ok(fullMoon.stars < moonless.stars);
  assert.ok(fullMoon.fog.scale > moonless.fog.scale);

  const dusk = skyState(18.4, 1);
  assert.ok(dusk.dark > .2 && dusk.dark < 1, `dusk darkness ${dusk.dark}`);
  assert.ok(dusk.sky.glow[0] > .3, 'orange glow over the sunset');
});
