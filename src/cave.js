// The cave blooper: where the cave goes. Always in a gully (a high valley score), clear of
// the start and the controls. Pure; nav-game.js builds it and runs the sequence.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// score: valleyScore grid (camels.js); returns { u, v } or null.
export function pickCaveSpot({ score, n, rng, extent, avoid = [], clearMeters = 300 }) {
  const ranked = [...score].sort((a, b) => b - a);
  const threshold = Math.max(1e-6, ranked[Math.floor(ranked.length * .12)]); // the top 12%: real gullies
  const candidates = [];
  for (let i = 0; i < score.length; i++) {
    if (score[i] < threshold) continue;
    const u = (i % n) / (n - 1);
    const v = Math.floor(i / n) / (n - 1);
    if (u < .06 || u > .94 || v < .06 || v > .94) continue;
    if (avoid.some((p) => Math.hypot(p.u - u, p.v - v) * extent < clearMeters)) continue;
    candidates.push({ u, v });
  }
  if (!candidates.length) return null;
  const pick = candidates[Math.floor(rng() * candidates.length)];
  return { u: clamp(pick.u + (rng() - .5) * .4 / (n - 1), 0, 1), v: clamp(pick.v + (rng() - .5) * .4 / (n - 1), 0, 1) };
}
