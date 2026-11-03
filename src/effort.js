// Effort for the navigation game: fatigue builds while running and climbing and eases while
// walking or resting. Pure; nav-game.js uses it for breathing sounds and a tired run.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const EFFORT = {
  rise: .22,     // per second towards a higher load
  recover: .1,   // per second towards a lower one
  tiredRun: .82, // running speed at full fatigue (× normal running)
};

// How hard you are working right now (0 = standing … ~1 = running uphill).
export function effortLoad({ moving, running, grade }) {
  if (!moving) return 0;
  return clamp((running ? .7 : .22) + Math.max(0, grade) * 2.6, 0, 1);
}

export function stepFatigue(fatigue, load, dt) {
  const rate = load > fatigue ? EFFORT.rise : EFFORT.recover;
  return clamp(fatigue + (load - fatigue) * Math.min(1, rate * dt * 3), 0, 1);
}

// Breathing: seconds between breaths and how loud (0 = not heard).
export function breathing(fatigue) {
  return {
    interval: 4.2 - 3.1 * fatigue,
    volume: clamp((fatigue - .2) / .6, 0, 1),
  };
}

// Running gets slower when you are spent.
export function runFactor(fatigue) {
  return 1 - (1 - EFFORT.tiredRun) * clamp((fatigue - .5) / .5, 0, 1);
}
