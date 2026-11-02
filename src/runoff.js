// Runoff droplets: show *how* rain moves over the land, not only where it gathers.
// Drops fall everywhere and slide along the steepest-descent direction of the (pit-filled)
// surface — on a dome they spread from the summit in every direction, on a ridge they part
// to both sides, in a valley they converge into the stream. A drop ends when it reaches a
// lake, leaves the map, stalls on flat ground or gets old; a new one falls elsewhere.
// Pure and deterministic (seeded); rain.js draws the trails in 2D and 3D.

function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// surface: heights (m) per grid cell; wet: water depth per cell (lakes), may be null;
// cellMeters: ground distance between grid points.
export function createRunoff({ size: n, surface, wet = null, cellMeters = 40, count = 1400, seed = 7 }) {
  const rand = random(seed);
  // Downhill gradient per cell (metres of drop per cell), central differences.
  const gx = new Float32Array(n * n);
  const gy = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const xm = Math.max(0, x - 1);
      const xp = Math.min(n - 1, x + 1);
      const ym = Math.max(0, y - 1);
      const yp = Math.min(n - 1, y + 1);
      gx[i] = (surface[y * n + xp] - surface[y * n + xm]) / (xp - xm);
      gy[i] = (surface[yp * n + x] - surface[ym * n + x]) / (yp - ym);
    }
  }
  const sample = (field, x, y) => {
    const x0 = Math.min(n - 2, Math.max(0, Math.floor(x)));
    const y0 = Math.min(n - 2, Math.max(0, Math.floor(y)));
    const tx = x - x0;
    const ty = y - y0;
    const top = field[y0 * n + x0] * (1 - tx) + field[y0 * n + x0 + 1] * tx;
    const bottom = field[(y0 + 1) * n + x0] * (1 - tx) + field[(y0 + 1) * n + x0 + 1] * tx;
    return top * (1 - ty) + bottom * ty;
  };
  const isWet = (x, y) => wet && wet[Math.round(y) * n + Math.round(x)] > .3;

  const particles = [];
  function spawn(p) {
    for (let tries = 0; tries < 12; tries++) {
      p.x = rand() * (n - 1);
      p.y = rand() * (n - 1);
      if (!isWet(p.x, p.y)) break;
    }
    p.px = p.x;
    p.py = p.y;
    p.vx = 0;
    p.vy = 0;
    p.age = 0;
    p.life = 2.5 + rand() * 4;
    p.fresh = true; // no trail segment on the frame it appears
    p.alive = true;
  }
  for (let i = 0; i < count; i++) {
    const p = {};
    spawn(p);
    p.age = rand() * p.life; // stagger lifetimes so drops don't all respawn together
    particles.push(p);
  }

  // Advance every drop by dt seconds. Speed (grid cells per second) grows with slope.
  function step(dt) {
    for (const p of particles) {
      if (!p.alive) { spawn(p); continue; }
      p.fresh = false;
      p.px = p.x;
      p.py = p.y;
      const dx = sample(gx, p.x, p.y);
      const dy = sample(gy, p.x, p.y);
      const magnitude = Math.hypot(dx, dy);
      p.age += dt;
      if (magnitude < 1e-4 || p.age > p.life) { p.alive = false; continue; }
      const grade = magnitude / cellMeters;
      const speed = 5 * Math.min(1.8, Math.max(.35, Math.sqrt(grade / .05)));
      p.vx = -dx / magnitude * speed;
      p.vy = -dy / magnitude * speed;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.x < 0 || p.y < 0 || p.x > n - 1 || p.y > n - 1 || isWet(p.x, p.y)) p.alive = false;
    }
  }

  return { particles, step, size: n };
}
