// Camels in the navigation game: they graze, mostly in valleys, and chase a walker who
// comes too close. Pure logic (no DOM / Three.js) so it can be tested; nav-game.js draws
// them and applies the consequences. See docs/NAVIGATION.md.
//
// Positions are map fractions (u east, v south); distances in metres; speeds relative to
// the game's walking speed (course.js baseSpeed), so the chase feels the same on any map.
// Headings follow the walker: 0° = north (−v), 90° = east (+u).

export const CAMEL = {
  counts: { none: 0, few: 5, many: 12 },
  detectFactor: .035,      // × map extent: how close before a camel notices you…
  minDetect: 60,           // …but never less than this (m)
  catchFactor: .0013,      // × extent: "caught" distance…
  minCatch: 4,             // …at least this (m)
  chaseSpeed: 1.08,        // × walking speed on the flat: walking won't shake one off, running will
  wanderSpeed: .22,        // × walking speed while grazing
  slopeDrag: 2,            // uphill slowdown (walkers use 5: camels gain on climbs)
  alertSeconds: [.7, 1.3], // staring at you before the chase starts
  chaseSeconds: [10, 18],  // how long one keeps at it
  restSeconds: [12, 20],   // ignores you after giving up…
  caughtRestSeconds: 30,   // …and for longer after catching you
  giveUpFactor: 2.4,       // × detection radius: too far, gives up
  startClear: .1,          // no camels within this × extent of the start (≥ 250 m)
  herdSpread: 40,          // m around a herd's spot
  wanderFactor: .02,       // × extent: how far a grazing camel strolls (≥ 40 m)
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const between = (rng, [lo, hi]) => lo + rng() * (hi - lo);
export const metersBetween = (a, b, extent) => Math.hypot(a.u - b.u, a.v - b.v) * extent;

export function detectRadius(extent) { return Math.max(CAMEL.minDetect, extent * CAMEL.detectFactor); }
export function catchRadius(extent) { return Math.max(CAMEL.minCatch, extent * CAMEL.catchFactor); }

// Valley score: the mean height of a (2r+1)² window minus the height (the topographic
// position index). Positive in valleys and hollows, negative on ridges and tops.
export function valleyScore(heights, n, radius) {
  const w = n + 1;
  const sat = new Float64Array(w * w); // summed-area table
  for (let y = 0; y < n; y++) {
    let row = 0;
    for (let x = 0; x < n; x++) {
      row += heights[y * n + x];
      sat[(y + 1) * w + x + 1] = sat[y * w + x + 1] + row;
    }
  }
  const out = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(n - 1, y + radius);
    for (let x = 0; x < n; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(n - 1, x + radius);
      const sum = sat[(y1 + 1) * w + x1 + 1] - sat[y0 * w + x1 + 1] - sat[(y1 + 1) * w + x0] + sat[y0 * w + x0];
      out[y * n + x] = sum / ((y1 - y0 + 1) * (x1 - x0 + 1)) - heights[y * n + x];
    }
  }
  return out;
}

// Bilinear sample of an n×n grid whose corners are the map corners.
export function sampleGrid(grid, n, u, v) {
  const x = clamp(u, 0, 1) * (n - 1);
  const y = clamp(v, 0, 1) * (n - 1);
  const x0 = Math.min(n - 2, Math.floor(x));
  const y0 = Math.min(n - 2, Math.floor(y));
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * n + x0;
  return (grid[i] * (1 - fx) + grid[i + 1] * fx) * (1 - fy) + (grid[i + n] * (1 - fx) + grid[i + n + 1] * fx) * fy;
}

function makeCamel(u, v, rng) {
  return {
    u, v, heading: rng() * 360, state: 'graze', timer: 0, target: null,
    wanderTimer: 1 + rng() * 4, // grazing rhythm: stand, stroll, stand…
    aggression: .35 + rng() * .65, // how quickly it decides to chase
    gait: 0, speed: 0, chasedFor: 0,
  };
}

// Herds of 1–3 camels around spots drawn with valley-weighted odds (a few roam elsewhere),
// none near the start. `score` is a valleyScore grid; `avoid` lists map points to keep clear.
export function spawnCamels({ score, n, count, rng, extent, avoid = [] }) {
  if (!count) return [];
  let max = 0;
  for (const s of score) max = Math.max(max, s);
  const floor = Math.max(max, 1e-6) ** 1.5 * .02;
  const weights = new Float64Array(score.length);
  let total = 0;
  for (let i = 0; i < score.length; i++) {
    weights[i] = Math.max(0, score[i]) ** 1.5 + floor;
    total += weights[i];
  }
  const pick = () => {
    let r = rng() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) return i;
    }
    return weights.length - 1;
  };
  const clear = Math.max(250, extent * CAMEL.startClear);
  const camels = [];
  for (let guard = 0; camels.length < count && guard < 500; guard++) {
    const cell = pick();
    const u = clamp((cell % n + rng() - .5) / (n - 1), .02, .98);
    const v = clamp((Math.floor(cell / n) + rng() - .5) / (n - 1), .02, .98);
    if (avoid.some((p) => metersBetween(p, { u, v }, extent) < clear)) continue;
    const herd = Math.min(count - camels.length, 1 + Math.floor(rng() * 3));
    for (let k = 0; k < herd; k++) {
      const angle = rng() * Math.PI * 2;
      const r = CAMEL.herdSpread * (k ? .4 + rng() : 0) / extent;
      camels.push(makeCamel(clamp(u + Math.cos(angle) * r, .02, .98), clamp(v + Math.sin(angle) * r, .02, .98), rng));
    }
  }
  return camels;
}

// Walk towards a map point at `speed` m/s, stopping `stopAt` metres short. Slower uphill.
function moveToward(camel, target, speed, ctx, stopAt = 0) {
  const { dt, extent } = ctx;
  const dx = (target.u - camel.u) * extent;
  const dz = (target.v - camel.v) * extent;
  const distance = Math.hypot(dx, dz);
  if (distance < 1e-6) { camel.speed = 0; return 0; }
  camel.heading = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360;
  let factor = 1;
  if (ctx.heightAt) {
    const probe = 8;
    const ahead = ctx.heightAt(clamp(camel.u + dx / distance * probe / extent, 0, 1), clamp(camel.v + dz / distance * probe / extent, 0, 1));
    const grade = (ahead - ctx.heightAt(camel.u, camel.v)) / probe;
    if (grade > 0) factor = Math.max(.35, 1 / (1 + grade * CAMEL.slopeDrag));
  }
  const step = Math.max(0, Math.min(speed * factor * dt, distance - stopAt));
  camel.u = clamp(camel.u + dx / distance * step / extent, .01, .99);
  camel.v = clamp(camel.v + dz / distance * step / extent, .01, .99);
  camel.gait += step;
  camel.speed = step / Math.max(dt, 1e-6);
  return step;
}

// Grazing: stand a while, then stroll to a nearby spot, preferring the lowest ground.
function wander(camel, ctx) {
  const { rng, extent } = ctx;
  if (!camel.target) {
    camel.speed = 0;
    if (camel.wanderTimer > 0) return;
    const reach = Math.max(40, extent * CAMEL.wanderFactor);
    let best = null;
    for (let k = 0; k < 6; k++) {
      const angle = rng() * Math.PI * 2;
      const r = reach * (.3 + rng() * .7) / extent;
      const candidate = { u: clamp(camel.u + Math.cos(angle) * r, .02, .98), v: clamp(camel.v + Math.sin(angle) * r, .02, .98) };
      const score = ctx.scoreAt ? ctx.scoreAt(candidate.u, candidate.v) : 0;
      if (!best || score > best.score) best = { ...candidate, score };
    }
    camel.target = { u: best.u, v: best.v };
    camel.wanderTimer = 25; // give up on a target it can't reach
    return;
  }
  moveToward(camel, camel.target, CAMEL.wanderSpeed * ctx.walkSpeed, ctx);
  if (metersBetween(camel, camel.target, extent) < 2 || camel.wanderTimer <= 0) {
    camel.target = null;
    camel.speed = 0;
    camel.wanderTimer = 2 + rng() * 5; // graze here for a while
  }
}

// One update. ctx: { dt, extent, walkSpeed (m/s), rng, player: { u, v, onFoot, visibility },
// heightAt(u, v) (m, for the uphill slowdown), scoreAt(u, v) (valley score) }.
// `player.visibility` scales the detection radius (darkness, a headlamp).
// Returns an event: 'alert' | 'chase' | 'caught' | 'escaped' (shaken off on foot) |
// 'gaveUp' (the walker took off in the drone) | null.
export function stepCamel(camel, ctx) {
  const { dt, extent, rng, player } = ctx;
  const detect = detectRadius(extent) * (player.visibility ?? 1);
  const distance = metersBetween(camel, player, extent);
  camel.timer -= dt;
  camel.wanderTimer -= dt;
  switch (camel.state) {
    case 'graze': {
      if (player.onFoot && distance < detect && rng() < camel.aggression * dt * 2) {
        camel.state = 'alert';
        camel.timer = between(rng, CAMEL.alertSeconds);
        camel.target = null;
        camel.speed = 0;
        return 'alert';
      }
      wander(camel, ctx);
      return null;
    }
    case 'alert': {
      camel.speed = 0;
      camel.heading = (Math.atan2((player.u - camel.u), -(player.v - camel.v)) * 180 / Math.PI + 360) % 360;
      if (!player.onFoot || distance > detect * 1.3) {
        camel.state = 'graze';
        camel.wanderTimer = 2;
        return null;
      }
      if (camel.timer <= 0) {
        camel.state = 'chase';
        camel.timer = between(rng, CAMEL.chaseSeconds);
        camel.chasedFor = 0;
        return 'chase';
      }
      return null;
    }
    case 'chase': {
      camel.chasedFor += dt;
      const caught = catchRadius(extent);
      if (player.onFoot && distance <= caught) {
        camel.state = 'rest';
        camel.timer = CAMEL.caughtRestSeconds;
        camel.speed = 0;
        return 'caught';
      }
      // Outran, or it lost patience: on foot that's an escape; flying off doesn't count.
      if (!player.onFoot || distance > detect * CAMEL.giveUpFactor || camel.timer <= 0) {
        camel.state = 'rest';
        camel.timer = between(rng, CAMEL.restSeconds);
        camel.target = null;
        camel.speed = 0;
        return player.onFoot ? 'escaped' : 'gaveUp';
      }
      moveToward(camel, player, CAMEL.chaseSpeed * ctx.walkSpeed, ctx, caught * .5);
      if (metersBetween(camel, player, extent) <= caught) {
        camel.state = 'rest';
        camel.timer = CAMEL.caughtRestSeconds;
        camel.speed = 0;
        return 'caught';
      }
      return null;
    }
    default: { // 'rest': ignores the walker for a while
      wander(camel, ctx);
      if (camel.timer <= 0) camel.state = 'graze';
      return null;
    }
  }
}

// Keep camels from piling into one spot (a chasing herd would otherwise merge).
export function separateCamels(camels, minMeters, extent) {
  for (let i = 0; i < camels.length; i++) {
    for (let j = i + 1; j < camels.length; j++) {
      const a = camels[i];
      const b = camels[j];
      const dx = (b.u - a.u) * extent;
      const dz = (b.v - a.v) * extent;
      const d = Math.hypot(dx, dz);
      if (d >= minMeters || d < 1e-9) continue;
      const push = (minMeters - d) / 2 / extent;
      a.u -= dx / d * push;
      a.v -= dz / d * push;
      b.u += dx / d * push;
      b.v += dz / d * push;
    }
  }
}
