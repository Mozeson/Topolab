// Wind for the navigation game: a prevailing direction that drifts a little, a base
// strength picked per run, and gusts. Pure (no DOM / Three.js); nav-game.js turns it into
// swaying grass and trees, blowing dust, the sound, and a small effect on walking speed.
//
// `from` is where the wind comes from (degrees, 0 = north, 90 = east), like a weather report;
// `toward` is the unit vector it blows along in map axes (x east, z south).

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const D = Math.PI / 180;

export const WIND = {
  levels: [.18, .42, .7],  // calm, breezy, windy: base strength
  headwind: .12,           // walking straight into a full-strength wind: 12% slower
  tailwind: .05,           // with it at your back: 5% faster
};

// A run's wind: mostly westerly (the sea breeze), sometimes from elsewhere.
export function createWind(rng) {
  const from = rng() < .7 ? 250 + rng() * 70 : rng() * 360;
  const base = WIND.levels[Math.min(2, Math.floor(rng() * 3))] * (.85 + rng() * .3);
  return { from, base, seed: rng() * 1000 };
}

// Smooth pseudo-noise in 0..1 from incommensurate sines.
function wave(t, seed) {
  return .5 + .5 * (Math.sin(t * .31 + seed) * .5 + Math.sin(t * .73 + seed * 1.7) * .3 + Math.sin(t * 1.91 + seed * .3) * .2);
}

// The wind at time t (seconds): direction, strength 0..1 and how gusty it is right now.
export function windAt(wind, t) {
  const gust = clamp((wave(t, wind.seed) - .45) * 2.2, 0, 1) ** 1.5;
  const strength = clamp(wind.base * (.6 + .9 * gust), 0, 1);
  const from = (wind.from + Math.sin(t * .05 + wind.seed) * 15 + 360) % 360;
  const toward = { x: -Math.sin(from * D), z: Math.cos(from * D) }; // blows away from `from`
  return { from, toward, strength, gust };
}

// Walking speed factor for a heading (degrees): slower into the wind, a little faster with it.
export function windSpeedFactor(state, heading) {
  const into = Math.cos((heading - state.from) * D); // 1 = walking straight into it
  return into > 0 ? 1 - WIND.headwind * state.strength * into : 1 - WIND.tailwind * state.strength * into;
}

const FROM = ['צפונית', 'צפון־מזרחית', 'מזרחית', 'דרום־מזרחית', 'דרומית', 'דרום־מערבית', 'מערבית', 'צפון־מערבית'];
export function describeWind(state) {
  const direction = FROM[Math.round(state.from / 45) % 8];
  const force = state.gust > .65 && state.strength > .45 ? 'במשבים' : state.strength < .25 ? 'חלשה' : state.strength < .55 ? 'בינונית' : 'חזקה';
  return `רוח ${direction} ${force}`;
}
