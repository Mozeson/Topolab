// Orienteering course model: a start, ordered controls and an optional finish.
// Positions are normalised map coordinates (u → east, v → south, both 0..1).
// Everything here is pure (no DOM / Three.js) except drawCourse, which only needs a 2D context.

export const COURSE_COLOR = '#c2187a'; // IOF overprint magenta

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function emptyCourse() {
  return { start: null, controls: [], finish: null };
}

export function cloneCourse(course) {
  const copy = (p) => (p ? { u: p.u, v: p.v } : null);
  return { start: copy(course?.start), controls: (course?.controls || []).map(copy), finish: copy(course?.finish) };
}

// Validates untrusted data (autosave) and returns a clean course.
export function sanitizeCourse(data) {
  const point = (p) => (p && Number.isFinite(p.u) && Number.isFinite(p.v) ? { u: clamp(p.u, 0, 1), v: clamp(p.v, 0, 1) } : null);
  return {
    start: point(data?.start),
    controls: Array.isArray(data?.controls) ? data.controls.map(point).filter(Boolean).slice(0, 30) : [],
    finish: point(data?.finish),
  };
}

export function isRunnable(course) {
  return Boolean(course?.start) && course.controls.length >= 1;
}

// Ordered stops. Without an explicit finish the course returns to the start.
export function coursePoints(course) {
  if (!course?.start) return [];
  const points = [{ kind: 'start', ...course.start }];
  course.controls.forEach((p, i) => points.push({ kind: 'control', number: i + 1, ...p }));
  if (course.controls.length) points.push({ kind: 'finish', implicit: !course.finish, ...(course.finish || course.start) });
  return points;
}

export function legs(course) {
  const points = coursePoints(course);
  return points.slice(1).map((to, i) => ({ from: points[i], to }));
}

export function distanceMeters(a, b, extentMeters) {
  return Math.hypot(a.u - b.u, a.v - b.v) * extentMeters;
}

export function courseLength(course, extentMeters) {
  return legs(course).reduce((sum, leg) => sum + distanceMeters(leg.from, leg.to, extentMeters), 0);
}

// How close (m) the navigator must get to "punch" a control. Grows with the map so the
// coarse 4–8 km grids stay fair; never below 15 m.
export function reachRadiusMeters(extentMeters) {
  return Math.max(15, extentMeters * .012);
}

// Game walking speed in m/s. Deliberately faster than reality so a lesson-sized course
// takes minutes, not hours; the results screen also shows a realistic estimate.
export function baseSpeed(extentMeters) {
  return extentMeters / 150;
}

// Speed multiplier from the grade along the direction of travel (rise / run).
// Uphill is costly, gentle downhill a little faster, steep downhill slow again.
export function slopeSpeedFactor(grade) {
  if (grade > 0) return clamp(1 / (1 + grade * 5), .2, 1);
  const down = -grade;
  if (down <= .4) return 1 + down * .25;
  return clamp(1.1 / (1 + (down - .4) * 4), .3, 1.1);
}

// Naismith's rule: 5 km/h on the flat plus one hour per 600 m of ascent.
export function naismithMinutes(distance, ascent) {
  return distance / 5000 * 60 + Math.max(0, ascent) / 600 * 60;
}

export function totalScore({ elapsed, peeks = 0, penaltyPerPeek = 0 }) {
  return elapsed + peeks * penaltyPerPeek;
}

export function courseKey(course, mapSize) {
  return [mapSize, ...coursePoints(course).map((p) => `${p.u.toFixed(3)},${p.v.toFixed(3)}`)].join('|');
}

// Deterministic PRNG (mulberry32).
export function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// How "readable" a spot is as a control: hilltops, hollows and spurs have strong local
// curvature, flat ground has none. Used to prefer real terrain features.
export function featureScore(heights, n, u, v) {
  const x = clamp(Math.round(u * (n - 1)), 2, n - 3);
  const y = clamp(Math.round(v * (n - 1)), 2, n - 3);
  const h = (dx, dy) => heights[(y + dy) * n + (x + dx)];
  const centre = h(0, 0);
  const ring = (h(-2, 0) + h(2, 0) + h(0, -2) + h(0, 2) + h(-2, -2) + h(2, 2) + h(-2, 2) + h(2, -2)) / 8;
  return Math.abs(centre - ring);
}

export function segmentsCross(a, b, c, d) {
  const orient = (p, q, r) => (q.u - p.u) * (r.v - p.v) - (q.v - p.v) * (r.u - p.u);
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

export function pointSegmentDistance(p, a, b) {
  const du = b.u - a.u;
  const dv = b.v - a.v;
  const t = clamp(((p.u - a.u) * du + (p.v - a.v) * dv) / (du * du + dv * dv || 1), 0, 1);
  return Math.hypot(p.u - (a.u + du * t), p.v - (a.v + dv * t));
}

// Counts layout faults: legs that cross, and legs that pass within `clearance` of a
// stop they don't connect. A good course has none.
export function courseProblems(course, clearance = .03) {
  const all = legs(course);
  const stops = [course.start, ...course.controls, ...(course.finish ? [course.finish] : [])];
  const same = (a, b) => a.u === b.u && a.v === b.v;
  let problems = 0;
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 2; j < all.length; j++) {
      if (i === 0 && j === all.length - 1 && !course.finish) continue; // both touch the start
      if (segmentsCross(all[i].from, all[i].to, all[j].from, all[j].to)) problems++;
    }
    for (const p of stops) {
      if (same(p, all[i].from) || same(p, all[i].to)) continue;
      if (pointSegmentDistance(p, all[i].from, all[i].to) < clearance) problems++;
    }
  }
  return problems;
}

// Builds a course with `count` controls: legs between ~10% and ~35% of the map, stops
// away from the edges and from each other, preferring distinctive terrain and spread.
// Many greedy attempts are made and the best fault-free one wins (courseProblems).
// Returns a loop (finish = start).
export function generateCourse({ heights, n, extentMeters, count = 5, seed = 1 }) {
  const rand = random(seed);
  const margin = .08;
  const minLeg = .1;
  const maxLeg = .35;
  const minGap = .08;
  const pick = () => ({ u: margin + rand() * (1 - 2 * margin), v: margin + rand() * (1 - 2 * margin) });

  function attempt() {
    const start = { u: .2 + rand() * .6, v: .2 + rand() * .6 };
    const placed = [start];
    let quality = 0;
    for (let i = 0; i < count; i++) {
      const previous = placed[placed.length - 1];
      const last = i === count - 1;
      let best = null;
      let bestScore = -Infinity;
      for (let tries = 0; tries < 50; tries++) {
        const candidate = pick();
        const leg = Math.hypot(candidate.u - previous.u, candidate.v - previous.v);
        if (leg < minLeg || leg > maxLeg) continue;
        const nearest = Math.min(...placed.map((p) => Math.hypot(candidate.u - p.u, candidate.v - p.v)));
        if (nearest < minGap) continue;
        if (last && Math.hypot(candidate.u - start.u, candidate.v - start.v) > maxLeg) continue;
        const terrain = heights ? Math.min(featureScore(heights, n, candidate.u, candidate.v), 25) : 0;
        const score = terrain + nearest * 60 + rand() * 3;
        if (score > bestScore) { bestScore = score; best = candidate; }
      }
      if (!best) return null;
      placed.push(best);
      quality += bestScore;
    }
    const course = { start, controls: placed.slice(1), finish: null };
    return { course, problems: courseProblems(course, .045), quality };
  }

  let best = null;
  for (let k = 0; k < 80; k++) {
    const result = attempt();
    if (!result) continue;
    if (!best || result.problems < best.problems || (result.problems === best.problems && result.quality > best.quality)) best = result;
    if (best.problems === 0 && k >= 12) break;
  }
  return best ? { ...best.course, extentMeters } : { start: pick(), controls: [], finish: null, extentMeters };
}

// ——— Overprint drawing (start triangle, numbered circles, double-circle finish) ———
// `visible` (a Set of point indices) draws only part of the course, keeping its numbers:
// team navigation shows each player just their own stretch (team.js visibleIndices).
export function drawCourse(ctx, course, { width, height, dpr = 1, nextIndex = -1, done = 0, scale = 1, color = COURSE_COLOR, visible = null } = {}) {
  const points = coursePoints(course);
  const shown = (i) => !visible || visible.has(i);
  if (!points.length) return;
  const size = Math.min(width, height);
  const r = clamp(size * .022, 9 * dpr, 22 * dpr) * scale;
  const px = (p) => ({ x: p.u * width, y: p.v * height });
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Legs, trimmed so they stop at the symbols' edges.
  for (let i = 1; i < points.length; i++) {
    if (!shown(i - 1) || !shown(i)) continue;
    const a = px(points[i - 1]);
    const b = px(points[i]);
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < r * 2.4) continue;
    const ux = (b.x - a.x) / length;
    const uy = (b.y - a.y) / length;
    ctx.beginPath();
    ctx.moveTo(a.x + ux * r * 1.15, a.y + uy * r * 1.15);
    ctx.lineTo(b.x - ux * r * 1.15, b.y - uy * r * 1.15);
    ctx.strokeStyle = i <= done ? 'rgba(194,24,122,.35)' : color;
    ctx.lineWidth = 1.8 * dpr * scale;
    ctx.stroke();
  }
  ctx.font = `700 ${Math.round(r * 1.05)}px Heebo, Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  points.forEach((point, index) => {
    if (!shown(index)) return;
    const { x, y } = px(point);
    const isNext = index === nextIndex;
    const isDone = index < done || (point.kind === 'start' && done > 0);
    ctx.strokeStyle = isDone ? 'rgba(194,24,122,.4)' : color;
    ctx.lineWidth = (isNext ? 3 : 2) * dpr * scale;
    if (isNext) {
      ctx.beginPath();
      ctx.arc(x, y, r * 1.55, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(194,24,122,.14)';
      ctx.fill();
    }
    if (point.kind === 'start') {
      const target = points[1] ? px(points[1]) : { x, y: y - 1 };
      const angle = Math.atan2(target.y - y, target.x - x);
      ctx.beginPath();
      for (let k = 0; k < 3; k++) {
        const a = angle + k * Math.PI * 2 / 3;
        const tx = x + Math.cos(a) * r * 1.2;
        const ty = y + Math.sin(a) * r * 1.2;
        if (k === 0) ctx.moveTo(tx, ty); else ctx.lineTo(tx, ty);
      }
      ctx.closePath();
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
      if (point.kind === 'finish') {
        ctx.beginPath();
        ctx.arc(x, y, r * .68, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    if (point.kind === 'control') {
      const label = String(point.number);
      const lx = x + r * 1.35;
      const ly = y - r * 1.1;
      ctx.lineWidth = 3.5 * dpr * scale;
      ctx.strokeStyle = 'rgba(255,255,255,.92)';
      ctx.strokeText(label, lx, ly);
      ctx.fillStyle = isDone ? 'rgba(194,24,122,.45)' : color;
      ctx.fillText(label, lx, ly);
    }
  });
  ctx.restore();
}
