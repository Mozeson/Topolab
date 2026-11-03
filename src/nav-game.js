// Orienteering game: first-person navigation between pre-set controls.
// Owns the setup dialog, the HUD, the 3D course markers / sky / shrubs, scoring and
// the results screen. scene.js supplies terrain access and switches the app into
// "game mode" through api.enter() / api.exit(). See docs/NAVIGATION.md.
import * as THREE from 'three';
import {
  coursePoints, legs, distanceMeters, reachRadiusMeters, baseSpeed, slopeSpeedFactor,
  naismithMinutes, totalScore, courseKey, drawCourse, courseLength, random, COURSE_COLOR,
} from './course.js';
import { readCoordinate, formatCoordinate } from './grid-coords.js';
import { DRONE, FPV, stepAltitude, stepLanding, stepBattery, canReadNote, feedCheat, fpvTopSpeed, fpvVelocity, fpvGround, terrainAhead } from './drone.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CAMEL, valleyScore, sampleGrid, spawnCamels, stepCamel, separateCamels, metersBetween, detectRadius } from './camels.js';
import {
  skyState, skyBasis, starVector, BRIGHT_STARS, moonPhase, moonTimes, moonDirection, hebrewDay, formatHour, altitude, azimuth, directionName,
} from './sky.js';

export const NAV_LEVELS = {
  easy: { mapMode: 'always', showPosition: true, showBearing: true, showDistance: true },
  normal: { mapMode: 'always', showPosition: false, showBearing: false, showDistance: false },
  hard: { mapMode: 'peek', showPosition: false, showBearing: false, showDistance: false },
  memory: { mapMode: 'none', showPosition: false, showBearing: false, showDistance: false },
};
const LEVEL_NAMES = { easy: 'קל', normal: 'רגיל', hard: 'מאתגר', memory: 'מהזיכרון', custom: 'מותאם אישית' };
export const PEEK_PENALTY = 15; // seconds added per map peek
const TURN_SPEED = 110;         // degrees per second
const RUN_FACTOR = 1.8;
const BACK_FACTOR = .55;
const BEST_KEY = 'topolab-nav-best';
const SOUND_KEY = 'topolab-nav-sound';
const RELIEF_KEY = 'topolab-nav-relief';
const RELIEF_OPTIONS = [1, 3, 5, 10];
const CARDINALS = { 0: 'צ', 90: 'מז', 180: 'ד', 270: 'מע' };
const COMPASS_PX = 3; // pixels per degree on the compass tape
const CAMELS_KEY = 'topolab-nav-camels';
const TIME_KEY = 'topolab-nav-time';
const MOON_KEY = 'topolab-nav-moon-day';
const HOUR_KEY = 'topolab-nav-start-hour';
const TIME_OPTIONS = ['day', 'dusk', 'night'];
const NIGHT_HOURS = [19, 20, 21, 22, 23, 24, 25, 26, 27, 28]; // 19:00 … 04:00 on the evening clock (sky.js)
const DUSK_START = 17 + 40 / 60; // twenty minutes before sunset
export const CAMEL_PENALTY = 20; // seconds added when a camel catches you
const LAMP_INTENSITY = 3.6;  // headlamp beam (decay 0: even light out to its range)
const SPILL_INTENSITY = .6;  // its soft spill around your feet

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function formatClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

function formatMeters(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 2)} ק״מ` : `${Math.round(m)} מ׳`;
}

function bearingDegrees(from, to) {
  return (Math.atan2(to.u - from.u, -(to.v - from.v)) * 180 / Math.PI + 360) % 360;
}

function readStorage(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function writeStorage(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

export function createNavGame(api) {
  const coordOf = (point) => formatCoordinate(readCoordinate(point.u, point.v, api.extent(), api.gridOrigin ? api.gridOrigin() : undefined));
  const $ = (id) => document.getElementById(id);
  const hud = $('navHud');
  const mapCard = $('navMapCard');
  const mapCanvas = $('navMapCanvas');
  const mapCtx = mapCanvas.getContext('2d');

  let course = null;
  let points = [];
  let settings = { ...NAV_LEVELS.normal };
  let level = 'normal';
  let phase = 'idle'; // idle | countdown | running | paused | finished
  let run = null;     // per-attempt state, see resetRun()
  let mapBase = null; // cached terrain map (canvas) for this attempt
  let world = null;   // 3D objects added for the game
  let soundOn = readStorage(SOUND_KEY, true);
  let audio = null;
  const keys = new Set();
  let look = null;
  let cheatBuffer = '';   // typed characters, for the "רחפן" / "drone" cheat
  let timerTaps = [];     // quick taps on the timer: the touch-screen way in
  let droneClimbInput = 0; // ▲ / ▼ buttons held (touch)
  let buzz = null;        // propeller sound
  let hudTimer = 0;
  let mapTimer = 0;
  let countdownTimer = null;
  let camelRng = Math.random;
  const lampDir = new THREE.Vector3();
  const headingTurn = new THREE.Quaternion();
  const viewDir = new THREE.Vector3();
  const toObject = new THREE.Vector3();

  // ——— Setup dialog ———
  const setupDialog = $('navSetupDialog');
  const resultsDialog = $('navResultsDialog');
  const levelInputs = [...document.querySelectorAll('input[name="navLevel"]')];

  function applyLevel(name) {
    level = name;
    settings = { ...NAV_LEVELS[name] };
    syncCustomControls();
    updateBest();
  }

  function syncCustomControls() {
    $('navMapMode').value = settings.mapMode;
    $('navShowPosition').checked = settings.showPosition;
    $('navShowBearing').checked = settings.showBearing;
    $('navShowDistance').checked = settings.showDistance;
    $('navShowPosition').disabled = settings.mapMode === 'none';
    for (const input of levelInputs) input.checked = input.value === level;
  }

  function readCustomControls() {
    settings = {
      mapMode: $('navMapMode').value,
      showPosition: $('navShowPosition').checked,
      showBearing: $('navShowBearing').checked,
      showDistance: $('navShowDistance').checked,
    };
    const match = Object.entries(NAV_LEVELS).find(([, preset]) => Object.keys(preset).every((k) => preset[k] === settings[k]));
    level = match ? match[0] : 'custom';
    syncCustomControls();
    updateBest();
  }

  levelInputs.forEach((input) => input.addEventListener('change', () => applyLevel(input.value)));

  // Vertical exaggeration in the field (display only: speed and climb use the real slope).
  const reliefInputs = [...document.querySelectorAll('input[name="navRelief"]')];
  let relief = readStorage(RELIEF_KEY, 10);
  if (!RELIEF_OPTIONS.includes(relief)) relief = 10;
  reliefInputs.forEach((input) => {
    input.checked = Number(input.value) === relief;
    input.addEventListener('change', () => { relief = Number(input.value); writeStorage(RELIEF_KEY, relief); });
  });
  for (const id of ['navMapMode', 'navShowPosition', 'navShowBearing', 'navShowDistance']) $(id).addEventListener('change', readCustomControls);

  // Camels in the field (camels.js) and the time of day with the moon (sky.js).
  let camelsOption = readStorage(CAMELS_KEY, 'few');
  if (!(camelsOption in CAMEL.counts)) camelsOption = 'few';
  document.querySelectorAll('input[name="navCamels"]').forEach((input) => {
    input.checked = input.value === camelsOption;
    input.addEventListener('change', () => { camelsOption = input.value; writeStorage(CAMELS_KEY, camelsOption); });
  });
  let timeOption = readStorage(TIME_KEY, 'day');
  if (!TIME_OPTIONS.includes(timeOption)) timeOption = 'day';
  let moonDay = clamp(Math.round(Number(readStorage(MOON_KEY, 15)) || 15), 1, 30);
  let startHour = Number(readStorage(HOUR_KEY, 21));
  if (!NIGHT_HOURS.includes(startHour)) startHour = 21;
  $('navStartHour').innerHTML = NIGHT_HOURS.map((h) => `<option value="${h}">${formatHour(h)}</option>`).join('');
  $('navStartHour').value = String(startHour);
  $('navMoonDay').value = String(moonDay);
  document.querySelectorAll('input[name="navTime"]').forEach((input) => {
    input.checked = input.value === timeOption;
    input.addEventListener('change', () => { timeOption = input.value; writeStorage(TIME_KEY, timeOption); updateMoonPreview(); updateBest(); });
  });
  $('navMoonDay').addEventListener('input', () => { moonDay = Number($('navMoonDay').value); writeStorage(MOON_KEY, moonDay); updateMoonPreview(); });
  $('navStartHour').addEventListener('change', () => { startHour = Number($('navStartHour').value); writeStorage(HOUR_KEY, startHour); updateMoonPreview(); });
  const startClockFor = () => (timeOption === 'dusk' ? DUSK_START : timeOption === 'night' ? startHour : 12);

  // The moon in the briefing: its phase, and where it will be when you set out.
  function updateMoonPreview() {
    $('navMoonRow').hidden = timeOption === 'day';
    $('navStartHourRow').hidden = timeOption !== 'night';
    if (timeOption === 'day') return;
    const start = startClockFor();
    const at = timeOption === 'dusk' ? 19.5 : start; // at dusk: once it is dark
    const phase = moonPhase(moonDay, at);
    $('navMoonDayLabel').textContent = hebrewDay(moonDay);
    drawMoon($('navMoonCanvas'), phase.elongation);
    const times = moonTimes(moonDay);
    const dir = moonDirection(at, moonDay);
    const height = altitude(dir);
    const when = timeOption === 'dusk' ? 'כשיחשיך' : 'ביציאה';
    let status;
    if (phase.illumination < .04) status = 'אין ירח הלילה: חושך מוחלט, רק כוכבים.';
    else if (height > 2) status = `${when} הירח ב${directionName(azimuth(dir))}, ${Math.round(height)}° מעל האופק${times.set !== null && times.set > at ? `, ושוקע ב־${formatHour(times.set)}` : ''}.`;
    else if (times.rise !== null && times.rise > at) status = `${when} הירח עוד מתחת לאופק. הוא יזרח ב־${formatHour(times.rise)}.`;
    else status = `${when} הירח כבר שקע${times.set !== null ? ` (ב־${formatHour(times.set)})` : ''}.`;
    const lead = timeOption === 'dusk' ? `יציאה ב־${formatHour(start)}, שקיעה ב־18:00 וחושך מלא בסביבות 19:25. ` : '';
    $('navMoonInfo').textContent = `${lead}${phase.emoji} ${phase.name} (${Math.round(phase.illumination * 100)}% מואר). ${status}`;
  }

  // The moon's disc lit from the side of the sun: waxing lit on the right (as seen from Israel).
  function drawMoon(canvas, elongation) {
    const ctx = canvas.getContext('2d');
    const size = canvas.width;
    const r = size / 2 - 2;
    const image = ctx.createImageData(size, size);
    const e = elongation * Math.PI / 180;
    const sx = Math.sin(e);
    const sz = -Math.cos(e);
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const x = (px + .5 - size / 2) / r;
        const y = (py + .5 - size / 2) / r;
        const r2 = x * x + y * y;
        const i = (py * size + px) * 4;
        if (r2 >= 1) { image.data[i + 3] = 0; continue; }
        const z = Math.sqrt(1 - r2);
        const t = clamp(((x * sx + z * sz) + .05) / .12, 0, 1);
        const lit = t * t * (3 - 2 * t);
        // A few soft "seas" so it reads as the moon.
        const sea = Math.max(0, Math.sin(x * 5.2 + 1.1) * Math.sin(y * 4.3 - .4)) * .16;
        const shade = (.8 + .2 * z) * (1 - sea);
        image.data[i] = 34 + (238 * shade - 34) * lit;
        image.data[i + 1] = 40 + (234 * shade - 40) * lit;
        image.data[i + 2] = 58 + (214 * shade - 58) * lit;
        image.data[i + 3] = Math.round(clamp((1 - Math.sqrt(r2)) * r, 0, 1) * 255);
      }
    }
    ctx.putImageData(image, 0, 0);
  }

  function bestKey() {
    // Dusk and night runs keep their own records; camels just add penalty time.
    return `${courseKey(course, api.mapSize())}|${level}${timeOption === 'day' ? '' : `|${timeOption}`}`;
  }

  function updateBest() {
    if (!course) return;
    const best = readStorage(BEST_KEY, {})[bestKey()];
    $('navBest').hidden = !best;
    if (best) $('navBest').textContent = `🏆 השיא שלכם במסלול הזה ברמה „${LEVEL_NAMES[level]}”: ${formatClock(best)}`;
  }

  function openSetup(nextCourse) {
    course = nextCourse;
    points = coursePoints(course);
    mapBase = buildMapBase(1024);
    const canvas = $('navBriefingCanvas');
    drawMapInto(canvas, { done: 0, nextIndex: 1, showYou: false });
    const extent = api.extent();
    const length = courseLength(course, extent);
    const controls = points.filter((p) => p.kind === 'control').length;
    $('navBriefingMeta').innerHTML = [
      `${controls} נקודות ביקורת`,
      `${formatMeters(length)} בקו ישר`,
      `שטח ${api.mapSize()}×${api.mapSize()} ק״מ`,
      `בשטח אמיתי: כ־${Math.round(naismithMinutes(length * 1.25, 0))} דק׳ הליכה`,
    ].map((t) => `<span>${t}</span>`).join('')
      + `<div class="nav-grid-list"><strong>נ״צ הנקודות (צפון/מזרח):</strong>${points.filter((p) => p.kind === 'control').map((p) => `<span><b>${p.number}</b> ${coordOf(p)}</span>`).join('')}</div>`;
    syncCustomControls();
    updateBest();
    updateMoonPreview();
    setupDialog.showModal();
    requestAnimationFrame(() => drawMapInto(canvas, { done: 0, nextIndex: 1, showYou: false }));
  }

  $('closeNavSetupBtn').addEventListener('click', () => setupDialog.close());
  $('cancelNavSetupBtn').addEventListener('click', () => setupDialog.close());
  setupDialog.addEventListener('click', (event) => { if (event.target === setupDialog) setupDialog.close(); });
  $('goNavBtn').addEventListener('click', () => { setupDialog.close(); start(); });

  // ——— Map rendering (briefing, in-game card, replay) ———
  function buildMapBase(size) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    api.renderMapBase(canvas.getContext('2d'), size, size, size / 520);
    return canvas;
  }

  function fitCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const side = Math.max(1, Math.round((rect.width || 300) * dpr));
    if (canvas.width !== side || canvas.height !== side) { canvas.width = side; canvas.height = side; }
    return dpr;
  }

  function drawMapInto(canvas, { done, nextIndex, showYou, track = null }) {
    const dpr = fitCanvas(canvas);
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (mapBase) ctx.drawImage(mapBase, 0, 0, w, h);
    if (track?.length > 1) drawTrack(ctx, track, w, h, dpr);
    drawCourse(ctx, course, { width: w, height: h, dpr, done, nextIndex, scale: w > 500 * dpr ? 1.2 : 1 });
    drawGridRefs(ctx, w, h, dpr, done);
    drawNorthArrow(ctx, w, dpr);
    if (showYou) drawYou(ctx, w, h, dpr);
  }

  // Each control's grid reference (נ״צ), under its number — what the note in the cairn says.
  function drawGridRefs(ctx, w, h, dpr, done) {
    const small = w < 420 * dpr;
    ctx.save();
    ctx.font = `700 ${(small ? 8 : 10) * dpr}px Arial, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    points.forEach((point, index) => {
      if (point.kind !== 'control') return;
      const text = coordOf(point);
      const r = Math.min(w, h) * .022;
      let x = point.u * w + r * 1.25;
      const y = point.v * h + r * 1.35;
      const width = ctx.measureText(text).width + 6 * dpr;
      if (x + width > w - 4 * dpr) x = point.u * w - r * 1.25 - width;
      ctx.globalAlpha = index < done ? .45 : 1;
      ctx.fillStyle = 'rgba(255,255,255,.88)';
      ctx.fillRect(x, y - 6.5 * dpr, width, 13 * dpr);
      ctx.fillStyle = '#7a1150';
      ctx.fillText(text, x + 3 * dpr, y + .5 * dpr);
    });
    ctx.restore();
  }

  function drawNorthArrow(ctx, w, dpr) {
    const x = w - 18 * dpr;
    const y = 22 * dpr;
    ctx.save();
    ctx.fillStyle = '#1f3a32';
    ctx.beginPath();
    ctx.moveTo(x, y - 12 * dpr);
    ctx.lineTo(x + 6 * dpr, y + 6 * dpr);
    ctx.lineTo(x, y + 2 * dpr);
    ctx.lineTo(x - 6 * dpr, y + 6 * dpr);
    ctx.closePath();
    ctx.fill();
    ctx.font = `700 ${10 * dpr}px Heebo, Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('צ', x, y + 17 * dpr);
    ctx.restore();
  }

  function drawYou(ctx, w, h, dpr) {
    const o = api.observer;
    const x = o.u * w;
    const y = o.v * h;
    const a = (o.heading - 90) * Math.PI / 180;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.arc(x, y, 34 * dpr, a - .45, a + .45);
    ctx.closePath();
    ctx.fillStyle = 'rgba(43,143,214,.22)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, 6 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = '#2b8fd6';
    ctx.fill();
    ctx.lineWidth = 2.5 * dpr;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.restore();
  }

  function drawTrack(ctx, track, w, h, dpr) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3.2 * dpr;
    const last = track.length - 1;
    for (let i = 1; i < track.length; i++) {
      const t = i / last;
      const flying = track[i].fly;
      ctx.strokeStyle = flying ? '#7b4fd6' : `rgb(${Math.round(43 + t * 197)},${Math.round(143 + t * 20)},${Math.round(214 - t * 161)})`;
      ctx.setLineDash(flying ? [7 * dpr, 5 * dpr] : []);
      ctx.beginPath();
      ctx.moveTo(track[i - 1].u * w, track[i - 1].v * h);
      ctx.lineTo(track[i].u * w, track[i].v * h);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ——— 3D: flags, sky, shrubs ———
  function makeKiteTexture(colour) {
    const canvas = document.createElement('canvas');
    canvas.width = 384;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 384, 128);
    ctx.fillStyle = colour;
    for (let f = 0; f < 3; f++) {
      const x = f * 128;
      ctx.beginPath();
      ctx.moveTo(x, 128);
      ctx.lineTo(x + 128, 128);
      ctx.lineTo(x + 128, 0);
      ctx.closePath();
      ctx.fill();
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  // The note wedged in the cairn: the control number and its grid reference.
  function makeNoteTexture(point) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 160;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fbf8ee';
    ctx.fillRect(0, 0, 256, 160);
    ctx.strokeStyle = 'rgba(80,110,160,.25)';
    for (let y = 46; y < 160; y += 22) { ctx.beginPath(); ctx.moveTo(10, y); ctx.lineTo(246, y); ctx.stroke(); }
    ctx.fillStyle = '#c2187a';
    ctx.font = '700 54px Heebo, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(String(point.number), 128, 64);
    ctx.fillStyle = '#26323b';
    ctx.font = '700 30px Arial, sans-serif';
    ctx.fillText(coordOf(point), 128, 122);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  // רוג׳ום: a small pile of irregular stones with a note sticking out of the top.
  // Size: a real cairn is ~1 m; it grows a little on big maps so it can be found.
  function makeCairn(point, index, size) {
    const group = new THREE.Group();
    const rand = random(0xc0ffee + index * 7919);
    const rockGeometry = new THREE.DodecahedronGeometry(1, 0);
    const materials = [];
    // The top layer has two stones either side, leaving a gap the note stands in.
    const layers = [[6, .62, .0], [4, .44, .34], [2, .3, .62]];
    for (const [count, radius, height] of layers) {
      for (let k = 0; k < count; k++) {
        const angle = (k / count) * Math.PI * 2 + rand() * .6;
        const spread = count === 1 ? 0 : radius * .55;
        const shade = .5 + rand() * .22;
        const material = new THREE.MeshStandardMaterial({ color: new THREE.Color(shade * 1.04, shade, shade * .9), roughness: .95, flatShading: true });
        materials.push(material);
        const rock = new THREE.Mesh(rockGeometry, material);
        const r = radius * (.35 + rand() * .2);
        rock.scale.set(r * (1 + rand() * .4), r * (.7 + rand() * .3), r * (1 + rand() * .4));
        rock.rotation.set(rand() * 3, rand() * 3, rand() * 3);
        rock.position.set(Math.cos(angle) * spread, height + r * .55, Math.sin(angle) * spread);
        rock.castShadow = true;
        group.add(rock);
      }
    }
    const noteTexture = makeNoteTexture(point);
    const noteMaterial = new THREE.MeshStandardMaterial({ map: noteTexture, emissiveMap: noteTexture, emissive: 0xffffff, emissiveIntensity: .35, side: THREE.DoubleSide, roughness: .8 });
    materials.push(noteMaterial);
    const note = new THREE.Mesh(new THREE.PlaneGeometry(.56, .35), noteMaterial);
    note.position.set(0, .96, 0); // bottom edge wedged between the top stones
    note.rotation.set(-.12, rand() * Math.PI * 2, .08);
    group.add(note);
    group.scale.setScalar(size);
    return { group, materials, note, textures: [noteTexture], geometries: [rockGeometry, note.geometry] };
  }

  // Ground height (m) on the rendered terrain triangles: with vertical exaggeration a
  // bilinear sample can float or bury objects by metres.
  const groundAt = (u, v) => (api.surfaceHeight ? api.surfaceHeight(u, v) : api.height(u, v));

  function buildWorld() {
    const scene = api.scene();
    if (!scene) return null;
    const group = new THREE.Group();
    group.name = 'nav-game';
    const extent = api.extent();
    const mtw = api.metersToWorld();
    const W = api.worldSize();
    const vs = api.verticalScale();
    const flagM = Math.max(4, extent * .0022); // start/finish flags: exaggerated "symbol" size
    const cairnM = Math.max(1.6, extent * .0008); // cairn height in metres (≈3 m on a 4 km map)
    const extras = { textures: [], geometries: [] };
    const orange = makeKiteTexture('#f26a21');
    const magenta = makeKiteTexture(COURSE_COLOR);
    const flags = [];
    const kiteGeometry = new THREE.CylinderGeometry(flagM / Math.sqrt(3), flagM / Math.sqrt(3), flagM, 3, 1, true);
    const poleGeometry = new THREE.CylinderGeometry(flagM * .035, flagM * .035, flagM * 2.3, 6);
    points.forEach((point, index) => {
      if (index === 0 && !points.at(-1).implicit) return; // start without a finish flag of its own
      if (point.kind === 'finish' && point.implicit) return; // shared with the start flag
      if (point.kind === 'control') {
        const cairn = makeCairn(point, index, cairnM);
        cairn.group.scale.multiplyScalar(mtw);
        cairn.group.position.set((point.u - .5) * W, (api.surfaceHeight ? api.surfaceHeight(point.u, point.v) : api.height(point.u, point.v)) * vs, (point.v - .5) * W);
        cairn.group.userData = { index, materials: cairn.materials, kite: cairn.note, cairn: true };
        extras.textures.push(...cairn.textures);
        extras.geometries.push(...cairn.geometries);
        group.add(cairn.group);
        flags.push(cairn.group);
        return;
      }
      const texture = point.kind === 'control' ? orange : magenta;
      const kiteMaterial = new THREE.MeshStandardMaterial({ map: texture, emissiveMap: texture, emissive: 0xffffff, emissiveIntensity: .18, side: THREE.DoubleSide, transparent: true, roughness: .55 });
      const poleMaterial = new THREE.MeshStandardMaterial({ color: 0xe8e6dc, transparent: true, roughness: .4, metalness: .2 });
      const flag = new THREE.Group();
      const kite = new THREE.Mesh(kiteGeometry, kiteMaterial);
      kite.position.y = flagM * 1.75;
      const pole = new THREE.Mesh(poleGeometry, poleMaterial);
      pole.position.y = flagM * 1.15;
      flag.add(kite, pole);
      flag.scale.setScalar(mtw);
      flag.position.set((point.u - .5) * W, groundAt(point.u, point.v) * vs, (point.v - .5) * W);
      flag.userData = { index, materials: [kiteMaterial, poleMaterial], kite };
      group.add(flag);
      flags.push(flag);
    });

    // Sky dome that follows the camera. By day it is the plain gradient with the sun; at dusk
    // and at night sky.js drives the colours, the twilight glow, the sun and a phased moon.
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
          top: { value: new THREE.Color(0x4f8fc9) },
          horizon: { value: new THREE.Color(0xdfe9e2) },
          bottom: { value: new THREE.Color(0xb9c6b0) },
          glow: { value: new THREE.Color(0x000000) },
          sun: { value: new THREE.Vector3(-.45, .55, .5).normalize() },
          sunDisc: { value: 1 },
          moon: { value: new THREE.Vector3(0, -1, 0) },
          moonDisc: { value: 0 },
          moonHalo: { value: 0 },
          moonCos: { value: Math.cos(1.1 * Math.PI / 180) },
          moonSin: { value: Math.sin(1.1 * Math.PI / 180) },
        },
        vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 bottom; uniform vec3 glow; uniform vec3 sun; uniform float sunDisc;
          uniform vec3 moon; uniform float moonDisc; uniform float moonHalo; uniform float moonCos; uniform float moonSin;
          varying vec3 vDir;
          void main(){
            vec3 d = normalize(vDir);
            float h = d.y;
            vec3 c = h > 0.0 ? mix(horizon, top, pow(min(h * 1.6, 1.0), .75)) : mix(horizon, bottom, min(-h * 6.0, 1.0));
            // Twilight: a warm band over the horizon on the sun's side.
            float sl = length(sun.xz);
            float side = sl > 1e-4 ? dot(normalize(d.xz + vec2(1e-5)), sun.xz / sl) * .5 + .5 : .5;
            c += glow * pow(side, 3.0) * (1.0 - smoothstep(0.0, .45, abs(h)));
            float s = max(dot(d, sun), 0.0);
            c += vec3(1.0, .92, .75) * (pow(s, 220.0) * 1.2 + pow(s, 12.0) * .18) * sunDisc;
            // The moon: a ball lit by the sun, so its phase and the tilt of the crescent are real.
            float cm = dot(d, moon);
            c += vec3(.5, .58, .78) * pow(max(cm, 0.0), 90.0) * moonHalo;
            if (moonDisc > 0.0 && cm > moonCos - .00002) {
              vec3 t = (d - moon * cm) / moonSin;
              float r2 = min(dot(t, t), 1.0);
              vec3 n = t - moon * sqrt(1.0 - r2);
              float lit = smoothstep(-.04, .08, dot(n, sun));
              float sea = max(0.0, sin(n.x * 5.2 + 1.1) * sin(n.y * 4.3 - .4)) * .16;
              vec3 surface = mix(vec3(.04, .05, .08), vec3(.98, .96, .88) * (.8 + .2 * sqrt(1.0 - r2)) * (1.0 - sea), lit);
              c += surface * moonDisc * (1.0 - smoothstep(.9, 1.0, sqrt(r2)));
            }
            gl_FragColor = vec4(c, 1.0);
          }`,
      }),
    );
    sky.frustumCulled = false;
    sky.renderOrder = -10;
    sky.scale.setScalar(120);
    group.add(sky);

    // Shrubs and a few trees: give a sense of scale and motion. Kept clear of the controls.
    const rand = random(0x5eed + api.mapSize());
    const reach = reachRadiusMeters(extent);
    const shrubCount = Math.min(3600, Math.round(520 * (extent / 1000) ** 2));
    const shrubs = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ flatShading: true, roughness: 1 }), shrubCount);
    const trees = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 3.2, 7), new THREE.MeshStandardMaterial({ flatShading: true, roughness: .95 }), Math.round(shrubCount / 5));
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const colour = new THREE.Color();
    const place = (mesh, count, sizeFn, colourFn, lift) => {
      let placed = 0;
      for (let i = 0; i < count * 3 && placed < count; i++) {
        const u = rand();
        const v = rand();
        if (points.some((p) => distanceMeters(p, { u, v }, extent) < reach * 1.2)) continue;
        const size = sizeFn();
        quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * Math.PI * 2);
        matrix.compose(
          new THREE.Vector3((u - .5) * W, groundAt(u, v) * vs + size.y * lift * mtw, (v - .5) * W),
          quaternion,
          new THREE.Vector3(size.x * mtw, size.y * mtw, size.x * mtw),
        );
        mesh.setMatrixAt(placed, matrix);
        mesh.setColorAt(placed, colourFn());
        placed++;
      }
      mesh.count = placed;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    };
    place(shrubs, shrubCount, () => { const r = 1.1 + rand() * 1.7; return { x: r, y: r * .72 }; },
      () => colour.setHSL(.24 + rand() * .07, .38 + rand() * .2, .2 + rand() * .1), .45);
    place(trees, trees.count, () => { const r = 1.6 + rand() * 1.4; return { x: r, y: r * 1.25 }; },
      () => colour.setHSL(.3 + rand() * .05, .35 + rand() * .15, .16 + rand() * .07), 1.45);
    shrubs.frustumCulled = false;
    trees.frustumCulled = false;
    group.add(shrubs, trees);

    // Drone mode: a soft dark disc on the ground under the drone (helps judge height).
    const droneShadow = new THREE.Mesh(
      new THREE.CircleGeometry(1, 28).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x0b1410, transparent: true, opacity: .4, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
    );
    droneShadow.visible = false;
    droneShadow.renderOrder = 3;
    group.add(droneShadow);

    // Dusk and night: stars that turn with the sky, and a headlamp.
    let stars = null;
    let lamp = null;
    let lampTarget = null;
    let spill = null;
    if (timeOption !== 'day') {
      stars = buildStars();
      group.add(stars);
      lamp = new THREE.SpotLight(0xfff1dc, 0, lampRange() * mtw, .5, .45, 0);
      lampTarget = new THREE.Object3D();
      lamp.target = lampTarget;
      spill = new THREE.PointLight(0xffeedd, 0, 22 * mtw, 0);
      group.add(lamp, lampTarget, spill);
    }
    const camels = buildCamels(group, CAMEL.counts[camelsOption] || 0);

    scene.add(group);
    return { group, flags, sky, droneShadow, stars, starBasis: new THREE.Matrix4(), lamp, lampTarget, spill, camels, textures: [orange, magenta, ...extras.textures] };
  }

  const lampRange = () => Math.max(60, api.extent() * .025); // metres lit ahead
  // Bigger on big maps, like the cairns, so a herd is visible from a few hundred metres.
  const camelScale = () => clamp(api.extent() / 1600, 1, 3);

  // Stars as points on a sphere around the camera: random faint ones plus the bright stars
  // of sky.js at their real places, so Polaris marks north. Hidden behind the moon.
  function buildStars() {
    const rand = random(0x5747);
    const list = [];
    for (let i = 0; i < 1400; i++) {
      const z = rand() * 2 - 1;
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(1 - z * z);
      list.push({ x: r * Math.cos(a), y: r * Math.sin(a), z, mag: 2.6 + 3.4 * Math.sqrt(rand()), tint: rand() });
    }
    for (const [, ra, dec, mag] of BRIGHT_STARS) list.push({ ...starVector(ra, dec), mag, tint: .5 });
    const positions = new Float32Array(list.length * 3);
    const colours = new Float32Array(list.length * 3);
    const sizes = new Float32Array(list.length);
    list.forEach((star, i) => {
      positions.set([star.x * 90, star.y * 90, star.z * 90], i * 3);
      const brightness = clamp(1.3 - star.mag * .17, .12, 1.5);
      const tint = star.tint < .15 ? [.75, .85, 1] : star.tint > .88 ? [1, .88, .72] : [1, 1, 1];
      colours.set(tint.map((c) => c * brightness), i * 3);
      sizes[i] = clamp(4.6 - star.mag * .8, 1.1, 6);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('starColor', new THREE.BufferAttribute(colours, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        opacity: { value: 0 },
        moon: { value: new THREE.Vector3(0, -1, 0) },
        moonCos: { value: Math.cos(1.5 * Math.PI / 180) },
        scale: { value: Math.min(window.devicePixelRatio || 1, 2) },
      },
      vertexShader: `attribute float size; attribute vec3 starColor; uniform vec3 moon; uniform float moonCos; uniform float scale; varying vec3 vColor;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vec3 dir = normalize(world.xyz - cameraPosition);
          vColor = starColor * (1.0 - step(moonCos, dot(dir, moon)));
          gl_PointSize = size * scale;
          gl_Position = projectionMatrix * viewMatrix * world;
        }`,
      fragmentShader: `uniform float opacity; varying vec3 vColor;
        void main() { float d = length(gl_PointCoord - .5); gl_FragColor = vec4(vColor * opacity * smoothstep(.5, .15, d), 1.0); }`,
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.renderOrder = -9;
    points.matrixAutoUpdate = false; // position (the camera) and rotation (the sky) set each frame
    points.visible = false;
    return points;
  }

  // Low-poly dromedaries (metres, facing −z, feet at y = 0). Legs and neck are pivots so they
  // can walk — pacing, both legs on one side together — graze and raise their heads.
  function buildCamels(group, count) {
    if (!count) return [];
    const sphere = (sx, sy, sz, x, y, z) => new THREE.SphereGeometry(1, 12, 8).scale(sx, sy, sz).translate(x, y, z);
    const torso = mergeGeometries([
      sphere(.42, .4, .86, 0, 1.45, 0),
      sphere(.3, .4, .42, 0, 1.78, .1),
      sphere(.22, .24, .28, 0, 1.36, -.7),
      new THREE.CylinderGeometry(.025, .05, .55, 5).rotateX(.35).translate(0, 1.2, .9),
    ]);
    const neck = mergeGeometries([
      new THREE.CylinderGeometry(.09, .15, 1, 7).translate(0, .5, 0).rotateX(-.72),
      new THREE.BoxGeometry(.2, .21, .5).translate(0, 0, -.2).rotateX(.25).translate(0, .78, -.7),
      new THREE.ConeGeometry(.04, .13, 4).translate(-.08, .93, -.6),
      new THREE.ConeGeometry(.04, .13, 4).translate(.08, .93, -.6),
    ]);
    const eye = new THREE.SphereGeometry(.06, 6, 4);
    const leg = new THREE.CylinderGeometry(.075, .05, 1.3, 6).translate(0, -.65, 0);
    const scale = camelScale() * api.metersToWorld();
    // A soft contact shadow (the sun's shadow map is far too coarse for a camel on a big map).
    const shadowGeometry = new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2);
    const shadowMaterial = new THREE.MeshBasicMaterial({ color: 0x0b1410, transparent: true, opacity: .32, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    const list = [];
    // Coats from sandy to dark brown: darker than the grass so a herd stands out.
    const coats = [0x9a6b3c, 0xb07a44, 0x7e5530, 0xa8743f];
    for (let i = 0; i < count; i++) {
      const coat = new THREE.Color(coats[i % coats.length]);
      const body = new THREE.MeshStandardMaterial({ color: coat, roughness: .95, flatShading: true });
      const legs = new THREE.MeshStandardMaterial({ color: coat.clone().multiplyScalar(.82), roughness: .95, flatShading: true });
      const eyeMaterial = new THREE.MeshBasicMaterial({ color: 0xd9ffc8, transparent: true, opacity: 0, toneMapped: false, depthWrite: false, blending: THREE.AdditiveBlending });
      const root = new THREE.Group();
      root.add(new THREE.Mesh(torso, body));
      const neckPivot = new THREE.Group();
      neckPivot.position.set(0, 1.5, -.7);
      neckPivot.add(new THREE.Mesh(neck, body));
      const eyeGroup = new THREE.Group();
      for (const x of [-.105, .105]) {
        const ball = new THREE.Mesh(eye, eyeMaterial);
        ball.position.set(x, .84, -.84);
        eyeGroup.add(ball);
      }
      eyeGroup.visible = false;
      neckPivot.add(eyeGroup);
      root.add(neckPivot);
      const hips = [[-.21, -.52], [.21, -.52], [-.21, .55], [.21, .55]].map(([x, z]) => {
        const hip = new THREE.Group();
        hip.position.set(x, 1.3, z);
        hip.add(new THREE.Mesh(leg, legs));
        root.add(hip);
        return hip;
      });
      root.scale.setScalar(scale);
      root.visible = false;
      const shadow = new THREE.Mesh(shadowGeometry, shadowMaterial);
      shadow.renderOrder = 3;
      shadow.visible = false;
      group.add(root, shadow);
      list.push({ root, shadow, neck: neckPivot, legs: hips, eyes: eyeGroup, eyeMaterial, data: null, pose: -1.4 });
    }
    return list;
  }

  // Valley score on a coarse grid (a window of about 250 m: wadis, not single bumps).
  function ensureValleyGrid() {
    if (world.valley) return;
    const n = 64;
    const heights = new Float32Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) heights[y * n + x] = api.height(x / (n - 1), y / (n - 1));
    world.valleyN = n;
    world.valley = valleyScore(heights, n, clamp(Math.round(250 / (api.extent() / (n - 1))), 2, 10));
  }

  function spawnWorldCamels() {
    if (!world?.camels?.length) return;
    ensureValleyGrid();
    camelRng = random((Math.random() * 2 ** 32) >>> 0);
    // Mostly in the valleys along the course, so a navigation actually meets them.
    const data = spawnCamels({
      score: world.valley, n: world.valleyN, count: world.camels.length, rng: camelRng, extent: api.extent(),
      avoid: [points[0]], route: points, clearOf: points.slice(1),
    });
    world.camels.forEach((camel, i) => {
      camel.data = data[i] || null;
      camel.root.visible = Boolean(camel.data);
      camel.shadow.visible = Boolean(camel.data);
      camel.pose = -1.4;
    });
  }

  function disposeWorld() {
    if (!world) return;
    world.group.parent?.remove(world.group);
    world.group.traverse((object) => {
      object.geometry?.dispose();
      const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
      materials.forEach((m) => m.dispose());
    });
    world.textures.forEach((t) => t.dispose());
    world = null;
  }

  function updateFlags() {
    if (!world) return;
    const extent = api.extent();
    const visible = reachRadiusMeters(extent) * 7;
    const o = api.observer;
    for (const flag of world.flags) {
      const point = points[flag.userData.index];
      const d = distanceMeters(o, point, extent);
      const opacity = clamp((visible - d) / (visible * .35), 0, 1);
      flag.visible = opacity > .01;
      const punched = flag.userData.index < run.next && flag.userData.index !== 0;
      const alpha = opacity * (punched ? .45 : 1);
      for (const material of flag.userData.materials) {
        // Only blend while fading: permanently transparent stones look ghostly.
        const transparent = alpha < .99;
        if (material.transparent !== transparent) { material.transparent = transparent; material.needsUpdate = true; }
        material.opacity = alpha;
      }
      if (run.night) {
        // At night the notes and flags only shine back when the headlamp points at them.
        const material = flag.userData.kite.material;
        let shine = (flag.userData.cairn ? .35 : .18) * (run.sky?.daylight ?? 1);
        if (run.lamp && d < lampRange() * 4) {
          const camera = api.camera();
          toObject.subVectors(flag.position, camera.position).normalize();
          const inBeam = toObject.dot(camera.getWorldDirection(viewDir));
          shine = Math.max(shine, 1.6 * clamp((inBeam - .9) / .06, 0, 1));
        }
        material.emissiveIntensity = shine;
      }
      if (!flag.userData.cairn) flag.userData.kite.rotation.y += .004;
      else {
        // The note turns towards the walker so it can always be read.
        const camera = api.camera();
        const note = flag.userData.kite;
        const dx = camera.position.x - flag.position.x;
        const dz = camera.position.z - flag.position.z;
        note.rotation.set(-.12, Math.atan2(dx, dz), .06);
      }
    }
  }

  // ——— Compass tape ———
  function buildCompass() {
    const tape = $('navCompassTape');
    let html = '';
    for (let deg = -360; deg <= 720; deg += 5) {
      const x = deg * COMPASS_PX;
      const norm = ((deg % 360) + 360) % 360;
      html += `<i class="${norm % 15 === 0 ? 'major' : ''}" style="left:${x}px"></i>`;
      if (CARDINALS[norm] !== undefined) html += `<span class="cardinal${norm === 0 ? ' north' : ''}" style="left:${x}px">${CARDINALS[norm]}</span>`;
      else if (norm % 30 === 0) html += `<span style="left:${x}px">${norm}</span>`;
    }
    tape.innerHTML = html;
  }

  function updateCompass() {
    const o = api.observer;
    $('navCompassTape').style.transform = `translateX(${-o.heading * COMPASS_PX}px)`;
    $('navHeadingReadout').textContent = `${Math.round(o.heading) % 360}°`;
    const target = $('navCompassTarget');
    const next = points[run.next];
    if (!settings.showBearing || !next) { target.hidden = true; return; }
    const delta = ((bearingDegrees(o, next) - o.heading + 540) % 360) - 180;
    const half = $('navCompass').clientWidth / 2 / COMPASS_PX - 4;
    target.hidden = false;
    target.style.transform = `translateX(${clamp(delta, -half, half) * COMPASS_PX}px)`;
    target.style.opacity = Math.abs(delta) > half ? .5 : 1;
  }

  // ——— Sound ———
  function beep(notes) {
    if (!soundOn) return;
    try {
      audio ||= new (window.AudioContext || window.webkitAudioContext)();
      let t = audio.currentTime;
      for (const [freq, length] of notes) {
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        osc.type = 'triangle';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(.0001, t);
        gain.gain.exponentialRampToValueAtTime(.18, t + .015);
        gain.gain.exponentialRampToValueAtTime(.0001, t + length);
        osc.connect(gain).connect(audio.destination);
        osc.start(t);
        osc.stop(t + length + .02);
        t += length * .8;
      }
    } catch { /* audio unavailable */ }
  }
  function syncSoundButton() {
    $('navSoundBtn').setAttribute('aria-pressed', String(soundOn));
    $('navSoundBtn').title = soundOn ? 'השתקת צלילים' : 'הפעלת צלילים';
  }
  $('navSoundBtn').addEventListener('click', () => { soundOn = !soundOn; writeStorage(SOUND_KEY, soundOn); syncSoundButton(); });

  // ——— Run lifecycle ———
  function resetRun() {
    const startPoint = points[0];
    run = {
      next: 1, elapsed: 0, legStart: 0, walked: 0, ascent: 0, legWalked: 0, legAscent: 0,
      peeks: 0, peekOpen: false, expanded: false, splits: [], track: [{ u: startPoint.u, v: startPoint.v }],
      trackClock: 0, warned: new Set(), pace: 1, grade: 0, bob: 0, keysFade: 6, flashTimer: null,
      // Drone mode: altitudes in display metres (terrain height × exaggeration).
      drone: false, landing: false, droneUsed: false, flown: 0, battery: 100, altitude: 0, target: 0,
      droneTime: 0, droneSpeed: 0, lowWarned: false,
      // FPV racing mode (on top of the drone): momentum, banking, tricks.
      fpv: false, vel: { x: 0, y: 0, z: 0 }, roll: 0, fov: 92, shake: 0, maxSpeed: 0, tricks: 0, trick: null, crashes: 0, crashCool: 0, throttle: 0, boosting: false,
      // Camels (camels.js): catches cost time and leave you stunned for a moment.
      stun: 0, camelCatches: 0, camelEscapes: 0, chases: 0, camelTalk: -99, camelFlash: -99, camelSpotted: false,
      // Dusk / night (sky.js): a sky clock that runs as fast as the walking (≥ ×12).
      night: timeOption !== 'day', clock: startClockFor(), startClock: startClockFor(),
      timeScale: clamp(baseSpeed(api.extent()) / 1.4, 12, 30), lamp: false, lampHinted: false, skyTimer: 0, sky: null,
    };
    setDroneUi(false);
    spawnWorldCamels();
    configureNightUI();
    Object.assign(api.observer, { u: startPoint.u, v: startPoint.v, heading: 0, tilt: -4, bob: 0 });
  }

  function configureNightUI() {
    document.body.classList.toggle('nav-night', run.night);
    $('navLampBtn').hidden = !run.night;
    $('navClock').hidden = !run.night;
    setLamp(false, true);
    if (run.night && world) applySky(skyState(run.clock, moonDay));
    else api.setLighting?.(null);
  }

  function applySky(state) {
    run.sky = state;
    const u = world.sky.material.uniforms;
    // Display values, passed through as-is (see sky.js).
    u.top.value.setRGB(...state.sky.top);
    u.horizon.value.setRGB(...state.sky.horizon);
    u.bottom.value.setRGB(...state.sky.bottom);
    u.glow.value.setRGB(...state.sky.glow);
    u.sun.value.set(state.sun.x, state.sun.y, state.sun.z);
    u.sunDisc.value = state.sunDisc;
    u.moon.value.set(state.moon.x, state.moon.y, state.moon.z);
    u.moonDisc.value = state.moonDisc;
    u.moonHalo.value = state.moonHalo;
    if (world.stars) {
      const m = world.stars.material.uniforms;
      m.opacity.value = state.stars;
      m.moon.value.copy(u.moon.value);
      world.stars.visible = state.stars > .01;
      const [ex, ey, ez] = skyBasis(state.lst);
      world.starBasis.set(ex.x, ey.x, ez.x, 0, ex.y, ey.y, ez.y, 0, ex.z, ey.z, ez.z, 0, 0, 0, 0, 1);
    }
    api.setLighting?.(state);
  }

  // The sky clock runs while navigating; the sky is recomputed a few times a second.
  function advanceClock(dt) {
    run.clock += dt * run.timeScale / 3600;
    run.skyTimer -= dt;
    if (run.skyTimer > 0) return;
    run.skyTimer = .25;
    applySky(skyState(run.clock, moonDay));
    if (!run.lamp && !run.lampHinted && run.sky.dark > .8 && run.sky.moonlight < .45) {
      run.lampHinted = true;
      flash('🔦 חשוך! L (או כפתור הפנס) מדליק פנס ראש');
    }
  }

  function setLamp(on, quiet = false) {
    if (!run) return;
    run.lamp = Boolean(on && run.night);
    $('navLampBtn').setAttribute('aria-pressed', String(run.lamp));
    $('navLampBtn').classList.toggle('on', run.lamp);
    if (!quiet) beep([[run.lamp ? 1500 : 950, .035]]);
  }

  // Stars and the headlamp follow the camera.
  function updateNightObjects() {
    if (!world) return;
    const camera = api.camera();
    if (world.stars?.visible) {
      world.stars.matrix.copy(world.starBasis).setPosition(camera.position);
      world.stars.matrixWorldNeedsUpdate = true;
    }
    if (world.lamp) {
      camera.getWorldDirection(lampDir);
      lampDir.y -= .3;
      lampDir.normalize();
      world.lamp.position.copy(camera.position);
      world.lampTarget.position.copy(camera.position).addScaledVector(lampDir, lampRange() * api.metersToWorld());
      world.lampTarget.updateMatrixWorld();
      world.lamp.intensity = run?.lamp ? LAMP_INTENSITY : 0;
      world.spill.position.copy(camera.position);
      world.spill.intensity = run?.lamp ? SPILL_INTENSITY : 0;
    }
  }

  // ——— Camels ———
  // How far camels notice you: less in the dark, more with a headlamp on.
  function camelVisibility() {
    if (!run.night) return 1;
    if (run.lamp) return 1.5;
    return .5 + .5 * Math.max(run.sky?.daylight ?? 1, (run.sky?.moonlight ?? 0) * .7);
  }

  function stepCamels(dt) {
    const o = api.observer;
    const extent = api.extent();
    const ctx = {
      dt, extent, walkSpeed: baseSpeed(extent), rng: camelRng,
      player: { u: o.u, v: o.v, onFoot: !run.drone, visibility: camelVisibility() },
      heightAt: api.height,
      scoreAt: (u, v) => sampleGrid(world.valley, world.valleyN, u, v),
    };
    const active = world.camels.filter((camel) => camel.data);
    for (const camel of active) {
      const event = stepCamel(camel.data, ctx);
      if (event) onCamelEvent(event);
    }
    separateCamels(active.map((camel) => camel.data), 4 * camelScale(), extent);
  }

  function onCamelEvent(event) {
    const now = run.elapsed;
    if (event === 'alert') {
      if (now - run.camelTalk > 4) { run.camelTalk = now; growl(.45); }
    } else if (event === 'chase') {
      run.chases++;
      growl(1);
      if (now - run.camelFlash > 5) { run.camelFlash = now; flash('🐪 גמל רודף אחריכם! רוצו (Shift)', true); }
    } else if (event === 'caught') {
      run.camelCatches++;
      run.stun = 1.3;
      growl(1.2);
      spitSound();
      const spit = $('navSpit');
      spit.classList.remove('hit');
      void spit.offsetWidth;
      spit.classList.add('hit');
      run.camelFlash = now;
      flash(`🐪 הגמל השיג אתכם וירק! +${CAMEL_PENALTY} ש׳`, true);
      updatePeekUI();
    } else if (event === 'escaped') {
      run.camelEscapes++;
      if (now - run.camelFlash > 3) { run.camelFlash = now; flash('😅 ברחתם מהגמל!'); }
    }
  }

  function updateCamelMeshes(dt) {
    if (!world?.camels?.length) return;
    const W = api.worldSize();
    const vs = api.verticalScale();
    const mtw = api.metersToWorld();
    const scale = camelScale();
    const walk = baseSpeed(api.extent());
    const camera = api.camera();
    const lampOn = run?.night && run.lamp;
    if (lampOn) camera.getWorldDirection(viewDir);
    for (const camel of world.camels) {
      const c = camel.data;
      if (!c) continue;
      const root = camel.root;
      const moving = clamp(c.speed / (walk * .15), 0, 1);
      const phase = c.gait / (2.2 * scale) * Math.PI * 2;
      const swing = (c.state === 'chase' ? .62 : .38) * moving;
      camel.legs.forEach((hip, i) => { hip.rotation.x = Math.sin(phase + (i % 2 ? Math.PI : 0)) * swing; });
      root.position.set((c.u - .5) * W, groundAt(c.u, c.v) * vs + Math.abs(Math.sin(phase)) * .06 * scale * mtw * moving, (c.v - .5) * W);
      root.rotation.y = -c.heading * Math.PI / 180;
      // Shadow: an ellipse along the body, tilted to the (displayed) slope.
      const e = 3 / api.extent();
      const gx = (groundDisplay(clamp(c.u + e, 0, 1), c.v) - groundDisplay(clamp(c.u - e, 0, 1), c.v)) / 6;
      const gz = (groundDisplay(c.u, clamp(c.v + e, 0, 1)) - groundDisplay(c.u, clamp(c.v - e, 0, 1))) / 6;
      shadowNormal.set(-gx, 1, -gz).normalize();
      camel.shadow.quaternion.setFromUnitVectors(UP, shadowNormal).multiply(headingTurn.setFromAxisAngle(UP, -c.heading * Math.PI / 180));
      camel.shadow.position.set(root.position.x, groundAt(c.u, c.v) * vs + .15 * mtw, root.position.z);
      camel.shadow.scale.set(.75 * scale * mtw, 1, 1.35 * scale * mtw);
      const pose = c.state === 'alert' ? .38 : c.state === 'chase' ? -.22 : moving > .2 ? -.38 : -1.4;
      camel.pose += (pose - camel.pose) * Math.min(1, dt * 3);
      camel.neck.rotation.x = camel.pose;
      // Eyeshine: caught in the headlamp, a camel's eyes glow back.
      let glow = 0;
      if (lampOn) {
        toObject.subVectors(root.position, camera.position);
        const distance = toObject.length() / mtw;
        toObject.normalize();
        const inBeam = toObject.dot(viewDir);
        const h = c.heading * Math.PI / 180;
        const facing = -(Math.sin(h) * toObject.x - Math.cos(h) * toObject.z);
        if (inBeam > .86 && facing > .2 && distance < lampRange() * 5) glow = clamp((inBeam - .86) / .08, 0, 1) * clamp(facing * 1.5, 0, 1);
      }
      camel.eyes.visible = glow > .02;
      camel.eyeMaterial.opacity = glow;
      for (const ball of camel.eyes.children) ball.scale.setScalar(1 + glow * 1.8); // a glint you can spot from afar
    }
  }

  // Warning chip and a 🐪 on the compass while one is chasing you.
  function updateCamelAlert() {
    const chip = $('navCamelAlert');
    const marker = $('navCompassCamel');
    let nearest = null;
    if (world?.camels?.length && !run.drone) {
      const extent = api.extent();
      let closest = null;
      for (const camel of world.camels) {
        if (!camel.data) continue;
        const d = metersBetween(camel.data, api.observer, extent);
        if (!closest || d < closest.d) closest = { camel: camel.data, d };
        if (camel.data.state !== 'chase') continue;
        if (!nearest || d < nearest.d) nearest = { camel: camel.data, d };
      }
      // The first herd you come near: say where it is, once per run.
      if (!run.camelSpotted && closest && closest.d < detectRadius(extent) * 2.2 && phase === 'running') {
        run.camelSpotted = true;
        flash(`🐪 גמלים ב${directionName(bearingDegrees(api.observer, closest.camel))}, ${Math.round(closest.d)} מ׳ מכם. בהליכה הם ישיגו אתכם, בריצה לא`);
      }
    }
    chip.hidden = !nearest;
    marker.hidden = !nearest;
    if (!nearest) return;
    chip.textContent = `🐪 גמל רודף אחריכם · ${Math.round(nearest.d)} מ׳`;
    chip.classList.toggle('near', nearest.d < detectRadius(api.extent()) * .35);
    const o = api.observer;
    const delta = ((bearingDegrees(o, nearest.camel) - o.heading + 540) % 360) - 180;
    const half = $('navCompass').clientWidth / 2 / COMPASS_PX - 4;
    marker.style.transform = `translateX(${clamp(delta, -half, half) * COMPASS_PX}px)`;
  }

  function growl(strength = 1) {
    if (!soundOn) return;
    try {
      audio ||= new (window.AudioContext || window.webkitAudioContext)();
      const t = audio.currentTime;
      const osc = audio.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(96, t);
      osc.frequency.linearRampToValueAtTime(68, t + .65);
      const wobble = audio.createOscillator();
      wobble.frequency.value = 17;
      const depth = audio.createGain();
      depth.gain.value = 24;
      wobble.connect(depth).connect(osc.frequency);
      const filter = audio.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 640;
      const gain = audio.createGain();
      gain.gain.setValueAtTime(.0001, t);
      gain.gain.exponentialRampToValueAtTime(.15 * strength, t + .06);
      gain.gain.exponentialRampToValueAtTime(.0001, t + .75);
      osc.connect(filter).connect(gain).connect(audio.destination);
      osc.start(t);
      wobble.start(t);
      osc.stop(t + .8);
      wobble.stop(t + .8);
    } catch { /* audio unavailable */ }
  }

  function spitSound() {
    if (!soundOn) return;
    try {
      audio ||= new (window.AudioContext || window.webkitAudioContext)();
      const length = .28;
      const buffer = audio.createBuffer(1, Math.round(audio.sampleRate * length), audio.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 2;
      const source = audio.createBufferSource();
      source.buffer = buffer;
      const filter = audio.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 1700;
      filter.Q.value = .8;
      const gain = audio.createGain();
      gain.gain.value = .35;
      source.connect(filter).connect(gain).connect(audio.destination);
      source.start(audio.currentTime + .3);
    } catch { /* audio unavailable */ }
  }

  function start() {
    if (!course || points.length < 3) return;
    api.enter({ exaggeration: relief });
    disposeWorld();
    world = buildWorld();
    buildCompass();
    syncSoundButton();
    resetRun();
    hud.hidden = false;
    $('navKeys').classList.remove('faded');
    configureMapUI();
    renderProgressDots();
    api.updateCamera();
    beginCountdown();
  }

  function beginCountdown() {
    phase = 'countdown';
    const box = $('navCountdown');
    box.hidden = false;
    let n = 3;
    const tick = () => {
      if (phase !== 'countdown') return;
      if (n === 0) {
        box.hidden = true;
        phase = 'running';
        beep([[880, .25]]);
        return;
      }
      box.innerHTML = `<span>${n}</span>`;
      beep([[520, .12]]);
      n--;
      countdownTimer = setTimeout(tick, 800);
    };
    tick();
    api.invalidate();
  }

  function configureMapUI() {
    setTimeout(refreshMapCard, 50);
    const mode = settings.mapMode;
    run.expanded = false;
    mapCard.classList.remove('expanded', 'peeking');
    mapCard.hidden = mode !== 'always';
    mapCard.classList.toggle('above-peek', mode === 'peek');
    hud.classList.remove('peek-open');
    $('navPeekBtn').hidden = mode !== 'peek';
    $('navMapNote').textContent = mode === 'peek' ? `+${PEEK_PENALTY} ש׳ לכל הצצה` : settings.showPosition ? 'המיקום שלכם מסומן' : '';
    updatePeekUI();
  }

  function updatePeekUI() {
    $('navPeekCount').textContent = run?.peeks ? `${run.peeks} הצצות` : '';
    $('navPeekBtn').querySelector('span').textContent = run?.peekOpen ? 'סגירת המפה' : 'הצצה במפה';
    const peeks = (run?.peeks || 0) * PEEK_PENALTY;
    const camels = (run?.camelCatches || 0) * CAMEL_PENALTY;
    $('navPenalty').hidden = !(peeks + camels);
    $('navPenalty').textContent = `עונש: ${[peeks ? `הצצות +${peeks} ש׳` : '', camels ? `🐪 +${camels} ש׳` : ''].filter(Boolean).join(' · ')}`;
  }

  // Seconds added to the clock: map peeks and camel catches.
  const penaltySeconds = () => (run ? run.peeks * PEEK_PENALTY + run.camelCatches * CAMEL_PENALTY : 0);

  // Phones show the map as a thumbnail that opens into a large sheet on tap.
  const compactLayout = matchMedia('(max-width: 640px), (pointer: coarse) and (max-height: 500px)');
  function setExpanded(value) {
    run.expanded = value;
    mapCard.classList.toggle('expanded', value);
    refreshMapCard();
  }
  mapCard.addEventListener('click', (event) => {
    if (!compactLayout.matches || !run || phase !== 'running') return;
    if (event.target.closest('button')) return; // the header button has its own handler
    if (settings.mapMode === 'peek') toggleMap(); // tapping a peeked map puts it away
    else setExpanded(!run.expanded);
  });

  // Draw the map card right away (used whenever it opens or changes size).
  function refreshMapCard() {
    mapTimer = .12;
    if (run && !mapCard.hidden) requestAnimationFrame(() => drawMapInto(mapCanvas, { done: run.next, nextIndex: run.next, showYou: settings.showPosition || run.drone }));
  }

  function toggleMap() {
    if (phase !== 'running') return;
    if (settings.mapMode === 'always') {
      setExpanded(!run.expanded);
    } else if (settings.mapMode === 'peek') {
      run.peekOpen = !run.peekOpen;
      if (run.peekOpen) {
        run.peeks++;
        mapCard.hidden = false;
        mapCard.classList.add('peeking');
        setExpanded(compactLayout.matches); // on a phone a peek is only useful at full size
        beep([[330, .08]]);
      } else {
        mapCard.hidden = true;
        mapCard.classList.remove('peeking');
        setExpanded(false);
      }
      hud.classList.toggle('peek-open', run.peekOpen);
      updatePeekUI();
    }
  }
  $('navPeekBtn').addEventListener('click', toggleMap);
  $('navMapSizeBtn').addEventListener('click', () => {
    if (settings.mapMode === 'peek' && compactLayout.matches) toggleMap(); // phone: the header button closes the peek
    else if (settings.mapMode === 'peek') setExpanded(!run.expanded);
    else toggleMap();
  });

  function pause() {
    if (phase !== 'running' && phase !== 'countdown') return;
    clearTimeout(countdownTimer);
    $('navCountdown').hidden = true;
    phase = 'paused';
    keys.clear();
    droneClimbInput = 0;
    stopBuzz();
    $('navPause').hidden = false;
    mapCard.dataset.wasHidden = String(mapCard.hidden);
    mapCard.hidden = true;
    $('navResumeBtn').focus();
  }
  function resume() {
    if (phase !== 'paused') return;
    $('navPause').hidden = true;
    mapCard.hidden = mapCard.dataset.wasHidden === 'true';
    refreshMapCard();
    beginCountdown();
  }
  $('navPauseBtn').addEventListener('click', pause);
  $('navResumeBtn').addEventListener('click', resume);
  $('navRestartBtn').addEventListener('click', () => { $('navPause').hidden = true; restart(); });
  $('navQuitBtn').addEventListener('click', () => { $('navPause').hidden = true; stop(); });

  function restart() {
    resultsDialog.open && resultsDialog.close();
    clearTimeout(countdownTimer);
    if (world) world.flags.forEach((f) => f.userData.materials.forEach((m) => { m.opacity = 1; }));
    if (run?.drone) { Object.assign(api.observer, { flyY: undefined, roll: 0, shake: 0, fov: undefined }); api.setDrone?.(false); }
    stopBuzz();
    resetRun();
    configureMapUI();
    renderProgressDots();
    $('navKeys').classList.remove('faded');
    api.updateCamera();
    beginCountdown();
  }

  function stop() {
    clearTimeout(countdownTimer);
    if (run?.drone) { Object.assign(api.observer, { flyY: undefined, roll: 0, shake: 0, fov: undefined }); api.setDrone?.(false); }
    setDroneUi(false);
    stopBuzz();
    phase = 'idle';
    keys.clear();
    look = null;
    hud.hidden = true;
    $('navPause').hidden = true;
    $('navCountdown').hidden = true;
    resultsDialog.open && resultsDialog.close();
    document.body.classList.remove('nav-night');
    $('navCamelAlert').hidden = true;
    disposeWorld();
    api.exit();
  }

  // ——— Progress & punching ———
  function renderProgressDots() {
    const dots = points.slice(1).map((p, i) => {
      const index = i + 1;
      const state = index < run.next ? 'done' : index === run.next ? 'next' : '';
      return `<i class="${state}">${p.kind === 'finish' ? '◎' : p.number}</i>`;
    });
    $('navProgressDots').innerHTML = dots.join('');
    const next = points[run.next];
    $('navProgressText').textContent = !next ? 'סיימתם!' : next.kind === 'finish' ? 'לסיום' : `נקודה ${next.number} מתוך ${points.length - 2}`;
  }

  function flash(text, warn = false) {
    const box = $('navFlash');
    box.textContent = text;
    box.classList.toggle('warn', warn);
    box.classList.remove('show');
    void box.offsetWidth; // restart the animation
    box.classList.add('show');
  }

  function punch() {
    const point = points[run.next];
    run.splits.push({ from: run.next - 1, to: run.next, time: run.elapsed - run.legStart, walked: run.legWalked, ascent: run.legAscent });
    run.legStart = run.elapsed;
    run.legWalked = 0;
    run.legAscent = 0;
    run.next++;
    renderProgressDots();
    refreshMapCard();
    if (point.kind === 'finish') {
      beep([[660, .14], [880, .14], [1175, .32]]);
      flash('🏁 סיום!');
      finish();
      return;
    }
    beep([[988, .09], [1319, .16]]);
    flash(`✓ נקודה ${point.number} · מצאתם את הפתק`);
  }

  function checkControls() {
    const extent = api.extent();
    const reach = reachRadiusMeters(extent);
    const o = api.observer;
    const target = points[run.next];
    // From the drone a note can only be read when hovering low over the cairn.
    const agl = droneAgl();
    const near = (p) => (run.drone ? canReadNote({ horizontalDistance: distanceMeters(o, p, extent), reach, agl }) : distanceMeters(o, p, extent) <= reach);
    if (target && near(target)) { punch(); return; }
    points.forEach((p, index) => {
      if (p.kind !== 'control' || index === run.next || index < run.next || run.warned.has(index)) return;
      if (near(p)) {
        run.warned.add(index);
        flash(`זוהי נקודה ${p.number} — אתם מחפשים את ${target.kind === 'finish' ? 'הסיום' : target.number}`, true);
        beep([[300, .2]]);
      }
    });
  }

  // ——— Drone mode (the "רחפן" cheat) ———
  // Type "רחפן" / "drone", or tap the timer five times: the walker turns into a drone that
  // flies over the terrain. It holds its altitude and climbs over hills by itself, reads a
  // control's note only when hovering low over it, and lands where it is when asked or
  // when the battery runs out. A run that used the drone does not set a personal best.
  const exaggeration = () => api.verticalScale() / api.metersToWorld();
  // Ground under the drone in display metres: the higher of the two surface samples, so
  // the drone never dips into the rendered triangles.
  const groundDisplay = (u, v) => Math.max(api.height(u, v), api.surfaceHeight ? api.surfaceHeight(u, v) : -Infinity) * exaggeration();

  function setDroneUi(on) {
    document.body.classList.toggle('drone-mode', on);
    $('droneHud').hidden = !on;
    if (world?.droneShadow) world.droneShadow.visible = on;
    if (!on) setFpvUi(false);
  }

  function setFpvUi(on) {
    document.body.classList.toggle('fpv-mode', on);
    $('droneModeBtn').textContent = on ? '🎥 צילום' : '⚡ FPV';
    if (!on) {
      const canvas = $('fpvLines');
      canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
      $('fpvPullUp').hidden = true;
    }
  }

  // FPV on/off while flying. Leaving FPV hands over to the steady camera drone.
  function setFpv(on, quiet = false) {
    if (!run?.drone || run.landing || run.fpv === on) return; // not while landing
    const o = api.observer;
    run.fpv = on;
    run.vel = { x: 0, y: 0, z: 0 };
    run.roll = 0;
    run.trick = null;
    o.roll = 0;
    o.shake = 0;
    if (world?.droneShadow) world.droneShadow.visible = !on;
    if (on) {
      // Level the nose so W flies forward; from the ground, punch out upwards.
      o.tilt = 0;
      if (droneAgl() < 12) run.vel.y = 30;
      run.fov = 92;
      o.fov = run.fov;
      if (!quiet) {
        flash(matchMedia('(pointer: coarse)').matches
          ? '⚡ FPV! סטיק שמאלי: גז ופנייה · ימני: אף וצד · דחיפה עד הסוף = בוסט'
          : '⚡ FPV! W גז · חצים לאף · Shift בוסט · R סיבוב');
        beep([[523, .07], [784, .07], [1047, .07], [1568, .2]]);
      }
    } else {
      run.target = run.altitude;
      o.tilt = clamp(o.tilt, -89, 10);
      o.fov = 74;
      if (!quiet) flash('🎥 רחפן צילום');
    }
    setFpvUi(on);
  }

  // Typed codes: "רחפן"/"drone" takes off (or lands); "fpv" takes off straight into FPV.
  function onCheat(mode) {
    if (!run.drone) {
      toggleDrone();
      if (mode === 'fpv') setFpv(true);
      return;
    }
    if (mode === 'drone') beginLanding();
    // "fpv" while flying: the F key in it has already switched the mode.
  }

  function startTrick() {
    if (!run?.fpv || run.trick || run.landing) return;
    run.trick = { t: 0, dir: Math.random() < .5 ? -1 : 1 };
    beep([[660, .06], [880, .06], [1175, .12]]);
  }

  function crash(closing) {
    run.crashes++;
    run.shake = 2.6;
    run.battery = Math.max(0, run.battery - 4);
    flash(closing > 90 ? '💥 התרסקות!' : '💥 נגיעה בקרקע!', true);
    beep([[110, .25], [70, .3]]);
    const overlay = $('fpvCrash');
    overlay.classList.remove('hit');
    void overlay.offsetWidth;
    overlay.classList.add('hit');
  }

  function toggleDrone() {
    if (phase !== 'running' || !run) return;
    if (run.drone) { beginLanding(); return; }
    if (run.battery < 5) { flash('🔋 הסוללה ריקה — לכו קצת כדי לטעון אותה', true); return; }
    const o = api.observer;
    const ground = groundDisplay(o.u, o.v);
    run.drone = true;
    run.landing = false;
    run.droneUsed = true;
    run.lowWarned = false;
    run.altitude = ground + 2.1; // take off from head height
    run.target = ground + DRONE.startAgl;
    o.tilt = -30;
    o.bob = 0;
    o.flyY = run.altitude * api.metersToWorld();
    api.setDrone?.(true);
    setDroneUi(true);
    beep([[392, .1], [523, .1], [784, .22]]);
    flash('🚁 מצב רחפן! הנמיכו מעל רוג׳ום כדי לקרוא את הפתק');
    mapTimer = 0;
  }

  function beginLanding(reason = '') {
    if (!run?.drone || run.landing) return;
    if (run.fpv) setFpv(false, true);
    run.landing = true;
    flash(reason || '🛬 נוחתים…', Boolean(reason));
  }

  function land() {
    const o = api.observer;
    run.drone = false;
    run.landing = false;
    run.fpv = false;
    Object.assign(o, { flyY: undefined, roll: 0, shake: 0, fov: undefined });
    o.tilt = -4;
    api.setDrone?.(false);
    setDroneUi(false);
    stopBuzz();
    beep([[523, .1], [392, .2]]);
    flash('נחתתם — ממשיכים ברגל');
    mapTimer = 0;
  }

  function flyStep(dt, forward, strafe, turbo) {
    const o = api.observer;
    const extent = api.extent();
    const moving = Math.hypot(forward, strafe) > .05;
    run.droneSpeed = 0;
    if (moving) {
      const rad = o.heading * Math.PI / 180;
      const fx = Math.sin(rad);
      const fy = -Math.cos(rad);
      let dx = fx * forward + -fy * strafe;
      let dy = fy * forward + fx * strafe;
      const magnitude = Math.hypot(dx, dy) || 1;
      const input = Math.min(1, magnitude);
      dx /= magnitude;
      dy /= magnitude;
      const speed = baseSpeed(extent) * DRONE.speedFactor * (turbo ? RUN_FACTOR : 1) * input;
      const nu = clamp(o.u + dx * speed * dt / extent, .002, .998);
      const nv = clamp(o.v + dy * speed * dt / extent, .002, .998);
      const step = distanceMeters(o, { u: nu, v: nv }, extent);
      o.u = nu;
      o.v = nv;
      run.flown += step;
      run.droneSpeed = step / Math.max(dt, 1e-6);
      if (run.keysFade > 0) run.keysFade -= dt;
    }
    const ground = groundDisplay(o.u, o.v);
    if (run.landing) {
      const result = stepLanding({ altitude: run.altitude, ground, dt });
      run.altitude = result.altitude;
      if (result.landed) { o.flyY = run.altitude * api.metersToWorld(); land(); return; }
    } else {
      const climb = clamp((keys.has('KeyE') || keys.has('PageUp') ? 1 : 0) - (keys.has('KeyQ') || keys.has('PageDown') ? 1 : 0) + droneClimbInput, -1, 1);
      run.target += climb * DRONE.climbRate * 1.2 * dt;
      const result = stepAltitude({ altitude: run.altitude, target: run.target, ground, dt });
      run.altitude = result.altitude;
      run.target = result.target;
    }
    o.flyY = run.altitude * api.metersToWorld();
    run.droneTime += dt;
    run.battery = stepBattery(run.battery, dt, true);
    if (!run.lowWarned && run.battery <= DRONE.lowBattery) {
      run.lowWarned = true;
      flash(`🔋 סוללה חלשה (${Math.round(run.battery)}%) — כדאי לנחות`, true);
      beep([[440, .12], [330, .2]]);
    }
    if (run.battery <= 0) beginLanding('🔋 הסוללה נגמרה — נחיתה אוטומטית');
    updateDroneShadow(ground);
    updateBuzz();
  }

  // ——— FPV flight: momentum, banking, wide lens, speed lines, crashes ———
  function fpvStep(dt, input) {
    const o = api.observer;
    const extent = api.extent();
    const top = fpvTopSpeed(extent);
    run.boosting = input.boost && input.throttle > .1;
    o.heading = (o.heading + input.yaw * FPV.turnRate * dt + 360) % 360;
    o.tilt = clamp(o.tilt - input.pitchDown * FPV.pitchRate * dt, -85, 60);
    run.throttle = clamp(input.throttle, -1, 1);
    run.vel = fpvVelocity({ vel: run.vel, heading: o.heading, tilt: o.tilt, throttle: run.throttle, strafe: input.strafe, climb: input.climb, boost: run.boosting, dt, topSpeed: top });
    let nu = o.u + run.vel.x * dt / extent;
    let nv = o.v + run.vel.z * dt / extent;
    if (nu < .002 || nu > .998) { nu = clamp(nu, .002, .998); run.vel.x = 0; }
    if (nv < .002 || nv > .998) { nv = clamp(nv, .002, .998); run.vel.z = 0; }
    const step = distanceMeters(o, { u: nu, v: nv }, extent);
    o.u = nu;
    o.v = nv;
    run.flown += step;
    run.altitude += run.vel.y * dt;
    const ground = groundDisplay(o.u, o.v);
    const contact = fpvGround({ altitude: run.altitude, vel: run.vel, ground, dt });
    run.altitude = contact.altitude;
    run.vel = contact.vel;
    run.crashCool = Math.max(0, (run.crashCool || 0) - dt);
    if (contact.crashed && run.crashCool <= 0) { crash(contact.closing); run.crashCool = .8; }
    if (run.altitude > ground + DRONE.maxAgl) { run.altitude = ground + DRONE.maxAgl; run.vel.y = Math.min(run.vel.y, 0); }
    const speed = Math.hypot(run.vel.x, run.vel.y, run.vel.z);
    run.droneSpeed = speed;
    run.maxSpeed = Math.max(run.maxSpeed, speed);
    const ratio = speed / top;

    // Bank into turns and sideways moves; R adds a full barrel roll.
    const targetRoll = input.yaw * 32 + input.strafe * 22;
    run.roll += (targetRoll - run.roll) * Math.min(1, dt * 6);
    let trickRoll = 0;
    if (run.trick) {
      run.trick.t += dt / .7;
      const t = Math.min(1, run.trick.t);
      trickRoll = run.trick.dir * 360 * (t < .5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
      if (run.trick.t >= 1) {
        run.trick = null;
        run.tricks++;
        flash(`🌀 סיבוב חבית! (${run.tricks})`);
      }
    }
    o.roll = run.roll + trickRoll;
    // Wide lens that opens up with speed (and kicks on boost); shake when fast or skimming.
    const targetFov = Math.min(125, 92 + 22 * ratio + (run.boosting ? 8 : 0));
    run.fov += (targetFov - run.fov) * Math.min(1, dt * 3);
    o.fov = run.fov;
    run.shake = Math.max(0, run.shake - dt * 3.2);
    o.shake = run.shake + (ratio > .75 ? (ratio - .75) * .9 : 0) + (contact.skimming && speed > 20 ? .45 : 0);

    o.flyY = run.altitude * api.metersToWorld();
    run.droneTime += dt;
    run.battery = stepBattery(run.battery, dt * FPV.batteryFactor, true);
    if (!run.lowWarned && run.battery <= DRONE.lowBattery) {
      run.lowWarned = true;
      flash(`🔋 סוללה חלשה (${Math.round(run.battery)}%) — כדאי לנחות`, true);
      beep([[440, .12], [330, .2]]);
    }
    if (run.battery <= 0) beginLanding('🔋 הסוללה נגמרה — נחיתה אוטומטית');
    updateFpvOsd(speed);
    drawSpeedLines(dt, ratio);
    updateBuzz();
    if (run.keysFade > 0) run.keysFade -= dt;
  }

  function updateFpvOsd(speed) {
    const o = api.observer;
    const hud = $('navHud');
    // Where the real horizon is on screen: pitch moves it along the (rolled) vertical, and
    // it rolls opposite to the drone. Perspective scale: (h/2)·tan(angle)/tan(fov/2).
    const h = hud.clientHeight || 600;
    const focal = h / 2 / Math.tan(run.fov * Math.PI / 360);
    const offset = clamp(focal * Math.tan(clamp(o.tilt, -80, 80) * Math.PI / 180), -h, h);
    const horizon = $('fpvHorizon');
    horizon.style.transform = `rotate(${-(o.roll || 0)}deg) translateY(${offset}px)`;
    horizon.style.setProperty('--p10', `${focal * Math.tan(Math.PI / 18)}px`);
    $('fpvSpeed').textContent = String(Math.round(speed * 3.6));
    $('fpvThrottle').style.width = `${Math.round(Math.max(0, run.throttle) * 100)}%`;
    const mode = $('fpvMode');
    mode.textContent = run.boosting ? 'BOOST' : run.trick ? 'FLIP' : 'ACRO';
    mode.classList.toggle('boost', run.boosting);
    // PULL UP: the flight path meets the ground (a dive or a hillside ahead) within ~1.2 s.
    const extent = api.extent();
    const ahead = speed > 25 ? terrainAhead({
      altitude: run.altitude,
      vel: run.vel,
      groundAt: (dx, dz) => groundDisplay(clamp(o.u + dx / extent, 0, 1), clamp(o.v + dz / extent, 0, 1)),
    }) : Infinity;
    $('fpvPullUp').hidden = !Number.isFinite(ahead);
  }

  // Streaks rushing out from the centre, stronger with speed.
  const streaks = Array.from({ length: 80 }, (_, i) => ({ angle: i * 2.39996, dist: (i * .618) % 1, width: .6 + (i % 5) * .35 }));
  function drawSpeedLines(dt, ratio) {
    const canvas = $('fpvLines');
    const hud = $('navHud');
    const w = hud.clientWidth;
    const h = hud.clientHeight;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    const strength = clamp((ratio - .3) * 1.3 + (run.boosting ? .25 : 0), 0, .85);
    if (strength <= 0) return;
    const cx = w / 2;
    const cy = h / 2;
    const reach = Math.hypot(cx, cy);
    ctx.lineCap = 'round';
    for (const streak of streaks) {
      streak.dist += dt * (.35 + ratio * 2.2) * (.4 + streak.dist);
      if (streak.dist > 1.05) { streak.dist = .12 + Math.random() * .2; streak.angle = Math.random() * Math.PI * 2; }
      const r1 = streak.dist * reach;
      const r2 = Math.min(1.1, streak.dist + .04 + ratio * .14) * reach;
      const dx = Math.cos(streak.angle);
      const dy = Math.sin(streak.angle);
      ctx.strokeStyle = `rgba(255,255,255,${strength * Math.min(1, streak.dist * 1.6)})`;
      ctx.lineWidth = streak.width * (1 + ratio);
      ctx.beginPath();
      ctx.moveTo(cx + dx * r1, cy + dy * r1);
      ctx.lineTo(cx + dx * r2, cy + dy * r2);
      ctx.stroke();
    }
  }

  function droneAgl() {
    const o = api.observer;
    return run?.drone ? run.altitude - groundDisplay(o.u, o.v) : 0;
  }

  const UP = new THREE.Vector3(0, 1, 0);
  const shadowNormal = new THREE.Vector3();
  function updateDroneShadow(ground) {
    const shadow = world?.droneShadow;
    if (!shadow) return;
    const o = api.observer;
    const mtw = api.metersToWorld();
    const agl = run.altitude - ground;
    const radius = Math.max(2.2, agl * .045); // metres: a marker that stays visible from height
    // Lie on the slope: tilt the disc to the ground normal (both axes in display metres).
    const extent = api.extent();
    const e = radius / extent;
    const gx = (groundDisplay(clamp(o.u + e, 0, 1), o.v) - groundDisplay(clamp(o.u - e, 0, 1), o.v)) / (2 * radius);
    const gz = (groundDisplay(o.u, clamp(o.v + e, 0, 1)) - groundDisplay(o.u, clamp(o.v - e, 0, 1))) / (2 * radius);
    shadowNormal.set(-gx, 1, -gz).normalize();
    shadow.quaternion.setFromUnitVectors(UP, shadowNormal);
    shadow.position.set((o.u - .5) * api.worldSize(), (ground + .6) * mtw, (o.v - .5) * api.worldSize());
    shadow.scale.setScalar(radius * mtw);
    shadow.material.opacity = clamp(.5 - agl / 1400, .18, .5);
  }

  function updateDroneHud() {
    const agl = droneAgl();
    const o = api.observer;
    $('droneAgl').textContent = `${Math.round(agl)} מ׳`;
    $('droneGround').textContent = `${Math.round(api.height(o.u, o.v))} מ׳`;
    $('droneSpeed').textContent = `${Math.round(run.droneSpeed * 3.6)} קמ״ש`;
    const battery = Math.round(run.battery);
    $('droneBattery').textContent = `${battery}%`;
    $('droneBatteryBar').style.width = `${battery}%`;
    $('droneBattery').closest('.drone-battery').classList.toggle('low', battery <= DRONE.lowBattery);
    $('droneAltMarker').style.top = `${clamp(1 - agl / DRONE.maxAgl, 0, 1) * 100}%`;
    $('droneClock').textContent = formatClock(run.droneTime);
    $('droneGimbal').textContent = `מצלמה ${Math.round(o.tilt)}°`;
  }

  // Propeller hum while flying (very quiet; follows the speed).
  function startBuzz() {
    if (buzz || !soundOn) return;
    try {
      audio ||= new (window.AudioContext || window.webkitAudioContext)();
      const gain = audio.createGain();
      gain.gain.value = 0.0001;
      gain.gain.exponentialRampToValueAtTime(.016, audio.currentTime + .4);
      const filter = audio.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 900;
      const a = audio.createOscillator();
      const b = audio.createOscillator();
      a.type = 'sawtooth';
      b.type = 'sawtooth';
      a.frequency.value = 150;
      b.frequency.value = 156;
      a.connect(filter);
      b.connect(filter);
      filter.connect(gain).connect(audio.destination);
      a.start();
      b.start();
      buzz = { a, b, gain };
    } catch { buzz = null; }
  }
  function stopBuzz() {
    if (!buzz) return;
    const { a, b, gain } = buzz;
    buzz = null;
    try {
      gain.gain.exponentialRampToValueAtTime(.0001, audio.currentTime + .25);
      a.stop(audio.currentTime + .3);
      b.stop(audio.currentTime + .3);
    } catch { /* already stopped */ }
  }
  function updateBuzz() {
    const want = soundOn && run?.drone && phase === 'running';
    if (want && !buzz) startBuzz();
    if (!want && buzz) stopBuzz();
    if (buzz) {
      const pitch = run.fpv
        ? 190 + Math.min(1.6, run.droneSpeed / fpvTopSpeed(api.extent())) * 230 + Math.max(0, run.throttle) * 40
        : 150 + Math.min(1, run.droneSpeed / 120) * 70 + droneClimbInput * 15;
      buzz.gain.gain.setTargetAtTime(run.fpv ? .028 : .016, audio.currentTime, .2);
      buzz.a.frequency.setTargetAtTime(pitch, audio.currentTime, .15);
      buzz.b.frequency.setTargetAtTime(pitch * 1.04, audio.currentTime, .15);
    }
  }

  // Touch: ▲ / ▼ held to climb or descend, and the landing button.
  for (const [id, direction] of [['droneUpBtn', 1], ['droneDownBtn', -1]]) {
    const button = $(id);
    button.addEventListener('pointerdown', (event) => { event.preventDefault(); droneClimbInput = direction; button.setPointerCapture(event.pointerId); });
    const release = () => { droneClimbInput = 0; };
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    button.addEventListener('lostpointercapture', release);
  }
  $('droneLandBtn').addEventListener('click', () => beginLanding());
  $('droneModeBtn').addEventListener('click', () => setFpv(!run?.fpv));
  $('droneTrickBtn').addEventListener('click', () => startTrick());
  $('navLampBtn').addEventListener('click', () => setLamp(!run?.lamp));
  // Five quick taps on the timer (the way in on touch screens).
  // Counted as a streak: each tap must come within 0.9 s of the previous one.
  $('navTimer').addEventListener('click', () => {
    const now = performance.now();
    const last = timerTaps[timerTaps.length - 1];
    timerTaps = last !== undefined && now - last < 900 ? [...timerTaps, now] : [now];
    if (timerTaps.length >= 5) { timerTaps = []; toggleDrone(); }
  });

  // ——— Input ———
  const MOVE_KEYS = new Set(['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight', 'KeyE', 'KeyQ', 'PageUp', 'PageDown', 'Space']);
  document.addEventListener('keydown', (event) => {
    if (phase === 'idle' || phase === 'finished' || document.querySelector('dialog[open]')) return;
    if (event.code === 'Escape') { event.preventDefault(); phase === 'paused' ? resume() : pause(); return; }
    if (phase === 'paused') return;
    if (phase === 'running' && !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const cheat = feedCheat(cheatBuffer, event.key);
      cheatBuffer = cheat.buffer;
      if (cheat.matched) { event.preventDefault(); onCheat(cheat.mode); return; }
      if (run?.drone && event.code === 'KeyF') { event.preventDefault(); setFpv(!run.fpv); return; }
      if (run?.fpv && event.code === 'KeyR') { event.preventDefault(); startTrick(); return; }
    }
    if (event.code === 'KeyM') { event.preventDefault(); if (!event.repeat) toggleMap(); return; }
    if (event.code === 'KeyL' && run?.night) { event.preventDefault(); if (!event.repeat) setLamp(!run.lamp); return; }
    if (MOVE_KEYS.has(event.code)) { event.preventDefault(); keys.add(event.code); }
  }, true);
  document.addEventListener('keyup', (event) => keys.delete(event.code), true);
  addEventListener('blur', () => keys.clear());

  const canvas = api.canvas();
  canvas?.addEventListener('pointerdown', (event) => {
    if (phase !== 'running' && phase !== 'countdown') return;
    look = { id: event.pointerId, x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas?.addEventListener('pointermove', (event) => {
    if (!look || event.pointerId !== look.id) return;
    const o = api.observer;
    o.heading = (o.heading + (event.clientX - look.x) * .22 + 360) % 360;
    o.tilt = run?.fpv ? clamp(o.tilt - (event.clientY - look.y) * .2, -85, 60)
      : run?.drone ? clamp(o.tilt - (event.clientY - look.y) * .2, -89, 10) : clamp(o.tilt - (event.clientY - look.y) * .15, -40, 35);
    look.x = event.clientX;
    look.y = event.clientY;
  });
  const endLook = (event) => { if (look && event.pointerId === look.id) look = null; };
  canvas?.addEventListener('pointerup', endLook);
  // Mouse wheel changes the drone's altitude.
  canvas?.addEventListener('wheel', (event) => {
    if (!run?.drone || phase !== 'running') return;
    event.preventDefault();
    run.target -= Math.sign(event.deltaY) * DRONE.wheelStep;
  }, { passive: false });
  canvas?.addEventListener('pointercancel', endLook);

  // ——— Per-frame update (called from scene.js's animation loop) ———
  function frame(dt) {
    if (phase === 'idle') return;
    const o = api.observer;
    if (phase === 'running') {
      // Twin-stick on touch screens: left stick moves (forward/back, sideways steps),
      // right stick looks (turn left/right, tilt up/down). Keyboard: WASD/arrows.
      const sticks = api.axes()?.sticks || { move: { x: 0, y: 0 }, look: { x: 0, y: 0 } };
      const has = (...codes) => codes.some((c) => keys.has(c));
      const forward = clamp((has('KeyW', 'ArrowUp') ? 1 : 0) - (has('KeyS', 'ArrowDown') ? 1 : 0) + sticks.move.y, -1, 1);
      const strafe = clamp(sticks.move.x, -1, 1);
      const turn = clamp((has('KeyD', 'ArrowRight') ? 1 : 0) - (has('KeyA', 'ArrowLeft') ? 1 : 0) + sticks.look.x, -1, 1);
      const running = has('ShiftLeft', 'ShiftRight') || Math.hypot(sticks.move.x, sticks.move.y) > .97;
      run.elapsed += dt;
      if (!run.fpv) o.heading = (o.heading + turn * TURN_SPEED * dt + 360) % 360;
      const extent = api.extent();
      // A camel that caught you leaves you stunned for a moment.
      const stunned = run.stun > 0;
      if (stunned) run.stun -= dt;
      const moving = !stunned && Math.hypot(forward, strafe) > .05;
      if (run.fpv) {
        fpvStep(dt, {
          throttle: (has('KeyW') ? 1 : 0) - (has('KeyS') ? 1 : 0) + sticks.move.y,
          yaw: clamp((has('KeyD', 'ArrowRight') ? 1 : 0) - (has('KeyA', 'ArrowLeft') ? 1 : 0) + sticks.move.x, -1, 1),
          pitchDown: clamp((has('ArrowUp') ? 1 : 0) - (has('ArrowDown') ? 1 : 0) + sticks.look.y, -1, 1),
          strafe: clamp(sticks.look.x, -1, 1),
          climb: clamp((has('KeyE', 'Space', 'PageUp') ? 1 : 0) - (has('KeyQ', 'PageDown') ? 1 : 0) + droneClimbInput, -1, 1),
          boost: has('ShiftLeft', 'ShiftRight') || sticks.move.y > .95, // touch: stick pushed all the way forward
        });
      } else if (run.drone) {
        o.tilt = clamp(o.tilt + sticks.look.y * 60 * dt, -89, 10);
        flyStep(dt, forward, strafe, running);
      } else {
        o.tilt = clamp(o.tilt + sticks.look.y * 50 * dt, -40, 35);
        run.battery = stepBattery(run.battery, dt, false);
      }
      if (run.drone) {
        // flying: handled in flyStep
      } else if (moving) {
        // Direction of travel: forward/back along the heading plus a sideways component.
        const rad = o.heading * Math.PI / 180;
        const fx = Math.sin(rad);
        const fy = -Math.cos(rad);
        const sideFactor = .7;
        let dx = fx * forward + -fy * strafe * sideFactor;
        let dy = fy * forward + fx * strafe * sideFactor;
        const magnitude = Math.hypot(dx, dy) || 1;
        const input = Math.min(1, magnitude);
        dx /= magnitude;
        dy /= magnitude;
        const dir = forward < -.05 && Math.abs(forward) >= Math.abs(strafe) ? -1 : 1;
        const here = api.height(o.u, o.v);
        const probe = 8 / extent;
        const ahead = api.height(clamp(o.u + dx * probe, 0, 1), clamp(o.v + dy * probe, 0, 1));
        run.grade = (ahead - here) / 8;
        // Land cover: forests slow you down, roads and trails speed you up (areas.js).
        run.ground = api.groundInfo?.(o.u, o.v) || null;
        run.pace = slopeSpeedFactor(run.grade) * (run.ground?.speed ?? 1);
        const speed = baseSpeed(extent) * (running ? RUN_FACTOR : 1) * (dir < 0 ? BACK_FACTOR : 1) * input * run.pace;
        const nu = clamp(o.u + dx * speed * dt / extent, .002, .998);
        const nv = clamp(o.v + dy * speed * dt / extent, .002, .998);
        const step = distanceMeters(o, { u: nu, v: nv }, extent);
        const rise = api.height(nu, nv) - here;
        o.u = nu;
        o.v = nv;
        run.walked += step;
        run.legWalked += step;
        if (rise > 0) { run.ascent += rise; run.legAscent += rise; }
        run.bob += step / (running ? 1.9 : 1.4);
        o.bob = Math.sin(run.bob * Math.PI) * .045;
        if (run.keysFade > 0) run.keysFade -= dt;
        if (run.keysFade <= 0) $('navKeys').classList.add('faded');
      } else {
        run.pace = 1;
        run.ground = api.groundInfo?.(o.u, o.v) || null;
        run.grade = 0;
        o.bob *= .85;
      }
      run.trackClock += dt;
      if (run.trackClock > .3) {
        run.trackClock = 0;
        const last = run.track.at(-1);
        if (Math.hypot(last.u - o.u, last.v - o.v) > .0008) run.track.push({ u: o.u, v: o.v, fly: run.drone });
      }
      checkControls();
      if (world?.camels?.length) stepCamels(dt);
      if (run.night) advanceClock(dt);
    }
    api.updateCamera();
    if (world) {
      world.sky.position.copy(api.camera().position);
      if (run) updateFlags();
      updateNightObjects();
      updateCamelMeshes(dt);
    }
    if (run) {
      updateCompass();
      hudTimer -= dt;
      if (hudTimer <= 0) { hudTimer = .1; updateHudText(); if (run.drone) updateDroneHud(); }
      if (!mapCard.hidden) {
        mapTimer -= dt;
        if (mapTimer <= 0) { mapTimer = .12; drawMapInto(mapCanvas, { done: run.next, nextIndex: run.next, showYou: settings.showPosition || run.drone }); }
      }
    }
    api.invalidate();
  }

  function updateHudText() {
    $('navTimer').textContent = formatClock(run.elapsed + penaltySeconds());
    if (run.night && run.sky) {
      const icon = run.sky.dark > .6 ? run.sky.phase.emoji : run.sky.sunAlt > 0 ? '🌇' : '🌆';
      $('navClock').textContent = `${icon} ${formatHour(run.clock)}`;
    }
    updateCamelAlert();
    const pace = clamp(run.pace / 1.1, 0, 1);
    $('navPaceBar').style.width = `${Math.round(pace * 100)}%`;
    $('navPaceBar').style.background = `hsl(${Math.round(pace * 120)} 65% 58%)`;
    const g = Math.round(run.grade * 100);
    const slopeText = Math.abs(g) < 3 ? 'מישור' : g > 0 ? `עלייה ${g}%` : `ירידה ${-g}%`;
    const groundText = run.ground?.onPath ? 'דרך' : run.ground?.area || '';
    $('navSlopeText').textContent = run.fpv ? '⚡ FPV' : run.drone ? '🚁 טיסה' : groundText ? `${slopeText} · ${groundText}` : slopeText;
    if (run.drone) $('navPaceBar').style.width = '100%';
    const hint = $('navHint');
    const next = points[run.next];
    if (!next || phase !== 'running') { hint.textContent = ''; return; }
    const extent = api.extent();
    const d = distanceMeters(api.observer, next, extent);
    const name = next.kind === 'finish' ? 'לסיום' : `לנקודה ${next.number}`;
    const close = d < reachRadiusMeters(extent) * 3.5;
    if (run.drone && d <= reachRadiusMeters(extent) && droneAgl() > DRONE.readAgl) {
      hint.classList.add('close');
      hint.textContent = `הנמיכו מתחת ל־${DRONE.readAgl} מ׳ כדי לקרוא את הפתק (עכשיו ${Math.round(droneAgl())} מ׳)`;
      return;
    }
    hint.classList.toggle('close', close && settings.showDistance);
    if (settings.showDistance) hint.textContent = close ? `${name} — ממש כאן! (${Math.round(d)} מ׳)` : `${name} · ${formatMeters(d)}`;
    else hint.textContent = '';
  }

  // ——— Results ———
  function finish() {
    if (run.drone) { Object.assign(api.observer, { flyY: undefined, roll: 0, shake: 0, fov: undefined }); api.setDrone?.(false); run.drone = false; run.fpv = false; setDroneUi(false); }
    stopBuzz();
    phase = 'finished';
    keys.clear();
    const extent = api.extent();
    const penalty = penaltySeconds();
    const total = totalScore({ elapsed: run.elapsed + run.camelCatches * CAMEL_PENALTY, peeks: run.peeks, penaltyPerPeek: PEEK_PENALTY });
    const straight = courseLength(course, extent);
    const efficiency = run.walked ? Math.min(1, straight / run.walked) : 1;
    const bests = readStorage(BEST_KEY, {});
    const key = bestKey();
    const previous = bests[key];
    // A run that used the drone cheat never sets a personal best.
    const record = !run.droneUsed && (!previous || total < previous);
    if (record) { bests[key] = Math.round(total); writeStorage(BEST_KEY, bests); }

    $('navResultsKicker').textContent = `רמה: ${LEVEL_NAMES[level]}`;
    $('navResultsTitle').textContent = efficiency > .8 ? 'ניווט מצוין!' : efficiency > .6 ? 'כל הכבוד, הגעתם!' : 'הגעתם! יש מקום לשיפור';
    $('navScore').innerHTML = `<b>${formatClock(total)}</b>`
      + `<span>${penalty ? `${formatClock(run.elapsed)} ריצה + ${penalty} ש׳ עונש` : 'זמן כולל'}</span>`
      + (run.droneUsed ? '<span class="nav-record nav-drone-badge">🚁 בעזרת רחפן — השיא לא נשמר</span>'
        : record ? `<span class="nav-record">${previous ? 'שיא חדש!' : 'שיא ראשון!'}</span>` : `<span>השיא: ${formatClock(previous)}</span>`);
    const cells = [
      ['הלכתם', formatMeters(run.walked)],
      ['קו ישר בין הנקודות', formatMeters(straight)],
      ['יעילות מסלול', `${Math.round(efficiency * 100)}%`],
      ['טיפוס מצטבר', `${Math.round(run.ascent)} מ׳`],
      ['בשטח אמיתי (נייסמית׳)', `כ־${Math.round(naismithMinutes(run.walked, run.ascent))} דק׳`],
      ...(run.droneUsed ? [['טסתם ברחפן', formatMeters(run.flown)]] : []),
      ...(run.maxSpeed > 0 ? [['מהירות שיא', `${Math.round(run.maxSpeed * 3.6)} קמ״ש`]] : []),
      ...(run.tricks ? [['טריקים', `🌀 ${run.tricks}`]] : []),
      ...(run.crashes ? [['התרסקויות', `💥 ${run.crashes}`]] : []),
      ...(world?.camels?.some((camel) => camel.data) ? [['🐪 גמלים', run.camelCatches || run.camelEscapes ? `נתפסתם ${run.camelCatches} · ברחתם ${run.camelEscapes}` : 'לא נתפסתם']] : []),
      ...(run.night ? [[`${moonPhase(moonDay, run.clock).emoji} שעה`, `${formatHour(run.startClock)}–${formatHour(run.clock)} · ${hebrewDay(moonDay)} בחודש`]] : []),
      [settings.mapMode === 'peek' ? 'הצצות במפה' : 'מפה', settings.mapMode === 'peek' ? String(run.peeks) : settings.mapMode === 'none' ? 'מהזיכרון' : 'פתוחה'],
    ];
    $('navResultGrid').innerHTML = cells.map(([label, value]) => `<div><small>${label}</small><strong>${value}</strong></div>`).join('');

    const legInfo = legs(course).map((leg, i) => {
      const split = run.splits[i];
      const direct = distanceMeters(leg.from, leg.to, extent);
      return { leg, split, direct, eff: split?.walked ? Math.min(1, direct / split.walked) : 1 };
    });
    const best = Math.max(...legInfo.map((l) => l.eff));
    const worst = Math.min(...legInfo.map((l) => l.eff));
    const label = (p) => (p.kind === 'start' ? 'זינוק' : p.kind === 'finish' ? 'סיום' : p.number);
    $('navSplits').innerHTML = '<tr><th>מקטע</th><th>קו ישר</th><th>הלכתם</th><th>זמן</th><th>יעילות</th></tr>'
      + legInfo.map(({ leg, split, direct, eff }) => `<tr><td>${label(leg.from)} ← ${label(leg.to)}</td><td>${formatMeters(direct)}</td><td>${formatMeters(split?.walked || 0)}</td><td>${formatClock(split?.time || 0)}</td><td class="${legInfo.length > 1 && eff === best ? 'good' : legInfo.length > 1 && eff === worst && eff < .85 ? 'bad' : ''}">${Math.round(eff * 100)}%</td></tr>`).join('');

    const weakest = legInfo.find((l) => l.eff === worst);
    const climbiest = legInfo.reduce((a, b) => ((b.split?.ascent || 0) > (a.split?.ascent || 0) ? b : a));
    let insight;
    if (worst < .65) insight = `במקטע ${label(weakest.leg.from)} ← ${label(weakest.leg.to)} הלכתם פי ${(1 / worst).toFixed(1)} מהקו הישר. נסו לקבוע כיוון במצפן לפני שיוצאים, ולבחור נקודת ציון בולטת בדרך (פסגה, ערוץ).`;
    else if ((climbiest.split?.ascent || 0) > 40) insight = `במקטע ${label(climbiest.leg.from)} ← ${label(climbiest.leg.to)} טיפסתם ${Math.round(climbiest.split.ascent)} מ׳. לפעמים עקיפה של גבעה לאורך קו גובה מהירה יותר מהדרך הישרה. קווים צפופים במפה = עלייה תלולה.`;
    else insight = 'ניווט יעיל מאוד: הדרך שלכם קרובה לקו הישר. נסו רמת קושי גבוהה יותר!';
    if (run.droneUsed) insight = `🚁 טסתם ${formatMeters(run.flown)} ברחפן. מלמעלה קל לראות את התבליט — בפעם הבאה נסו לזהות את אותם עמקים ורכסים מגובה העיניים, בלי הרחפן.`;
    $('navInsight').textContent = insight;

    setTimeout(() => {
      if (phase !== 'finished') return;
      resultsDialog.showModal();
      drawMapInto($('navReplayCanvas'), { done: points.length, nextIndex: -1, showYou: false, track: run.track });
    }, 900);
  }

  $('navAgainBtn').addEventListener('click', () => { resultsDialog.close(); restart(); });
  $('navBackToMapBtn').addEventListener('click', () => { resultsDialog.close(); stop(); });
  $('closeNavResultsBtn').addEventListener('click', () => { resultsDialog.close(); stop(); });
  resultsDialog.addEventListener('cancel', (event) => { event.preventDefault(); resultsDialog.close(); stop(); });

  syncSoundButton();
  applyLevel('normal');

  return {
    openSetup,
    frame,
    stop,
    get active() { return phase !== 'idle'; },
    get phase() { return phase; },
    // Test hook: jump next to the control being sought (used by automated browser checks).
    debugTeleport() {
      const next = points[run?.next];
      if (!next || phase !== 'running') return;
      Object.assign(api.observer, { u: next.u + .001, v: next.v });
    },
    // Test hooks: toggle the drone (same as typing the cheat) and read its state.
    debugDrone() { toggleDrone(); },
    // Test hook: put the first camel `meters` ahead of the walker (state 'graze' or 'chase').
    debugCamel(meters = 80, state = 'graze', turn = 180) {
      const camel = world?.camels?.find((c) => c.data);
      if (!camel || !run) return false;
      const o = api.observer;
      const h = o.heading * Math.PI / 180;
      Object.assign(camel.data, {
        u: clamp(o.u + Math.sin(h) * meters / api.extent(), .01, .99), v: clamp(o.v - Math.cos(h) * meters / api.extent(), .01, .99),
        state, timer: state === 'chase' ? 20 : state === 'rest' ? 30 : 0, wanderTimer: 99, target: null, aggression: 1, heading: (o.heading + turn) % 360,
      });
      // Aim the view at it (ground heights in display metres, as drawn).
      const exaggeration = api.verticalScale() / api.metersToWorld();
      const rise = (groundAt(camel.data.u, camel.data.v) - groundAt(o.u, o.v)) * exaggeration + 1.4 * camelScale() - 2.1;
      o.tilt = clamp(Math.atan2(rise, meters) * 180 / Math.PI, -40, 35);
      return true;
    },
    // Test hook: set the sky clock (hours on the evening clock).
    debugClock(hour) {
      if (!run?.night) return;
      run.clock = hour;
      run.skyTimer = 0;
      applySky(skyState(run.clock, moonDay));
    },
    // Test hook: stand at a map position with a heading.
    debugPlace(u, v, heading = 0) {
      if (run) Object.assign(api.observer, { u, v, heading, tilt: -6 });
    },
    // Test hook: stand `meters` south of the next control, facing it.
    debugApproach(meters = 60) {
      const next = points[run?.next];
      if (!next) return;
      Object.assign(api.observer, { u: next.u, v: Math.min(.998, next.v + meters / api.extent()), heading: 0, tilt: -2 });
    },
    stats: () => (run ? {
      phase, level, settings: { ...settings }, next: run.next, elapsed: run.elapsed, peeks: run.peeks, walked: run.walked, ascent: run.ascent, splits: run.splits.length,
      drone: { active: run.drone, landing: run.landing, used: run.droneUsed, agl: run.drone ? droneAgl() : 0, battery: run.battery, flown: run.flown,
        fpv: run.fpv, speedKmh: Math.round(run.droneSpeed * 3.6), maxKmh: Math.round(run.maxSpeed * 3.6), tricks: run.tricks, crashes: run.crashes, fov: run.fov, roll: api.observer.roll || 0 },
      camels: (world?.camels || []).filter((camel) => camel.data).map((camel) => ({ u: camel.data.u, v: camel.data.v, state: camel.data.state, distance: metersBetween(camel.data, api.observer, api.extent()) })),
      camelCatches: run.camelCatches, camelEscapes: run.camelEscapes, camelSpotted: run.camelSpotted, stun: run.stun, penalty: penaltySeconds(),
      route: points.map(({ u, v }) => ({ u, v })),
      night: run.night ? { clock: run.clock, lamp: run.lamp, dark: run.sky?.dark, moonlight: run.sky?.moonlight, moonAlt: run.sky?.moonAlt, moonAz: run.sky?.moonAz, sunAlt: run.sky?.sunAlt, phase: run.sky?.phase.name, stars: run.sky?.stars } : null,
    } : { phase }),
  };
}
