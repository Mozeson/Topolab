// "ג״ג" (גבול גזרה, the sector boundary) and the ghosts that guard it. The boundary is drawn
// round the course with a margin; come close to it and a pack of ghosts bursts out from beyond
// the line, screaming, and runs at you. A ghost that reaches you costs time and throws you
// back inside. Pure logic (no three.js) so it can be tested; nav-game.js draws and plays it.

export const GHOST = {
  count: 9,          // ghosts in a pack
  marginFactor: .1,  // boundary margin round the course, share of the map side…
  minMargin: 250,    // …but at least this many metres
  maxMargin: 700,
  warn: 80,          // metres from the line: a whisper and a warning
  wake: 40,          // metres from the line (or past it): the pack comes
  calm: 170,         // back this far inside and the ghosts give up
  speedFactor: 1.7,  // × walking pace: running (×2.4) gets away
  minSpeed: 5,       // m/s
  catchMeters: 3.5,
  pushBack: 70,      // metres inside the line where a caught walker lands
  penalty: 25,       // seconds
};

// Convex hull (monotone chain) of points { u, v }.
export function convexHull(points) {
  const pts = [...points].sort((a, b) => a.u - b.u || a.v - b.v);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a.u - o.u) * (b.v - o.v) - (a.v - o.v) * (b.u - o.u);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

export function marginMeters(extent) {
  return Math.min(GHOST.maxMargin, Math.max(GHOST.minMargin, extent * GHOST.marginFactor));
}

// The sector: the course's hull grown by the margin (a rounded outline), kept just inside the
// map so the line is always visible. Returns a closed polygon [{ u, v }].
export function sectorBoundary(points, extent, { margin = marginMeters(extent), steps = 16, inset = .02 } = {}) {
  if (!points?.length) return [];
  const r = margin / extent;
  const ring = [];
  for (const p of points) {
    for (let i = 0; i < steps; i++) {
      const a = i / steps * Math.PI * 2;
      ring.push({ u: p.u + Math.cos(a) * r, v: p.v + Math.sin(a) * r });
    }
  }
  const hull = convexHull(ring).map((p) => ({ u: Math.min(1 - inset, Math.max(inset, p.u)), v: Math.min(1 - inset, Math.max(inset, p.v)) }));
  // Clamping can leave repeated corners on the map edge: drop them.
  return hull.filter((p, i) => {
    const q = hull[(i + hull.length - 1) % hull.length];
    return Math.hypot(p.u - q.u, p.v - q.v) > 1e-6;
  });
}

export function insidePolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a.v > p.v) !== (b.v > p.v) && p.u < (b.u - a.u) * (p.v - a.v) / (b.v - a.v) + a.u) inside = !inside;
  }
  return inside;
}

// The closest point of the outline to p, with the outward direction there.
export function nearestOnBoundary(p, poly) {
  let best = null;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const du = b.u - a.u;
    const dv = b.v - a.v;
    const len2 = du * du + dv * dv || 1e-12;
    const t = Math.max(0, Math.min(1, ((p.u - a.u) * du + (p.v - a.v) * dv) / len2));
    const q = { u: a.u + du * t, v: a.v + dv * t };
    const d = Math.hypot(p.u - q.u, p.v - q.v);
    if (!best || d < best.d) best = { ...q, d, tu: du / Math.sqrt(len2), tv: dv / Math.sqrt(len2) };
  }
  if (!best) return null;
  // Outward normal: perpendicular to the edge, pointing away from the polygon's centre.
  const c = poly.reduce((s, q) => ({ u: s.u + q.u / poly.length, v: s.v + q.v / poly.length }), { u: 0, v: 0 });
  let nu = -best.tv;
  let nv = best.tu;
  if (nu * (best.u - c.u) + nv * (best.v - c.v) < 0) { nu = -nu; nv = -nv; }
  return { u: best.u, v: best.v, d: best.d, nu, nv, tu: best.tu, tv: best.tv };
}

// Metres from the line: positive inside the sector, negative past it.
export function signedDistance(p, poly, extent) {
  const near = nearestOnBoundary(p, poly);
  if (!near) return Infinity;
  return (insidePolygon(p, poly) ? 1 : -1) * near.d * extent;
}

// A pack bursting out from beyond the line near the walker, spread along it.
export function spawnGhosts({ player, poly, extent, count = GHOST.count, rng = Math.random }) {
  const near = nearestOnBoundary(player, poly);
  if (!near) return [];
  const ghosts = [];
  for (let i = 0; i < count; i++) {
    const along = (rng() - .5) * 220 / extent;
    const out = (25 + rng() * 70) / extent;
    ghosts.push({
      u: Math.min(1, Math.max(0, near.u + near.tu * along + near.nu * out)),
      v: Math.min(1, Math.max(0, near.v + near.tv * along + near.nv * out)),
      delay: rng() * 1.4,          // they come out one after another
      wobble: rng() * Math.PI * 2,
      speed: .85 + rng() * .35,
      heading: 0,
      scream: 1 + rng() * 2.5,     // seconds to the next scream
      state: 'chase',
    });
  }
  return ghosts;
}

// One ghost, one step. Returns 'caught' when it reaches the walker.
export function stepGhost(ghost, { dt, player, extent, walkSpeed, time = 0 }) {
  if (ghost.delay > 0) { ghost.delay -= dt; return null; }
  const du = (player.u - ghost.u) * extent;
  const dv = (player.v - ghost.v) * extent;
  const d = Math.hypot(du, dv);
  if (ghost.state === 'chase' && d < GHOST.catchMeters) return 'caught';
  const speed = Math.max(GHOST.minSpeed, walkSpeed * GHOST.speedFactor) * ghost.speed;
  let mu = du / (d || 1);
  let mv = dv / (d || 1);
  if (ghost.state === 'flee') { mu = -mu; mv = -mv; }
  // A weaving run: sideways wobble so the pack does not move as one block.
  const side = Math.sin(time * 3.1 + ghost.wobble) * .45;
  const wu = mu - mv * side;
  const wv = mv + mu * side;
  const len = Math.hypot(wu, wv) || 1;
  const stepMeters = Math.min(speed * dt, ghost.state === 'chase' ? Math.max(0, d - GHOST.catchMeters * .5) : speed * dt);
  ghost.u = Math.min(1, Math.max(0, ghost.u + wu / len * stepMeters / extent));
  ghost.v = Math.min(1, Math.max(0, ghost.v + wv / len * stepMeters / extent));
  ghost.heading = (Math.atan2(wu, -wv) * 180 / Math.PI + 360) % 360; // 0 = north
  ghost.scream -= dt;
  if (ghost.scream <= 0) { ghost.scream = 1.6 + Math.random() * 2.4; return 'scream'; }
  return null;
}

// Where a caught walker is set down: back inside, `GHOST.pushBack` metres from the line.
export function pushInside(player, poly, extent) {
  const near = nearestOnBoundary(player, poly);
  if (!near) return { ...player };
  const inward = GHOST.pushBack / extent;
  return { u: Math.min(.998, Math.max(.002, near.u - near.nu * inward)), v: Math.min(.998, Math.max(.002, near.v - near.nv * inward)) };
}

// The line on a map canvas: a purple dashed outline with short ticks on the inside, the way
// a sector boundary is marked on an orienteering briefing map.
export function drawSector(ctx, poly, { width, height, dpr = 1 }) {
  if (!poly?.length) return;
  ctx.save();
  ctx.beginPath();
  poly.forEach((p, i) => (i ? ctx.lineTo(p.u * width, p.v * height) : ctx.moveTo(p.u * width, p.v * height)));
  ctx.closePath();
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,.75)';
  ctx.lineWidth = 4.5 * dpr;
  ctx.stroke();
  ctx.strokeStyle = '#6b2fa3';
  ctx.lineWidth = 2.2 * dpr;
  ctx.setLineDash([9 * dpr, 5 * dpr]);
  ctx.stroke();
  ctx.setLineDash([]);
  // Ticks pointing in, every ~40 px.
  const c = poly.reduce((s, q) => ({ u: s.u + q.u / poly.length, v: s.v + q.v / poly.length }), { u: 0, v: 0 });
  ctx.lineWidth = 1.6 * dpr;
  for (let i = 0; i < poly.length; i++) {
    const a = { x: poly[i].u * width, y: poly[i].v * height };
    const b = { x: poly[(i + 1) % poly.length].u * width, y: poly[(i + 1) % poly.length].v * height };
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.floor(len / (40 * dpr));
    let nx = -(b.y - a.y) / (len || 1);
    let ny = (b.x - a.x) / (len || 1);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (nx * (c.u * width - mid.x) + ny * (c.v * height - mid.y) < 0) { nx = -nx; ny = -ny; }
    for (let k = 1; k <= n; k++) {
      const t = k / (n + 1);
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + nx * 6 * dpr, y + ny * 6 * dpr);
      ctx.stroke();
    }
  }
  ctx.restore();
}
