// Models for the navigation game's field, built in code (no downloaded assets): Aleppo pines
// and oaks, shrubs, limestone rocks, grass tufts, a rigged dromedary, the walker's hands, and
// dust. Plus the wind sway shared by everything that moves in the wind. See docs/NAVIGATION.md.
//
// Geometry is in metres (y up, facing −z); nav-game.js scales it to the world.

import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

// ——— Wind (nav-game.js updates these every frame) ———
export const windUniforms = {
  uTime: { value: 0 },
  uWindDir: { value: new THREE.Vector2(1, 0) },  // blowing towards (x east, y = z south)
  uWindStrength: { value: .3 },
  uMetersPerUnit: { value: 400 },
};

// Photographed surfaces (field-engine.js loads them): limestone for rocks, leaves for
// crowns and shrubs, bark for trunks. Until they arrive `ready` is 0 and nothing changes.
export const surfaceTextures = {
  rockMap: { value: null }, rockNormal: { value: null }, leafMap: { value: null }, barkMap: { value: null }, ready: { value: 0 },
};

// Bend vertices downwind, more towards the top (local y / height), with a flutter and gust
// waves rolling across the field. Works for plain and instanced meshes.
export function addWindSway(material, { height = 1, amount = .1, key = 'sway' } = {}) {
  material.userData.sway = { height, amount, key };
  return installShader(material);
}

// Texture a material from three sides in world metres: 'rock' (colour + relief) or
// 'plant' (leaf detail on green, bark on brown vertices).
export function addSurface(material, kind) {
  material.userData.surface = kind;
  return installShader(material);
}

function installShader(material) {
  const sway = material.userData.sway;
  const surface = material.userData.surface;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, windUniforms);
    let vs = shader.vertexShader.replace('#include <common>', `#include <common>
      uniform float uTime; uniform vec2 uWindDir; uniform float uWindStrength; uniform float uMetersPerUnit;
      varying vec3 vSurfPos; varying vec3 vSurfNormal;`);
    if (sway) {
      const reach = (sway.amount * sway.height).toFixed(4);
      vs = vs.replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          #ifdef USE_INSTANCING
            vec3 swayRoot = vec3(instanceMatrix[3]);
            mat3 swayRot = mat3(instanceMatrix);
          #else
            vec3 swayRoot = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
            mat3 swayRot = mat3(1.0);
          #endif
          vec2 rootM = swayRoot.xz * uMetersPerUnit;
          float wave = sin(dot(rootM, uWindDir) / 23.0 - uTime * 2.6) * .5 + .5;
          float flutter = sin(uTime * 3.7 + rootM.x * .37 + rootM.y * .21);
          float bend = pow(clamp(position.y / ${sway.height.toFixed(3)}, 0.0, 1.0), 1.6);
          float push = uWindStrength * (.55 + .7 * wave) + flutter * .18 * (.3 + uWindStrength);
          vec3 windLocal = normalize(transpose(swayRot) * vec3(uWindDir.x, 0.0, uWindDir.y) + vec3(1e-5));
          transformed += windLocal * push * bend * ${reach};
          transformed.y -= push * push * bend * ${reach} * .35;
        }`);
    }
    vs = vs.replace('#include <project_vertex>', `#include <project_vertex>
      #ifdef USE_INSTANCING
        vSurfPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        vSurfNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal);
      #else
        vSurfPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vSurfNormal = normalize(mat3(modelMatrix) * objectNormal);
      #endif`);
    shader.vertexShader = vs;
    if (surface) {
      Object.assign(shader.uniforms, { uRockMap: surfaceTextures.rockMap, uRockNormal: surfaceTextures.rockNormal, uLeafMap: surfaceTextures.leafMap, uBarkMap: surfaceTextures.barkMap, uSurfReady: surfaceTextures.ready });
      let fs = shader.fragmentShader.replace('#include <common>', `#include <common>
        uniform float uMetersPerUnit; uniform float uSurfReady;
        uniform sampler2D uRockMap; uniform sampler2D uRockNormal; uniform sampler2D uLeafMap; uniform sampler2D uBarkMap;
        varying vec3 vSurfPos; varying vec3 vSurfNormal;
        vec3 surfTri(sampler2D map, vec3 p, vec3 w) { return texture2D(map, p.zy).rgb * w.x + texture2D(map, p.xz).rgb * w.y + texture2D(map, p.xy).rgb * w.z; }`);
      if (surface === 'rock') {
        fs = fs.replace('#include <color_fragment>', `#include <color_fragment>
          vec3 surfW = pow(abs(normalize(vSurfNormal)), vec3(4.0)); surfW /= surfW.x + surfW.y + surfW.z;
          vec3 surfP = vSurfPos * uMetersPerUnit / 2.4;
          if (uSurfReady > 0.5) diffuseColor.rgb *= surfTri(uRockMap, surfP, surfW) * 1.7;`)
          .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          if (uSurfReady > 0.5) {
            vec3 rx = texture2D(uRockNormal, surfP.zy).xyz * 2.0 - 1.0;
            vec3 ry = texture2D(uRockNormal, surfP.xz).xyz * 2.0 - 1.0;
            vec3 rz = texture2D(uRockNormal, surfP.xy).xyz * 2.0 - 1.0;
            vec3 bump = vec3(0.0, rx.y, rx.x) * surfW.x + vec3(ry.x, 0.0, ry.y) * surfW.y + vec3(rz.x, rz.y, 0.0) * surfW.z;
            normal = normalize((viewMatrix * vec4(normalize(normalize(vSurfNormal) + bump * 1.2), 0.0)).xyz);
          }`);
      } else {
        fs = fs.replace('#include <color_fragment>', `#include <color_fragment>
          if (uSurfReady > 0.5) {
            vec3 surfW = pow(abs(normalize(vSurfNormal)), vec3(4.0)); surfW /= surfW.x + surfW.y + surfW.z;
            vec3 surfP = vSurfPos * uMetersPerUnit;
            #ifdef USE_COLOR
              float bark = step(vColor.g, vColor.r);
            #else
              float bark = 0.0;
            #endif
            vec3 leaf = surfTri(uLeafMap, surfP / 1.1, surfW);
            float leafDetail = dot(leaf, vec3(.3, .5, .2)) * 2.6;
            vec3 barkT = surfTri(uBarkMap, surfP / .9, surfW) * 2.0;
            diffuseColor.rgb *= mix(vec3(mix(.8, 1.4, clamp(leafDetail, 0.0, 1.0))), barkT, bark);
          }`);
      }
      shader.fragmentShader = fs;
    }
  };
  material.customProgramCacheKey = () => `field-${sway ? sway.key : 'still'}-${surface || 'plain'}`;
  return material;
}

// ——— Geometry helpers ———
const hash3 = (x, y, z) => {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
};
// Smooth 3D value noise from the position, so shared vertices move together.
function noise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const f = (t) => t * t * (3 - 2 * t);
  const fx = f(x - xi), fy = f(y - yi), fz = f(z - zi);
  const lerp = (a, b, t) => a + (b - a) * t;
  const c = (dx, dy, dz) => hash3(xi + dx, yi + dy, zi + dz);
  return lerp(lerp(lerp(c(0, 0, 0), c(1, 0, 0), fx), lerp(c(0, 1, 0), c(1, 1, 0), fx), fy),
    lerp(lerp(c(0, 0, 1), c(1, 0, 1), fx), lerp(c(0, 1, 1), c(1, 1, 1), fx), fy), fz);
}

// Smooth-shaded blob: a sphere pushed in and out by noise, then scaled and moved.
function blob({ detail = 2, rough = .25, freq = 1.6, seed = 0, scale = [1, 1, 1], at = [0, 0, 0], flatBottom = null }) {
  let g = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  g = mergeVertices(g);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = noise3(x * freq + seed, y * freq + seed * 1.3, z * freq - seed) * .7 + noise3(x * freq * 2.7, y * freq * 2.7 + seed, z * freq * 2.7) * .3;
    const k = 1 + (n - .5) * 2 * rough;
    x *= k * scale[0]; y *= k * scale[1]; z *= k * scale[2];
    if (flatBottom !== null) y = Math.max(y, flatBottom);
    p.setXYZ(i, x + at[0], y + at[1], z + at[2]);
  }
  g.computeVertexNormals();
  return g;
}

function tapered(rBottom, rTop, length, segments = 8) {
  let g = new THREE.CylinderGeometry(rTop, rBottom, length, segments, 3);
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  g.computeVertexNormals();
  return g;
}

// Paint a geometry: a base colour with a little noise, optionally darker towards the bottom.
function paint(g, hex, { vary = .08, seed = 0, dark = 0, height = 1 } = {}) {
  const c = new THREE.Color(hex);
  const p = g.attributes.position;
  const colours = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const n = noise3(p.getX(i) * 2.1 + seed, p.getY(i) * 2.1, p.getZ(i) * 2.1 - seed);
    const shade = (1 + (n - .5) * 2 * vary) * (1 - dark * (1 - Math.min(1, Math.max(0, p.getY(i) / height))));
    colours.set([c.r * shade, c.g * shade, c.b * shade], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  return g;
}

const merge = (parts) => {
  for (const part of parts) if (part.attributes.uv) part.deleteAttribute('uv');
  return mergeGeometries(parts.map((part) => (part.index ? part : mergeVertices(part))));
};

// ——— Vegetation and rocks ———
// Aleppo pine (אורן ירושלים): a leaning trunk and flat, irregular clumps of needles (~6 m).
export function pineGeometry(detail = 1) {
  const trunk = paint(tapered(.22, .1, 4.2, detail ? 7 : 4).rotateZ(.06).translate(.12, 2.1, 0), 0x5b4433, { vary: .15 });
  const branches = paint(merge([
    tapered(.07, .03, 1.6, 5).rotateZ(1.0).translate(.75, 3.4, .1),
    tapered(.06, .03, 1.4, 5).rotateZ(-1.1).rotateY(1.8).translate(-.3, 3.9, .5),
  ]), 0x5b4433);
  const clumps = [[.2, 4.6, 0, 1.5, .55], [1.2, 3.9, .3, 1.0, .42], [-.6, 4.1, .5, 1.1, .45], [.5, 5.2, -.4, 1.0, .4], [-.2, 3.6, -.6, .9, .38]]
    .map(([x, y, z, r, h], i) => paint(blob({ detail, rough: .3, freq: 2.2, seed: i * 3.1, scale: [r, h, r * .9], at: [x, y, z] }), 0x3c5527, { vary: .18, seed: i }));
  return merge([trunk, branches, ...clumps]);
}

// Kermes oak (אלון מצוי): a short trunk and a dense rounded crown (~4 m).
export function oakGeometry(detail = 1) {
  const trunk = paint(tapered(.2, .13, 1.6, 7).translate(0, .8, 0), 0x544235, { vary: .15 });
  const crown = [[0, 2.5, 0, 1.5, 1.1], [.9, 2.2, .3, 1.0, .8], [-.8, 2.3, -.2, 1.05, .85], [.2, 3.1, -.5, .95, .7], [-.3, 2.0, .9, .9, .7], [.5, 2.0, -.9, .85, .65]]
    .map(([x, y, z, r, h], i) => paint(blob({ detail, rough: .28, freq: 2, seed: 7 + i * 2.3, scale: [r, h, r], at: [x, y, z] }), 0x41592c, { vary: .2, seed: i }));
  return merge([trunk, ...crown]);
}

// Low cushion shrubs (סירה קוצנית, לוטם): grey-green, ~1 m.
export function shrubGeometry() {
  return paint(merge([
    blob({ detail: 1, rough: .35, freq: 2.6, seed: 2, scale: [1, .62, 1], at: [0, .38, 0], flatBottom: -.55 }),
    blob({ detail: 1, rough: .35, freq: 2.6, seed: 5, scale: [.62, .45, .62], at: [.65, .28, .2], flatBottom: -.55 }),
  ]), 0x6b7448, { vary: .22, dark: .35, height: .9 });
}

// Limestone boulder: knobbly, flat underneath, pale grey with darker weathering.
export function rockGeometry(seed = 0, detail = 1) {
  return paint(blob({ detail, rough: .42, freq: 1.3, seed, scale: [1, .62, .85], at: [0, .28, 0], flatBottom: -.45 }), 0xb3aa9a, { vary: .25, seed, dark: .25, height: .8 });
}

// A tuft of dry grass: thin bent blades, dark at the base and straw at the tips (~0.5 m).
export function grassTuftGeometry(blades = 7) {
  const positions = [];
  const colours = [];
  const base = new THREE.Color(0x77773f);
  const tip = new THREE.Color(0xd8c88e);
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * Math.PI * 2 + Math.sin(i * 7.1) * .6;
    const lean = .07 + .1 * hash3(i, 1, 2);
    const h = .18 + .2 * hash3(i, 3, 4);
    const w = .011;
    const ox = Math.cos(a) * .035, oz = Math.sin(a) * .035;
    const mid = [ox + Math.cos(a) * lean * .45, h * .55, oz + Math.sin(a) * lean * .45];
    const top = [ox + Math.cos(a) * lean, h, oz + Math.sin(a) * lean];
    const px = -Math.sin(a) * w, pz = Math.cos(a) * w;
    // two triangles up to the middle, one to the tip
    const q = [[ox - px, 0, oz - pz], [ox + px, 0, oz + pz], [mid[0] + px * .6, mid[1], mid[2] + pz * .6], [mid[0] - px * .6, mid[1], mid[2] - pz * .6]];
    // Both windings, so the blade is seen from either side without a dark back face.
    for (const tri of [[q[0], q[1], q[2]], [q[0], q[2], q[3]], [q[3], q[2], top], [q[2], q[1], q[0]], [q[3], q[2], q[0]], [top, q[2], q[3]]]) {
      for (const v of tri) {
        positions.push(...v);
        const c = base.clone().lerp(tip, Math.min(1, v[1] / h));
        colours.push(c.r, c.g, c.b);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  g.computeVertexNormals();
  // Grass is lit mostly from above: point the normals up so blades don't flicker dark.
  const n = g.attributes.normal;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
  n.needsUpdate = true;
  return g;
}

// ——— Dromedary ———
// Rigged in parts so it can walk: legs with a hip and a knee, a curved neck that lowers to
// graze. Origin at the feet, facing −z; about 2.2 m at the hump, 3 m long.
let camelCache = null;
function camelGeometries() {
  if (camelCache) return camelCache;
  // Body: an ellipsoid with a hump, a deep chest and a tucked belly.
  let body = new THREE.SphereGeometry(1, 32, 20);
  body.deleteAttribute('uv');
  body = mergeVertices(body);
  const p = body.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    // A rounded hump: broad at the base, softly domed on top.
    const along = Math.exp(-(((z - .02) / .5) ** 2));
    const hump = Math.max(0, y) ** .9 * along;
    const chest = Math.max(0, -z) * Math.max(0, -y) * .25;
    let X = x * .42 * (1 - .22 * hump);
    let Y = y * .4 + hump * .5 * (1 - .25 * Math.max(0, y) ** 4) - chest * .2;
    const Z = z * .95;
    if (y < 0 && z > -.2) Y *= .9; // belly tucked up behind the chest
    X *= 1 + .06 * Math.cos(z * 2);
    p.setXYZ(i, X, Y + 1.55, Z);
  }
  body.computeVertexNormals();
  const tail = merge([tapered(.035, .02, .6, 6).rotateX(.25).translate(0, 1.36, .9), blob({ detail: 1, rough: .3, scale: [.05, .1, .05], at: [0, 1.06, .98] })]);

  // Neck: a tapering tube along the camel's S-curve, then the head with its long muzzle.
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -.08, -.38), new THREE.Vector3(0, .02, -.72),
    new THREE.Vector3(0, .34, -.95), new THREE.Vector3(0, .62, -1.02),
  ]);
  const rings = 24;
  const sides = 10;
  let neck = new THREE.TubeGeometry(curve, rings, 1, sides, false);
  const np = neck.attributes.position;
  for (let r = 0; r <= rings; r++) {
    const t = r / rings;
    const centre = curve.getPointAt(t);
    const radius = .2 - .1 * t;
    for (let s = 0; s <= sides; s++) {
      const i = r * (sides + 1) + s;
      np.setXYZ(i, centre.x + (np.getX(i) - centre.x) * radius, centre.y + (np.getY(i) - centre.y) * radius * 1.15, centre.z + (np.getZ(i) - centre.z) * radius);
    }
  }
  neck.deleteAttribute('uv');
  neck = mergeVertices(neck);
  neck.computeVertexNormals();
  const head = merge([
    blob({ detail: 2, rough: .08, scale: [.12, .14, .27], at: [0, .66, -1.17] }).rotateX(0),
    blob({ detail: 2, rough: .06, scale: [.095, .1, .12], at: [0, .6, -1.38] }),
    new THREE.ConeGeometry(.035, .1, 5).translate(-.08, .8, -1.08),
    new THREE.ConeGeometry(.035, .1, 5).translate(.08, .8, -1.08),
  ]);
  const neckHead = merge([neck, head]);
  neckHead.computeVertexNormals();

  const upper = tapered(.11, .075, .76, 8).translate(0, -.38, 0);
  const lower = merge([blob({ detail: 1, rough: .1, scale: [.08, .08, .08], at: [0, 0, 0] }), tapered(.06, .05, .66, 7).translate(0, -.33, 0),
    blob({ detail: 1, rough: .1, scale: [.11, .05, .14], at: [0, -.68, -.02], flatBottom: -.04 })]);
  const eye = new THREE.SphereGeometry(.03, 8, 6);
  camelCache = { body: merge([body, tail]), neckHead, upper, lower, eye };
  return camelCache;
}

export function createCamel(coat) {
  const g = camelGeometries();
  const body = new THREE.MeshStandardMaterial({ color: coat, roughness: .92 });
  const legs = new THREE.MeshStandardMaterial({ color: new THREE.Color(coat).multiplyScalar(.85), roughness: .92 });
  const eyeMaterial = new THREE.MeshBasicMaterial({ color: 0xd9ffc8, transparent: true, opacity: 0, toneMapped: false, depthWrite: false, blending: THREE.AdditiveBlending });
  const root = new THREE.Group();
  const torso = new THREE.Mesh(g.body, body);
  torso.castShadow = true;
  root.add(torso);
  const neck = new THREE.Group();
  neck.position.set(0, 1.62, -.78);
  const neckMesh = new THREE.Mesh(g.neckHead, body);
  neckMesh.castShadow = true;
  neck.add(neckMesh);
  const eyes = new THREE.Group();
  for (const x of [-.1, .1]) {
    const ball = new THREE.Mesh(g.eye, eyeMaterial);
    ball.position.set(x, .7, -1.25);
    eyes.add(ball);
  }
  eyes.visible = false;
  neck.add(eyes);
  root.add(neck);
  // Legs: hip → upper leg → knee → lower leg and the broad pad of the foot.
  const legRig = [[-.2, -.5], [.2, -.5], [-.2, .5], [.2, .5]].map(([x, z]) => {
    const hip = new THREE.Group();
    hip.position.set(x, 1.45, z);
    const upperMesh = new THREE.Mesh(g.upper, legs);
    upperMesh.castShadow = true;
    hip.add(upperMesh);
    const knee = new THREE.Group();
    knee.position.set(0, -.76, 0);
    const lowerMesh = new THREE.Mesh(g.lower, legs);
    lowerMesh.castShadow = true;
    knee.add(lowerMesh);
    hip.add(knee);
    root.add(hip);
    return { hip, knee };
  });
  return { root, neck, legs: legRig, eyes, eyeMaterial, materials: [body, legs, eyeMaterial] };
}

// Pacing gait (both legs on a side together), knees folding as a leg swings forward.
export function poseCamel(camel, { phase, swing, neckPose }) {
  camel.legs.forEach(({ hip, knee }, i) => {
    const side = i % 2 ? Math.PI : 0;
    const s = Math.sin(phase + side);
    hip.rotation.x = s * swing;
    knee.rotation.x = Math.max(0, Math.cos(phase + side)) * swing * 1.4 * (i < 2 ? -1 : 1);
  });
  camel.neck.rotation.x = neckPose;
}

// ——— The walker's hands (first person) ———
// Drawn in their own pass over the field, with their own near plane. The right hand holds a
// baseplate compass whose needle points north; at night the left holds a torch.
export function createHands() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(65, 1, .01, 5);
  const hemi = new THREE.HemisphereLight(0xf2f5ff, 0x5a6650, 1.1);
  const key = new THREE.DirectionalLight(0xfff1d6, 2.2);
  key.position.set(-1, 2, .5);
  const torchLight = new THREE.PointLight(0xfff1dc, 0, 1.5, 0);
  torchLight.position.set(-.2, -.2, -.5);
  scene.add(hemi, key, torchLight);
  const skin = new THREE.MeshStandardMaterial({ color: 0xc08a66, roughness: .65 });
  const sleeve = new THREE.MeshStandardMaterial({ color: 0x66684a, roughness: .95 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x24262a, roughness: .4, metalness: .5 });
  const lens = new THREE.MeshBasicMaterial({ color: 0x3a3a34, toneMapped: false });
  const plate = new THREE.MeshStandardMaterial({ color: 0xd6eef4, roughness: .25, transparent: true, opacity: .55 });
  const red = new THREE.MeshStandardMaterial({ color: 0xd8262a, roughness: .5, emissive: 0x330000 });
  const white = new THREE.MeshStandardMaterial({ color: 0xf2f2ea, roughness: .5, emissive: 0x222222 });

  function arm(sideSign) {
    const group = new THREE.Group();
    const forearm = new THREE.Mesh(new THREE.CapsuleGeometry(.04, .3, 6, 12), skin);
    forearm.rotation.x = Math.PI / 2 - .35;
    forearm.position.set(0, -.04, .16);
    const cuff = new THREE.Mesh(new THREE.CapsuleGeometry(.052, .14, 6, 12), sleeve);
    cuff.rotation.copy(forearm.rotation);
    cuff.position.set(0, -.1, .32);
    const hand = new THREE.Group();
    const palm = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), skin);
    palm.scale.set(.045, .028, .055);
    const fingers = new THREE.Mesh(new THREE.CapsuleGeometry(.018, .06, 4, 8), skin);
    fingers.rotation.z = Math.PI / 2;
    fingers.position.set(0, .012, -.045);
    const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(.014, .04, 4, 8), skin);
    thumb.rotation.set(.4, 0, Math.PI / 2 - .6 * sideSign);
    thumb.position.set(-.04 * sideSign, .012, -.01);
    hand.add(palm, fingers, thumb);
    group.add(forearm, cuff, hand);
    return { group, hand };
  }

  const right = arm(1);
  right.group.position.set(.2, -.27, -.42);
  // Baseplate compass on the right palm; the needle turns to keep pointing north.
  const compass = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(.06, .004, .1), plate);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(.022, .004, 8, 24), dark);
  ring.rotation.x = Math.PI / 2;
  ring.position.set(0, .004, .01);
  const needle = new THREE.Group();
  const north = new THREE.Mesh(new THREE.ConeGeometry(.005, .02, 4), red);
  north.rotation.x = -Math.PI / 2;
  north.position.z = -.01;
  const south = new THREE.Mesh(new THREE.ConeGeometry(.005, .02, 4), white);
  south.rotation.x = Math.PI / 2;
  south.position.z = .01;
  needle.add(north, south);
  needle.position.set(0, .007, .01);
  const arrow = new THREE.Mesh(new THREE.BoxGeometry(.004, .002, .04), red);
  arrow.position.set(0, .004, -.035);
  compass.add(base, ring, needle, arrow);
  compass.position.set(0, .03, -.02);
  right.hand.add(compass);

  const left = arm(-1);
  left.group.position.set(-.21, -.29, -.44);
  const torch = new THREE.Group();
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(.016, .016, .15, 16), dark);
  tube.rotation.x = Math.PI / 2;
  const headPiece = new THREE.Mesh(new THREE.CylinderGeometry(.025, .017, .04, 16), dark);
  headPiece.rotation.x = Math.PI / 2;
  headPiece.position.z = -.09;
  const glass = new THREE.Mesh(new THREE.CircleGeometry(.022, 20), lens);
  glass.position.z = -.111;
  glass.rotation.y = Math.PI;
  torch.add(tube, headPiece, glass);
  torch.position.set(0, .03, -.03);
  left.hand.add(torch);

  scene.add(right.group, left.group);
  const rest = { right: right.group.position.clone(), left: left.group.position.clone() };
  let time = 0;

  return {
    scene, camera, torch,
    // walk: step phase (two steps per 2π·…), pace 0 standing … 1 running; heading in degrees.
    update({ dt, walk, pace, running, heading, torchOn, showTorch, light, stunned }) {
      time += dt;
      const swing = pace * (running ? .075 : .035);
      const s = Math.sin(walk * Math.PI);
      const breathe = Math.sin(time * 1.4) * .004;
      const shake = stunned ? (Math.random() - .5) * .02 : 0;
      right.group.position.set(rest.right.x, rest.right.y + Math.abs(s) * swing * .35 + breathe + shake, rest.right.z + s * swing);
      right.group.rotation.x = -s * swing * 1.5;
      const pump = running ? .05 : 0;
      left.group.position.set(rest.left.x, rest.left.y + Math.abs(s) * swing * .35 + breathe + pump * .3 + shake, rest.left.z - s * swing);
      left.group.rotation.x = s * swing * 1.5;
      left.group.visible = showTorch || running;
      torch.visible = showTorch;
      needle.rotation.y = heading * Math.PI / 180; // keeps pointing north as you turn
      lens.color.setHex(torchOn ? 0xfff6d8 : 0x3a3a34);
      torchLight.intensity = torchOn ? .8 : 0;
      hemi.intensity = light.hemi;
      hemi.color.copy(light.sky);
      hemi.groundColor.copy(light.ground);
      key.intensity = light.key * .8;
      key.color.copy(light.keyColor);
    },
    render(renderer, mainCamera) {
      camera.fov = mainCamera.fov;
      camera.aspect = mainCamera.aspect;
      camera.updateProjectionMatrix();
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(scene, camera);
      renderer.autoClear = autoClear;
    },
    dispose() {
      scene.traverse((o) => { o.geometry?.dispose(); });
      for (const m of [skin, sleeve, dark, lens, plate, red, white]) m.dispose();
    },
  };
}

// ——— Dust: soft puffs that drift with the wind and fade ———
export function createDust(count = 240) {
  const positions = new Float32Array(count * 3);
  const alpha = new Float32Array(count);
  const size = new Float32Array(count);
  const velocity = new Float32Array(count * 3);
  const life = new Float32Array(count);
  const age = new Float32Array(count).fill(1e9);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('size', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uColor: { value: new THREE.Color(0xc9b89a) }, uScale: { value: 500 } },
    vertexShader: `attribute float alpha; attribute float size; uniform float uScale; varying float vAlpha;
      void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vAlpha = alpha;
        gl_PointSize = clamp(size * uScale / -mv.z, 1.0, 160.0); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform vec3 uColor; varying float vAlpha;
      void main() { float d = length(gl_PointCoord - .5); float a = smoothstep(.5, .0, d) * vAlpha; if (a < .01) discard; gl_FragColor = vec4(uColor, a); }`,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 4;
  let next = 0;
  return {
    points,
    spawn(x, y, z, vx, vy, vz, seconds, worldSize) {
      const i = next;
      next = (next + 1) % count;
      positions.set([x, y, z], i * 3);
      velocity.set([vx, vy, vz], i * 3);
      life[i] = seconds;
      age[i] = 0;
      size[i] = worldSize;
    },
    update(dt, scale, colour) {
      material.uniforms.uScale.value = scale;
      if (colour) material.uniforms.uColor.value.copy(colour);
      for (let i = 0; i < count; i++) {
        if (age[i] >= life[i]) { alpha[i] = 0; continue; }
        age[i] += dt;
        const t = age[i] / life[i];
        positions[i * 3] += velocity[i * 3] * dt;
        positions[i * 3 + 1] += velocity[i * 3 + 1] * dt;
        positions[i * 3 + 2] += velocity[i * 3 + 2] * dt;
        size[i] *= 1 + dt * .6;
        alpha[i] = Math.sin(Math.min(1, t) * Math.PI) * .45;
      }
      geometry.attributes.position.needsUpdate = true;
      geometry.attributes.alpha.needsUpdate = true;
      geometry.attributes.size.needsUpdate = true;
    },
  };
}
