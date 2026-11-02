// Map grid coordinates ("נקודת ציון"), Israeli-grid style: easting grows to the east,
// northing grows to the north, and the map's south-west corner sits at `origin`.
// Positions are normalised map coordinates (u → east, v → south, both 0..1).

export const DEFAULT_ORIGIN = Object.freeze({ e: 200000, n: 600000 });

export function sanitizeOrigin(origin) {
  const ok = (value) => Number.isFinite(value) && value >= 0 && value <= 9999999;
  return {
    e: ok(origin?.e) ? Math.round(origin.e) : DEFAULT_ORIGIN.e,
    n: ok(origin?.n) ? Math.round(origin.n) : DEFAULT_ORIGIN.n,
  };
}

// Exact grid position of a map point, in metres.
export function pointToGrid(u, v, extentMeters, origin = DEFAULT_ORIGIN) {
  return { e: origin.e + u * extentMeters, n: origin.n + (1 - v) * extentMeters };
}

// A coordinate as read off a map: rounded to `precision` metres (100 m by default).
export function readCoordinate(u, v, extentMeters, origin = DEFAULT_ORIGIN, precision = 100) {
  const { e, n } = pointToGrid(u, v, extentMeters, origin);
  return { e: Math.round(e / precision) * precision, n: Math.round(n / precision) * precision };
}

// "603200/200200": northing / easting, as written in the brief.
export function formatCoordinate({ e, n }) {
  return `${n}/${e}`;
}

// The grid square (corner values) that contains a point, for the explanation card.
export function gridSquare(u, v, extentMeters, cellMeters, origin = DEFAULT_ORIGIN) {
  const { e, n } = pointToGrid(u, v, extentMeters, origin);
  const e0 = origin.e + Math.floor((e - origin.e) / cellMeters) * cellMeters;
  const n0 = origin.n + Math.floor((n - origin.n) / cellMeters) * cellMeters;
  return { e0, n0, de: e - e0, dn: n - n0 };
}
