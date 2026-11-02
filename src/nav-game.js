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
import { DRONE, stepAltitude, stepLanding, stepBattery, canReadNote, feedCheat } from './drone.js';

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

  function bestKey() {
    return `${courseKey(course, api.mapSize())}|${level}`;
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

    // Sky dome that follows the camera.
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
          sun: { value: new THREE.Vector3(-.45, .55, .5).normalize() },
        },
        vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 bottom; uniform vec3 sun; varying vec3 vDir;
          void main(){
            float h = vDir.y;
            vec3 c = h > 0.0 ? mix(horizon, top, pow(min(h * 1.6, 1.0), .75)) : mix(horizon, bottom, min(-h * 6.0, 1.0));
            float s = max(dot(normalize(vDir), sun), 0.0);
            c += vec3(1.0, .92, .75) * (pow(s, 220.0) * 1.2 + pow(s, 12.0) * .18);
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

    scene.add(group);
    return { group, flags, sky, droneShadow, textures: [orange, magenta, ...extras.textures] };
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
    };
    setDroneUi(false);
    Object.assign(api.observer, { u: startPoint.u, v: startPoint.v, heading: 0, tilt: -4, bob: 0 });
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
    const penalty = (run?.peeks || 0) * PEEK_PENALTY;
    $('navPenalty').hidden = !penalty;
    $('navPenalty').textContent = `עונש הצצות: +${penalty} ש׳`;
  }

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
    if (run?.drone) { api.observer.flyY = undefined; api.setDrone?.(false); }
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
    if (run?.drone) { api.observer.flyY = undefined; api.setDrone?.(false); }
    setDroneUi(false);
    stopBuzz();
    phase = 'idle';
    keys.clear();
    look = null;
    hud.hidden = true;
    $('navPause').hidden = true;
    $('navCountdown').hidden = true;
    resultsDialog.open && resultsDialog.close();
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
    run.landing = true;
    flash(reason || '🛬 נוחתים…', Boolean(reason));
  }

  function land() {
    const o = api.observer;
    run.drone = false;
    run.landing = false;
    o.flyY = undefined;
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
      const pitch = 150 + Math.min(1, run.droneSpeed / 120) * 70 + droneClimbInput * 15;
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
  // Five quick taps on the timer (the way in on touch screens).
  // Counted as a streak: each tap must come within 0.9 s of the previous one.
  $('navTimer').addEventListener('click', () => {
    const now = performance.now();
    const last = timerTaps[timerTaps.length - 1];
    timerTaps = last !== undefined && now - last < 900 ? [...timerTaps, now] : [now];
    if (timerTaps.length >= 5) { timerTaps = []; toggleDrone(); }
  });

  // ——— Input ———
  const MOVE_KEYS = new Set(['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight', 'KeyE', 'KeyQ', 'PageUp', 'PageDown']);
  document.addEventListener('keydown', (event) => {
    if (phase === 'idle' || phase === 'finished' || document.querySelector('dialog[open]')) return;
    if (event.code === 'Escape') { event.preventDefault(); phase === 'paused' ? resume() : pause(); return; }
    if (phase === 'paused') return;
    if (phase === 'running' && !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const cheat = feedCheat(cheatBuffer, event.key);
      cheatBuffer = cheat.buffer;
      if (cheat.matched) { event.preventDefault(); toggleDrone(); return; }
    }
    if (event.code === 'KeyM') { event.preventDefault(); if (!event.repeat) toggleMap(); return; }
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
    o.tilt = run?.drone ? clamp(o.tilt - (event.clientY - look.y) * .2, -89, 10) : clamp(o.tilt - (event.clientY - look.y) * .15, -40, 35);
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
      o.heading = (o.heading + turn * TURN_SPEED * dt + 360) % 360;
      const extent = api.extent();
      const moving = Math.hypot(forward, strafe) > .05;
      if (run.drone) {
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
    }
    api.updateCamera();
    if (world) {
      world.sky.position.copy(api.camera().position);
      if (run) updateFlags();
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
    const penalty = run.peeks * PEEK_PENALTY;
    $('navTimer').textContent = formatClock(run.elapsed + penalty);
    const pace = clamp(run.pace / 1.1, 0, 1);
    $('navPaceBar').style.width = `${Math.round(pace * 100)}%`;
    $('navPaceBar').style.background = `hsl(${Math.round(pace * 120)} 65% 58%)`;
    const g = Math.round(run.grade * 100);
    const slopeText = Math.abs(g) < 3 ? 'מישור' : g > 0 ? `עלייה ${g}%` : `ירידה ${-g}%`;
    const groundText = run.ground?.onPath ? 'דרך' : run.ground?.area || '';
    $('navSlopeText').textContent = run.drone ? '🚁 טיסה' : groundText ? `${slopeText} · ${groundText}` : slopeText;
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
    if (run.drone) { api.observer.flyY = undefined; api.setDrone?.(false); run.drone = false; setDroneUi(false); }
    stopBuzz();
    phase = 'finished';
    keys.clear();
    const extent = api.extent();
    const penalty = run.peeks * PEEK_PENALTY;
    const total = totalScore({ elapsed: run.elapsed, peeks: run.peeks, penaltyPerPeek: PEEK_PENALTY });
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
      drone: { active: run.drone, landing: run.landing, used: run.droneUsed, agl: run.drone ? droneAgl() : 0, battery: run.battery, flown: run.flown },
    } : { phase }),
  };
}
