// Sky for dusk and night navigation: the sun, the moon and the stars over Israel around the
// March equinox (sunset ≈ 18:00 local solar time), with the moon's phase taken from the day
// of the Hebrew month — a lunar month, so א׳ is about new moon and ט״ו about full moon.
// Pure (no Three.js): nav-game.js and scene.js turn skyState() into lights, fog and a sky.
//
// Directions use the game's world axes: x east, y up, z south (north is −z).
// Times are hours on a continuous evening clock: 18 = 18:00, 26 = 02:00 the next night.

export const LATITUDE = 31.5;       // central Israel
export const SYNODIC_MONTH = 29.53; // days from one new moon to the next
const OBLIQUITY = 23.44;
const D = Math.PI / 180;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (a, b, t) => a.map((v, i) => lerp(v, b[i], t));
const mod = (a, n) => ((a % n) + n) % n;

export const HEBREW_DAYS = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ז׳', 'ח׳', 'ט׳', 'י׳', 'י״א', 'י״ב', 'י״ג', 'י״ד', 'ט״ו',
  'ט״ז', 'י״ז', 'י״ח', 'י״ט', 'כ׳', 'כ״א', 'כ״ב', 'כ״ג', 'כ״ד', 'כ״ה', 'כ״ו', 'כ״ז', 'כ״ח', 'כ״ט', 'ל׳'];
export function hebrewDay(day) { return HEBREW_DAYS[clamp(Math.round(day), 1, 30) - 1]; }

export function formatHour(hour) {
  const minutes = Math.round(mod(hour, 24) * 60) % (24 * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

// Moon age (days since new moon) on the night that opens `day` of the month — a Hebrew day
// starts at nightfall — at `hour` on the evening clock.
export function moonAge(day, hour = 18) {
  return clamp(day, 1, 30) - .5 + (hour - 18) / 24;
}

const PHASES = [
  [12, 'מולד (ירח חדש)'], [80, 'סהר מתמלא'], [100, 'רבע ראשון'], [168, 'ירח מתמלא'],
  [192, 'ירח מלא'], [260, 'ירח מתמעט'], [280, 'רבע אחרון'], [348, 'סהר מתמעט'], [361, 'מולד (ירח חדש)'],
];
const EMOJI = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];

// Elongation: how far (°) the moon is east of the sun. Lit fraction of the disc from it.
export function moonPhase(day, hour = 18) {
  const age = moonAge(day, hour);
  const elongation = mod(age / SYNODIC_MONTH * 360, 360);
  const illumination = (1 - Math.cos(elongation * D)) / 2;
  return {
    age, elongation, illumination,
    waxing: elongation < 180,
    name: PHASES.find(([limit]) => elongation < limit)[1],
    emoji: EMOJI[Math.round(elongation / 45) % 8],
  };
}

// Local sidereal time (hours) at local solar `hour`: around the March equinox the sun is at
// right ascension 0h, so it crosses the meridian at noon.
export function siderealTime(hour) { return mod(hour - 12, 24); }

// Right ascension / declination (degrees) → world direction at sidereal time `lst` (hours).
export function equatorialToWorld(ra, dec, lst, lat = LATITUDE) {
  const H = (lst * 15 - ra) * D; // hour angle: 0 on the meridian (south), growing westwards
  const d = dec * D;
  const p = lat * D;
  return {
    x: -Math.cos(d) * Math.sin(H),
    y: Math.sin(d) * Math.sin(p) + Math.cos(d) * Math.cos(H) * Math.cos(p),
    z: -Math.sin(d) * Math.cos(p) + Math.cos(d) * Math.cos(H) * Math.sin(p),
  };
}

// The rotation that carries the stars: world images of the equatorial axes (RA 0h, RA 6h,
// and the celestial pole). Stars stored as equatorial unit vectors turn with the sky.
export function skyBasis(lst, lat = LATITUDE) {
  return [equatorialToWorld(0, 0, lst, lat), equatorialToWorld(90, 0, lst, lat), equatorialToWorld(0, 90, lst, lat)];
}

// Equatorial unit vector for a star (x towards RA 0h, z towards the celestial pole).
export function starVector(ra, dec) {
  return { x: Math.cos(dec * D) * Math.cos(ra * D), y: Math.cos(dec * D) * Math.sin(ra * D), z: Math.sin(dec * D) };
}

function eclipticToEquatorial(lambda) {
  const l = lambda * D;
  const e = OBLIQUITY * D;
  return { ra: mod(Math.atan2(Math.cos(e) * Math.sin(l), Math.cos(l)) / D, 360), dec: Math.asin(Math.sin(e) * Math.sin(l)) / D };
}

export const altitude = (dir) => Math.asin(clamp(dir.y, -1, 1)) / D;
export const azimuth = (dir) => mod(Math.atan2(dir.x, -dir.z) / D, 360); // 0 = north, 90 = east

const DIRECTIONS = ['צפון', 'צפון־מזרח', 'מזרח', 'דרום־מזרח', 'דרום', 'דרום־מערב', 'מערב', 'צפון־מערב'];
export function directionName(az) { return DIRECTIONS[Math.round(mod(az, 360) / 45) % 8]; }

export function sunDirection(hour) { return equatorialToWorld(0, 0, siderealTime(hour)); }

// The moon sits `elongation` degrees east of the sun along the ecliptic (the sun is at
// ecliptic longitude 0 at the March equinox), so spring evening crescents ride high.
export function moonDirection(hour, day) {
  const { ra, dec } = eclipticToEquatorial(moonPhase(day, hour).elongation);
  return equatorialToWorld(ra, dec, siderealTime(hour));
}

// Moonrise and moonset around the night of `day` (searching noon to noon).
export function moonTimes(day, from = 12, to = 36) {
  let rise = null;
  let set = null;
  const step = 1 / 30;
  let previous = moonDirection(from, day).y;
  for (let h = from + step; h <= to + 1e-9; h += step) {
    const y = moonDirection(h, day).y;
    const crossing = h - step + step * previous / (previous - y);
    if (previous < 0 && y >= 0 && rise === null) rise = crossing;
    if (previous >= 0 && y < 0 && set === null) set = crossing;
    previous = y;
  }
  return { rise, set };
}

// The sky dome's shader writes its colours straight to the screen, so these are display
// values. By day the game's sky is THREE.Color(hex) passed through unconverted, i.e. the
// hex colour's linear value: reproduce exactly that so dusk starts from the usual sky.
const srgbToLinear = (c) => (c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
const hexToLinear = (hex) => [hex >> 16, (hex >> 8) & 255, hex & 255].map((c) => srgbToLinear(c / 255));
export const DAY_SKY = { top: hexToLinear(0x4f8fc9), horizon: hexToLinear(0xdfe9e2), bottom: hexToLinear(0xb9c6b0) };

// By the sun's altitude: zenith, horizon, and the warm glow on the sun's side of the horizon.
const SKY = [
  [-18, [.012, .02, .05], [.04, .05, .085], [0, 0, 0]],
  [-14, [.016, .027, .065], [.06, .07, .11], [.02, .01, .006]],
  [-10, [.025, .045, .1], [.11, .11, .17], [.08, .035, .015]],
  [-6, [.04, .08, .18], [.24, .21, .3], [.25, .09, .03]],
  [-3, [.05, .12, .28], [.44, .35, .4], [.45, .17, .05]],
  [0, [.06, .17, .38], [.64, .52, .48], [.5, .24, .07]],
  [3, [.07, .23, .5], [.71, .69, .65], [.28, .14, .04]],
  [10, DAY_SKY.top, DAY_SKY.horizon, [0, 0, 0]],
];
// Fog colour (sRGB: it goes through the materials' lighting and tone mapping).
const FOG = [[-18, [.03, .035, .06]], [-12, [.06, .07, .11]], [-6, [.2, .2, .28]], [0, [.62, .55, .55]], [10, [.875, .914, .886]]];

function interpolate(table, x, column) {
  if (x <= table[0][0]) return table[0][column];
  for (let i = 1; i < table.length; i++) {
    if (x <= table[i][0]) {
      const t = (x - table[i - 1][0]) / (table[i][0] - table[i - 1][0]);
      const a = table[i - 1][column];
      const b = table[i][column];
      return Array.isArray(a) ? mix(a, b, t) : lerp(a, b, t);
    }
  }
  return table.at(-1)[column];
}

// Sky light: twilight stays usable for a while; a moonless night is very dark but the
// eye (the exposure below) still makes out the ground near you.
const AMBIENT = [[-18, .035], [-12, .08], [-9, .16], [-6, .32], [-3, .55], [0, .8], [10, 1.15]];
const SUN_COLOUR = [[0, [1, .55, .3]], [5, [1, .75, .52]], [15, [1, .945, .84]]];
const MOON_COLOUR = [.65, .74, .95];

// Everything the renderer needs at `hour` on the night of `day`.
export function skyState(hour, day) {
  const sun = sunDirection(hour);
  const moon = moonDirection(hour, day);
  const phase = moonPhase(day, hour);
  const sunAlt = altitude(sun);
  const moonAlt = altitude(moon);
  const daylight = smoothstep(-6, 8, sunAlt);
  const dark = 1 - daylight;
  // Perceived brightness: a quarter moon looks about a third as bright as a full one.
  const moonlight = phase.illumination ** 1.5 * smoothstep(-1, 6, moonAlt);
  const sunIntensity = 2.6 * smoothstep(-1, 12, sunAlt);
  const moonIntensity = .9 * moonlight * dark;
  const key = sunIntensity >= moonIntensity
    ? { body: 'sun', dir: sun, intensity: sunIntensity, color: interpolate(SUN_COLOUR, sunAlt, 1) }
    : { body: 'moon', dir: moon, intensity: moonIntensity, color: MOON_COLOUR };
  const moonGlow = moonlight * dark;
  const top = interpolate(SKY, sunAlt, 1).map((v, i) => v + [.035, .06, .13][i] * moonGlow);
  const horizon = interpolate(SKY, sunAlt, 2).map((v, i) => v + [.05, .07, .12][i] * moonGlow);
  return {
    hour, day, sun, moon, phase, sunAlt, moonAlt,
    sunAz: azimuth(sun), moonAz: azimuth(moon),
    daylight, dark, moonlight,
    lst: siderealTime(hour),
    key,
    hemi: {
      intensity: interpolate(AMBIENT, sunAlt, 1) + .2 * moonGlow,
      sky: mix([.35, .45, .75], [.95, .96, 1], daylight),
      ground: mix([.08, .09, .12], [.35, .4, .31], daylight),
    },
    fill: .35 * daylight,
    exposure: lerp(1.6, .96, daylight),
    fog: { color: interpolate(FOG, sunAlt, 1).map((v, i) => v + [.05, .07, .12][i] * moonGlow), scale: lerp(.55 + .35 * moonlight, 1, daylight) },
    sky: { top, horizon, bottom: mix(horizon.map((v) => v * .6), DAY_SKY.bottom, daylight), glow: interpolate(SKY, sunAlt, 3) },
    stars: (1 - smoothstep(-13, -4, sunAlt)) * (1 - .5 * moonlight),
    sunDisc: smoothstep(-1.5, .5, sunAlt),
    moonDisc: lerp(.45, 1.1, dark),
    moonHalo: .3 * phase.illumination ** 1.5 * dark,
  };
}

// Bright stars (RA, Dec in degrees; visual magnitude) — enough to find north by Polaris and
// recognise the Plough (העגלה הגדולה), Cassiopeia and Orion. The rest of the sky is random.
export const BRIGHT_STARS = [
  ['כוכב הצפון', 37.95, 89.26, 2.0],
  ['דובהה', 165.93, 61.75, 1.8], ['מראק', 165.46, 56.38, 2.4], ['פכדה', 178.46, 53.69, 2.4], ['מגרז', 183.86, 57.03, 3.3],
  ['אליות', 193.51, 55.96, 1.8], ['מיצר', 200.98, 54.93, 2.2], ['אלקאיד', 206.89, 49.31, 1.9],
  ['שדר', 10.13, 56.54, 2.2], ['קף', 2.29, 59.15, 2.3], ['גמא קסיופאה', 14.18, 60.72, 2.2], ['רוכבה', 21.45, 60.24, 2.7], ['סגין', 28.6, 63.67, 3.4],
  ['בטלגז', 88.79, 7.41, .5], ['ריגל', 78.63, -8.2, .1], ['בלטריקס', 81.28, 6.35, 1.6], ['אלניטק', 85.19, -1.94, 1.8],
  ['אלנילם', 84.05, -1.2, 1.7], ['מינטקה', 83.0, -.3, 2.2], ['סאיף', 86.94, -9.67, 2.1],
  ['סיריוס', 101.29, -16.72, -1.5], ['פרוקיון', 114.83, 5.22, .4], ['קפלה', 79.17, 46.0, .1], ['אלדברן', 68.98, 16.51, .9],
  ['פולוקס', 116.33, 28.03, 1.1], ['קסטור', 113.65, 31.89, 1.6], ['רגולוס', 152.09, 11.97, 1.4], ['ספיקה', 201.3, -11.16, 1.0],
  ['ארקטורוס', 213.92, 19.18, -.05], ['וגה', 279.23, 38.78, .03], ['דנב', 310.36, 45.28, 1.25], ['אלטאיר', 297.7, 8.87, .8], ['אנטארס', 247.35, -26.43, 1.0],
];
