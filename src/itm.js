// Israeli Transverse Mercator (ITM, EPSG:2039) ↔ WGS84 latitude/longitude.
// The grid of Israeli maps ("רשת ישראל החדשה"): eastings ~100–300 km, northings ~350–800 km.
// Transverse Mercator on GRS80 (Snyder's series), then the Israel 1993 → WGS84 seven-parameter
// datum shift. Within ~1.5 m of pyproj across the country (tests/itm.test.js): far finer
// than the 30 m elevation data it is used for.

const D = Math.PI / 180;
const A = 6378137;              // GRS80 and WGS84 share the semi-major axis
const F_GRS80 = 1 / 298.257222101;
const F_WGS84 = 1 / 298.257223563;
const LAT0 = 31.7343936111111 * D;
const LON0 = 35.2045169444444 * D;
const K0 = 1.0000067;
const FE = 219529.584;
const FN = 626907.39;
// Israel 1993 → WGS84 (position vector, as in EPSG / PROJ): metres, arc-seconds, ppm.
const TOWGS84 = { tx: -24.0024, ty: -17.1032, tz: -17.8444, rx: -.33077, ry: -1.85269, rz: 1.66969, s: 5.4248 };

const E2 = F_GRS80 * (2 - F_GRS80);
const EP2 = E2 / (1 - E2);

function meridian(phi) {
  const e4 = E2 * E2;
  const e6 = e4 * E2;
  return A * ((1 - E2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi
    - (3 * E2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * phi)
    + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * phi)
    - (35 * e6 / 3072) * Math.sin(6 * phi));
}
const M0 = meridian(LAT0);

// Grid → geodetic on GRS80 (Israel 1993 datum), radians.
function gridToGeodetic(e, n) {
  const m = M0 + (n - FN) / K0;
  const mu = m / (A * (1 - E2 / 4 - 3 * E2 * E2 / 64 - 5 * E2 ** 3 / 256));
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const phi1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu)
    + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu)
    + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const sin1 = Math.sin(phi1);
  const cos1 = Math.cos(phi1);
  const c1 = EP2 * cos1 * cos1;
  const t1 = Math.tan(phi1) ** 2;
  const n1 = A / Math.sqrt(1 - E2 * sin1 * sin1);
  const r1 = A * (1 - E2) / (1 - E2 * sin1 * sin1) ** 1.5;
  const d = (e - FE) / (n1 * K0);
  const lat = phi1 - (n1 * Math.tan(phi1) / r1) * (d * d / 2
    - (5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * EP2) * d ** 4 / 24
    + (61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * EP2 - 3 * c1 * c1) * d ** 6 / 720);
  const lon = LON0 + (d - (1 + 2 * t1 + c1) * d ** 3 / 6
    + (5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * EP2 + 24 * t1 * t1) * d ** 5 / 120) / cos1;
  return { lat, lon };
}

// Geodetic on GRS80 → grid.
function geodeticToGrid(lat, lon) {
  const sin = Math.sin(lat);
  const cos = Math.cos(lat);
  const n = A / Math.sqrt(1 - E2 * sin * sin);
  const t = Math.tan(lat) ** 2;
  const c = EP2 * cos * cos;
  const a = (lon - LON0) * cos;
  const m = meridian(lat);
  const e = FE + K0 * n * (a + (1 - t + c) * a ** 3 / 6 + (5 - 18 * t + t * t + 72 * c - 58 * EP2) * a ** 5 / 120);
  const north = FN + K0 * (m - M0 + n * Math.tan(lat) * (a * a / 2 + (5 - t + 9 * c + 4 * c * c) * a ** 4 / 24
    + (61 - 58 * t + t * t + 600 * c - 330 * EP2) * a ** 6 / 720));
  return { e, n: north };
}

function toCartesian(lat, lon, f) {
  const e2 = f * (2 - f);
  const n = A / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  return [n * Math.cos(lat) * Math.cos(lon), n * Math.cos(lat) * Math.sin(lon), n * (1 - e2) * Math.sin(lat)];
}

function toGeodetic([x, y, z], f) {
  const e2 = f * (2 - f);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - e2));
  for (let i = 0; i < 6; i++) {
    const n = A / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    lat = Math.atan2(z + e2 * n * Math.sin(lat), p);
  }
  return { lat, lon: Math.atan2(y, x) };
}

// Seven-parameter shift (position vector rotation); `sign` −1 applies the inverse.
function helmert([x, y, z], sign = 1) {
  const sec = D / 3600;
  const rx = TOWGS84.rx * sec * sign;
  const ry = TOWGS84.ry * sec * sign;
  const rz = TOWGS84.rz * sec * sign;
  const s = 1 + TOWGS84.s * 1e-6 * sign;
  return [
    TOWGS84.tx * sign + s * (x - rz * y + ry * z),
    TOWGS84.ty * sign + s * (rz * x + y - rx * z),
    TOWGS84.tz * sign + s * (-ry * x + rx * y + z),
  ];
}

// ITM metres → WGS84 degrees.
export function itmToWgs84(e, n) {
  const local = gridToGeodetic(e, n);
  const wgs = toGeodetic(helmert(toCartesian(local.lat, local.lon, F_GRS80)), F_WGS84);
  return { lat: wgs.lat / D, lon: wgs.lon / D };
}

// WGS84 degrees → ITM metres.
export function wgs84ToItm(lat, lon) {
  const local = toGeodetic(helmert(toCartesian(lat * D, lon * D, F_WGS84), -1), F_GRS80);
  return geodeticToGrid(local.lat, local.lon);
}

// Is this a plausible ITM coordinate inside Israel's grid?
export function isItm(e, n) {
  return e >= 100000 && e <= 300000 && n >= 350000 && n <= 820000;
}
