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
  speedFactor: 1.9,     // × walking base speed, unaffected by slope or land cover
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

// Typed cheat code: the last characters typed spell "drone" (English layout) or "רחפן"
// (Hebrew layout). `buffer` is the running string; returns { buffer, matched }.
export const CHEAT_WORDS = ['drone', 'רחפן'];
export function feedCheat(buffer, key) {
  if (typeof key !== 'string' || key.length !== 1) return { buffer, matched: false };
  const next = (buffer + key.toLowerCase()).slice(-8);
  const matched = CHEAT_WORDS.some((word) => next.endsWith(word));
  return { buffer: matched ? '' : next, matched };
}
