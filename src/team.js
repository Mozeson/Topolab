// Team navigation (multiplayer): the course is split among up to four players. Each learns a
// contiguous stretch of one or two targets (a control, or the finish), leads the group there,
// and the group must arrive together. Pure logic shared by the browser and the Node server
// (server/server.js), so the two always agree.

export const TEAM = {
  maxPlayers: 4,
  maxPerPlayer: 2,   // targets each player learns
  groupRadius: 40,   // metres: everyone within this of the control for it to count
  strayMeters: 150,  // farther than this from the leader: lost
  colors: ['#e2552d', '#2b7bd6', '#2f9e5b', '#9b4fd1'],
};

// Targets are the course points after the start: controls 1..k and the finish. With
// `targets` of them and `players` players: how many players actually lead (a block each).
export function blockCount(targets, players) {
  if (targets < 1 || players < 1) return 0;
  const least = Math.ceil(targets / TEAM.maxPerPlayer);
  if (least > players) return -1; // too many targets for this team
  return Math.max(least, Math.min(players, targets));
}

// A random split into contiguous blocks of 1–2 targets, each block given to a different
// player in random order. Returns { owners: [playerId per target index 1..targets],
// blocks: [{ player, from, to }] } or null when the course is too long for the team.
export function splitCourse(targets, playerIds, rng = Math.random) {
  const blocks = blockCount(targets, playerIds.length);
  if (blocks < 1) return null;
  const sizes = Array(blocks).fill(1);
  let extra = targets - blocks;
  while (extra > 0) {
    const i = Math.floor(rng() * blocks);
    if (sizes[i] < TEAM.maxPerPlayer) { sizes[i]++; extra--; }
  }
  const order = [...playerIds];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const owners = [null]; // index 0 is the start
  const list = [];
  let at = 1;
  sizes.forEach((size, b) => {
    list.push({ player: order[b], from: at, to: at + size - 1 });
    for (let k = 0; k < size; k++) owners.push(order[b]);
    at += size;
  });
  return { owners, blocks: list };
}

// The point indices a player sees: where their stretch starts (the previous point, where the
// group will be standing) and their own targets.
export function visibleIndices(split, playerId) {
  const block = split?.blocks.find((b) => b.player === playerId);
  if (!block) return [];
  const list = [];
  for (let i = block.from - 1; i <= block.to; i++) list.push(i);
  return list;
}

export const metersBetween = (a, b, extent) => Math.hypot(a.u - b.u, a.v - b.v) * extent;

// Is everyone at the target? Players without a known position block it.
export function groupAt(point, positions, extent, radius = TEAM.groupRadius) {
  const missing = [];
  for (const [id, p] of positions) {
    const d = p ? metersBetween(p, point, extent) : Infinity;
    if (d > radius) missing.push({ id, d });
  }
  return { all: missing.length === 0, missing };
}

// Players farther than `strayMeters` from the leader.
export function strays(leaderId, positions, extent) {
  const lead = positions.get(leaderId);
  if (!lead) return [];
  const list = [];
  for (const [id, p] of positions) {
    if (id === leaderId || !p) continue;
    const d = metersBetween(p, lead, extent);
    if (d > TEAM.strayMeters) list.push({ id, d });
  }
  return list;
}

// Room codes: four digits, easy to say aloud.
export function roomCode(rng = Math.random) {
  return String(1000 + Math.floor(rng() * 9000));
}
