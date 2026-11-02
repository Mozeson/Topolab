// Drone mode for the navigation game (the "רחפן" cheat). Pure helpers, no DOM / Three.js:
// altitude hold with automatic terrain clearance, the battery, when a drone can "read" a
// control's note, and the typed cheat code. nav-game.js drives it; see docs/NAVIGATION.md.
//
// Units: altitudes are in display metres along the (possibly exaggerated) vertical axis,
// i.e. `ground` is the terrain height under the drone × exaggeration. AGL (height above
// ground) is therefore what the pilot sees on screen.

export const DRONE = {
  minClearance: 8,      // m — never lower than this above the ground (auto-climb over hills)
  maxAgl: 500,          // m — ceiling above the ground below
  startAgl: 60,         // m — climbs to this after take-off
  climbRate: 35,        // m/s — Q/E or the on-screen ▲▼
  wheelStep: 20,        // m per wheel notch
  readAgl: 40,          // m — must be this low over a control to read (punch) its note
  landAgl: 2.5,         // m — below this while landing the pilot steps out
  speedFactor: 3,       // × walking base speed, unaffected by slope or land cover
  batterySeconds: 240,  // full battery = 4 minutes of flight
  rechargePerSecond: .5, // % per second while walking
  lowBattery: 15,       // % — warning
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// One step of altitude control. `altitude` and `target` are absolute (same frame as
// `ground`); returns the new altitude/target. The drone eases towards the target at the
// climb rate and is pushed up when the ground rises beneath it.
export function stepAltitude({ altitude, target, ground, dt, climbRate = DRONE.climbRate }) {
  const floor = ground + DRONE.minClearance;
  const ceiling = ground + DRONE.maxAgl;
  let nextTarget = clamp(target, floor, ceiling);
  const delta = nextTarget - altitude;
  const maxStep = climbRate * dt;
  let next = altitude + clamp(delta, -maxStep, maxStep);
  // Terrain avoidance wins over the climb rate: never below the minimum clearance.
  if (next < floor) {
    next = floor;
    nextTarget = Math.max(nextTarget, floor);
  }
  return { altitude: next, target: nextTarget, agl: next - ground };
}

// Landing: descend at the climb rate; `landed` once low enough (no minimum clearance).
export function stepLanding({ altitude, ground, dt, climbRate = DRONE.climbRate }) {
  const next = Math.max(ground, altitude - climbRate * dt);
  return { altitude: next, agl: next - ground, landed: next - ground <= DRONE.landAgl };
}

// Battery in percent. Flying drains it over `batterySeconds`; walking recharges it.
export function stepBattery(battery, dt, flying) {
  if (flying) return clamp(battery - dt / DRONE.batterySeconds * 100, 0, 100);
  return clamp(battery + dt * DRONE.rechargePerSecond, 0, 100);
}

// A drone "reads" a note when it hovers low enough within the control's reach.
export function canReadNote({ horizontalDistance, reach, agl }) {
  return horizontalDistance <= reach && agl <= DRONE.readAgl;
}

// Typed cheat codes: the last characters typed spell "drone" / "רחפן" (camera drone) or
// "fpv" / "כפה" (the same keys on a Hebrew layout: an FPV racing drone).
// `buffer` is the running string; returns { buffer, matched, mode }.
export const CHEAT_WORDS = { drone: 'drone', 'רחפן': 'drone', fpv: 'fpv', 'כפה': 'fpv' };
export function feedCheat(buffer, key) {
  if (typeof key !== 'string' || key.length !== 1) return { buffer, matched: false, mode: null };
  const next = (buffer + key.toLowerCase()).slice(-8);
  const word = Object.keys(CHEAT_WORDS).find((candidate) => next.endsWith(candidate));
  return { buffer: word ? '' : next, matched: Boolean(word), mode: word ? CHEAT_WORDS[word] : null };
}

// ——— FPV racing drone ———
// "Fly where the camera points": thrust along the view direction (pitch included, so
// nose-down dives), momentum with exponential drag so full throttle settles at the top
// speed, a boost, and ground contact that skims along the surface — or, when the ground
// comes up too fast, crashes and bounces. Velocities are in display metres per second:
// x = east, y = up, z = south.
export const FPV = {
  minClearance: 3,     // m above the ground
  drag: 1.1,           // 1/s — full throttle settles at maxSpeed in about 2 s
  speedPerKm: 35,      // top speed scales with the map: 4 km → 140 m/s (≈ 500 km/h)
  minSpeed: 60,
  maxSpeed: 260,
  boost: 1.8,          // Shift: ≈ 900 km/h on a 4 km map
  climbFactor: .75,    // E/Q/Space thrust relative to the main thrust
  crashClosing: 35,    // m/s — hitting the ground faster than this is a crash
  batteryFactor: 2,    // FPV packs drain twice as fast
  turnRate: 150,       // °/s yaw
  pitchRate: 70,       // °/s with the arrow keys
};

export function fpvTopSpeed(extentMeters) {
  return clamp(extentMeters / 1000 * FPV.speedPerKm, FPV.minSpeed, FPV.maxSpeed);
}

// One physics step. throttle −1..1 (forward thrust), strafe −1..1 (sideways),
// climb −1..1 (vertical thrust). heading/tilt in degrees (tilt < 0 looks down).
export function fpvVelocity({ vel, heading, tilt, throttle, strafe = 0, climb = 0, boost = false, dt, topSpeed }) {
  const h = heading * Math.PI / 180;
  const p = tilt * Math.PI / 180;
  const top = topSpeed * (boost ? FPV.boost : 1);
  const accel = top * FPV.drag; // terminal velocity = accel / drag = top
  const forward = { x: Math.sin(h) * Math.cos(p), y: Math.sin(p), z: -Math.cos(h) * Math.cos(p) };
  const right = { x: Math.cos(h), y: 0, z: Math.sin(h) };
  const ax = (forward.x * throttle + right.x * strafe) * accel;
  const ay = forward.y * throttle * accel + climb * accel * FPV.climbFactor;
  const az = (forward.z * throttle + right.z * strafe) * accel;
  const decay = Math.exp(-FPV.drag * dt);
  return {
    x: (vel.x + ax * dt) * decay,
    y: (vel.y + ay * dt) * decay,
    z: (vel.z + az * dt) * decay,
  };
}

// Ground contact after moving: below the clearance the drone is lifted back up.
// Coming in faster than `crashClosing` is a crash (bounce, most speed lost).
export function fpvGround({ altitude, vel, ground, dt }) {
  const floor = ground + FPV.minClearance;
  if (altitude >= floor) return { altitude, vel, crashed: false, skimming: altitude - floor < 4 };
  const closing = (floor - altitude) / Math.max(dt, 1e-3);
  if (closing > FPV.crashClosing) {
    return { altitude: floor + 6, vel: { x: vel.x * .35, y: Math.abs(vel.y) * .3 + 8, z: vel.z * .35 }, crashed: true, skimming: false, closing };
  }
  return { altitude: floor, vel: { x: vel.x * (1 - .4 * dt), y: Math.max(vel.y, 0), z: vel.z * (1 - .4 * dt) }, crashed: false, skimming: true, closing };
}

// Terrain warning ("PULL UP"): following the current velocity, when does the drone first
// go below the clearance? `groundAt(dx, dz)` returns the ground height dx m east and dz m
// south of the drone. Looks `horizon` seconds ahead; returns seconds, or Infinity.
// A 1 m tolerance keeps level skimming over flat ground quiet.
export function terrainAhead({ altitude, vel, groundAt, horizon = 1.2, steps = 6 }) {
  for (let i = 1; i <= steps; i++) {
    const t = horizon * i / steps;
    if (altitude + vel.y * t < groundAt(vel.x * t, vel.z * t) + FPV.minClearance - 1) return t;
  }
  return Infinity;
}
