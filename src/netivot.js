// The cave blooper's scenes (see docs/NAVIGATION.md): the cave in the field, its dark tunnel,
// and the road through the sky that ends at the "ברוך הבא לנתיבות" sign. Built in code.
// Units are metres; each special scene has its own camera and covers the whole view.

import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { rockGeometry, addSurface } from './field-models.js';

const hash = (x, y, z) => { const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return s - Math.floor(s); };

// ——— In the field: a limestone mound with a dark mouth facing −z ———
export function createCaveMound() {
  const group = new THREE.Group();
  const rock = addSurface(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .92 }), 'rock');
  const mound = new THREE.Mesh(rockGeometry(11.3, 2), rock);
  mound.scale.set(7, 5.5, 4.2);
  mound.position.y = -1.2;
  mound.castShadow = true;
  mound.receiveShadow = true;
  // The mouth: a dark arch in a rough rocky rim, a little proud of the mound's face.
  const arch = new THREE.Shape();
  arch.moveTo(-1.7, 0);
  arch.lineTo(-1.7, 1.4);
  arch.absarc(0, 1.4, 1.7, Math.PI, 0, true);
  arch.lineTo(1.7, 0);
  arch.lineTo(-1.7, 0);
  const mouth = new THREE.Mesh(new THREE.ShapeGeometry(arch, 16), new THREE.MeshBasicMaterial({ color: 0x050403 }));
  mouth.position.set(0, -.1, -5.6);
  mouth.rotation.y = Math.PI;
  // A dark passage behind the mouth, so it reads as a hole however the rock bulges.
  const passage = new THREE.Mesh(new THREE.BoxGeometry(3.3, 3, 4.5), new THREE.MeshBasicMaterial({ color: 0x050403 }));
  passage.position.set(0, 1.4, -3.3);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(1.85, .5, 6, 16, Math.PI), rock);
  rim.position.set(0, 1.3, -5.5);
  const boulders = [[-2.8, -.2, -5.2, 1.2], [2.7, -.3, -5.0, 1.0], [-1.4, -.5, -6.6, .6], [2.0, -.5, -7.0, .5]].map(([x, y, z, s], i) => {
    const b = new THREE.Mesh(rockGeometry(i * 2.1 + .4), rock);
    b.position.set(x, y, z);
    b.scale.setScalar(s);
    b.castShadow = true;
    return b;
  });
  group.add(mound, passage, mouth, rim, ...boulders);
  return { group, entranceDepth: 5.8, materials: [rock, mouth.material] };
}

function renderOver(renderer, scene, camera, mainCamera) {
  camera.aspect = mainCamera.aspect;
  camera.fov = mainCamera.fov;
  camera.updateProjectionMatrix();
  const autoClear = renderer.autoClear;
  renderer.autoClear = false;
  renderer.clearDepth();
  renderer.render(scene, camera);
  renderer.autoClear = autoClear;
}

function background(color) {
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(400, 16, 12), new THREE.MeshBasicMaterial({ color, side: THREE.BackSide, depthWrite: false, fog: false }));
  sphere.renderOrder = -10;
  return sphere;
}

// ——— Inside: a winding rock tunnel lit only by your torch ———
export const CAVE_LENGTH = 15;
export function createCaveInterior() {
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x000000, 3, 13);
  const camera = new THREE.PerspectiveCamera(65, 1, .05, 450);
  const path = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 1.3, 1), new THREE.Vector3(.4, 1.25, -5), new THREE.Vector3(-.6, 1.1, -11), new THREE.Vector3(.3, 1.0, -18)]);
  let tunnel = new THREE.TubeGeometry(path, 60, 1.9, 14, false);
  tunnel.deleteAttribute('uv');
  tunnel = mergeVertices(tunnel);
  const p = tunnel.attributes.position;
  const centre = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    const v = new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i));
    path.getPointAt(Math.min(1, Math.max(0, (1 - v.z) / 19)), centre);
    const out = v.clone().sub(centre);
    const n = hash(Math.round(v.x * 3), Math.round(v.y * 3), Math.round(v.z * 3));
    out.multiplyScalar(.85 + n * .35);
    v.copy(centre).add(out);
    v.y = Math.max(v.y, 0); // a floor to walk on
    p.setXYZ(i, v.x, v.y, v.z);
  }
  tunnel.computeVertexNormals();
  const walls = new THREE.Mesh(tunnel, new THREE.MeshStandardMaterial({ color: 0x6e6152, roughness: .95, side: THREE.BackSide, flatShading: true }));
  const torch = new THREE.SpotLight(0xfff1dc, 6, 16, .55, .5, 1.2);
  const target = new THREE.Object3D();
  torch.target = target;
  const ambient = new THREE.HemisphereLight(0x8090a0, 0x201810, .06);
  scene.add(background(0x000000), walls, torch, target, ambient, camera);
  return {
    scene, camera,
    // progress in metres from the mouth; yaw/pitch in degrees; torch 0..1.
    update({ progress, yaw, pitch, x, torch: power, daylight }) {
      camera.position.set(x, 1.6, -progress);
      const h = yaw * Math.PI / 180;
      const t = pitch * Math.PI / 180;
      camera.lookAt(camera.position.x + Math.sin(h) * Math.cos(t), 1.6 + Math.sin(t), camera.position.z - Math.cos(h) * Math.cos(t));
      torch.position.copy(camera.position);
      target.position.set(camera.position.x + Math.sin(h) * 3, 1.2 + Math.sin(t) * 3, camera.position.z - Math.cos(h) * 3);
      target.updateMatrixWorld();
      torch.intensity = 6 * power;
      // Daylight from the mouth fades within a few metres.
      ambient.intensity = .02 + .5 * daylight * Math.max(0, 1 - progress / 5);
    },
    render(renderer, mainCamera) { renderOver(renderer, scene, camera, mainCamera); },
  };
}

// ——— The road through the sky ———
function canvasTexture(width, height, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext('2d'), width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function asphalt() {
  const texture = canvasTexture(256, 512, (ctx, w, h) => {
    ctx.fillStyle = '#3c3d3f';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 9000; i++) {
      const g = 45 + Math.random() * 40;
      ctx.fillStyle = `rgb(${g},${g},${g + 2})`;
      ctx.fillRect(Math.random() * w, Math.random() * h, 1.5, 1.5);
    }
    ctx.fillStyle = '#e9e6dc';
    ctx.fillRect(10, 0, 7, h);      // edge lines
    ctx.fillRect(w - 17, 0, 7, h);
    ctx.fillStyle = '#e8c547';
    ctx.fillRect(w / 2 - 4, 40, 8, 180); // dashed centre line
    ctx.fillRect(w / 2 - 4, 296, 8, 180);
  });
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

function welcomeSign() {
  return canvasTexture(1024, 440, (ctx, w, h) => {
    ctx.fillStyle = '#f7f7f2';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#1d4e8f';
    ctx.lineWidth = 26;
    ctx.strokeRect(13, 13, w - 26, h - 26);
    ctx.fillStyle = '#1d4e8f';
    ctx.direction = 'rtl';
    ctx.textAlign = 'center';
    ctx.font = '700 70px Heebo, Arial, sans-serif';
    ctx.fillText('ברוך הבא', w / 2, 170);
    ctx.font = '800 130px Heebo, Arial, sans-serif';
    ctx.fillText('לנתיבות', w / 2, 330);
  });
}

function cloudTexture() {
  return canvasTexture(256, 256, (ctx, w) => {
    for (let i = 0; i < 14; i++) {
      const x = w * (.25 + Math.random() * .5);
      const y = w * (.38 + Math.random() * .24);
      const r = w * (.12 + Math.random() * .14);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(255,255,255,.9)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

export const ROAD = { length: 70, width: 7, signAt: 52 };

export function createSkyRoad() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(65, 1, .05, 450);
  const sky = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `varying vec3 vDir; void main(){ float h = vDir.y;
      vec3 top = vec3(.16, .38, .78); vec3 mid = vec3(.62, .78, .95); vec3 low = vec3(.85, .9, .97);
      vec3 c = h > 0.0 ? mix(mid, top, pow(h, .6)) : mix(mid, low, pow(-h, .7));
      gl_FragColor = vec4(c, 1.0); }`,
  }));
  sky.renderOrder = -10;
  const texture = asphalt();
  texture.repeat.set(1, ROAD.length / 14);
  const top = new THREE.MeshStandardMaterial({ map: texture, roughness: .9 });
  const side = new THREE.MeshStandardMaterial({ color: 0x55534e, roughness: 1 });
  const slab = new THREE.Mesh(new THREE.BoxGeometry(ROAD.width, .6, ROAD.length), [side, side, top, side, side, side]);
  slab.position.set(0, -.3, -ROAD.length / 2 + 4);
  // The sign: two poles and the board, on the right-hand side.
  const signTexture = welcomeSign();
  const board = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.38, .08), [side, side, side, side, new THREE.MeshStandardMaterial({ map: signTexture, roughness: .6 }), side]);
  board.position.set(ROAD.width / 2 - .6, 2.6, -ROAD.signAt);
  board.rotation.y = -.25;
  const poleMaterial = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: .6, roughness: .4 });
  const poles = [-1.2, 1.2].map((dx) => {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(.05, .05, 3.3, 10), poleMaterial);
    pole.position.set(board.position.x + dx * Math.cos(.25), 1.65, -ROAD.signAt + dx * Math.sin(.25));
    return pole;
  });
  // Clouds all around and below: there is nothing but sky.
  const cloud = cloudTexture();
  const clouds = [];
  for (let i = 0; i < 46; i++) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: cloud, transparent: true, depthWrite: false, opacity: .85 }));
    const a = Math.random() * Math.PI * 2;
    const r = 25 + Math.random() * 140;
    sprite.position.set(Math.cos(a) * r, -30 - Math.random() * 60 + (i % 3 === 0 ? 50 + Math.random() * 30 : 0), -ROAD.length / 2 + Math.sin(a) * r);
    sprite.scale.setScalar(30 + Math.random() * 40);
    clouds.push(sprite);
  }
  const sun = new THREE.DirectionalLight(0xfff4e0, 2.4);
  sun.position.set(-20, 40, 10);
  scene.add(sky, slab, board, ...poles, ...clouds, sun, new THREE.HemisphereLight(0xdfeaff, 0x8a8f99, 1.1));
  return {
    scene, camera,
    update({ distance, x, yaw, pitch, bob }) {
      camera.position.set(x, 1.7 + bob, -distance);
      const h = yaw * Math.PI / 180;
      const t = pitch * Math.PI / 180;
      camera.lookAt(camera.position.x + Math.sin(h) * Math.cos(t), camera.position.y + Math.sin(t), camera.position.z - Math.cos(h) * Math.cos(t));
    },
    render(renderer, mainCamera) { renderOver(renderer, scene, camera, mainCamera); },
  };
}
