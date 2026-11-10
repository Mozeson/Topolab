// What the 3D model shows on top of the terrain in the editor: the course (start, numbered
// controls, finish and the legs between them), the נ״צ markers and the place names, as on the
// 2D map. Also a pin that follows the map's pointer. Hidden in the navigation game, which
// has its own flags. scene.js owns the scene and calls sync() when something may have changed.

import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

const COURSE = '#c2187a';
const WAYPOINT = '#8a3f7d';

// A round badge (or a triangle for the start) with a number, as a texture.
function badgeTexture({ text = '', color = COURSE, shape = 'circle' }) {
  const size = 96;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const c = size / 2;
  ctx.lineWidth = 9;
  ctx.strokeStyle = color;
  ctx.fillStyle = 'rgba(255,255,255,.94)';
  ctx.beginPath();
  if (shape === 'triangle') { ctx.moveTo(c, 10); ctx.lineTo(size - 10, size - 14); ctx.lineTo(10, size - 14); ctx.closePath(); } else ctx.arc(c, c, c - 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  if (shape === 'double') { ctx.lineWidth = 6; ctx.beginPath(); ctx.arc(c, c, c - 24, 0, Math.PI * 2); ctx.stroke(); }
  if (text) {
    ctx.fillStyle = color;
    ctx.font = `800 ${text.length > 1 ? 44 : 52}px Heebo, Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, c, c + (shape === 'triangle' ? 12 : 3));
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// A place name with a light halo, as a texture; returns its aspect ratio too.
function nameTexture(text, { color = '#22231f', size = 44, weight = 700 }) {
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = `${weight} ${size}px Heebo, Arial, sans-serif`;
  const width = Math.ceil(probe.measureText(text).width) + 24;
  const height = Math.ceil(size * 1.5);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.font = probe.font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.direction = 'rtl';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 9;
  ctx.strokeStyle = 'rgba(255,255,250,.92)';
  ctx.strokeText(text, width / 2, height / 2);
  ctx.fillStyle = color;
  ctx.fillText(text, width / 2, height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, aspect: width / height };
}

const NAME_STYLE = {
  city: { size: 52, weight: 800, scale: 1.25 }, town: { size: 50, weight: 800, scale: 1.15 }, village: { size: 46, weight: 700, scale: 1 },
  quarter: { size: 42, weight: 600, scale: .85 }, hamlet: { size: 42, weight: 600, scale: .85 }, locality: { size: 40, weight: 500, scale: .8, color: '#5d4b33' },
  peak: { size: 42, weight: 700, scale: .9, color: '#5b3d22', mark: '▲ ' }, spring: { size: 40, weight: 600, scale: .8, color: '#1f6e9c' }, cave: { size: 40, weight: 600, scale: .8, color: '#4a3a2c' },
};

export function createView3dOverlay(api) {
  // api: { scene(), worldSize(), height(u, v), verticalScale(), resolution() → { x, y } }
  const group = new THREE.Group();
  group.name = 'view3d-overlay';
  const courseGroup = new THREE.Group();
  const namesGroup = new THREE.Group();
  const waypointGroup = new THREE.Group();
  group.add(courseGroup, namesGroup, waypointGroup);
  let key = '';
  let lineMaterial = null;
  let pin = null;
  const poleMaterial = new THREE.LineBasicMaterial({ color: 0x3a2a33, transparent: true, opacity: .75 });

  const world = (u, v, lift = 0) => {
    const W = api.worldSize();
    return new THREE.Vector3((u - .5) * W, api.height(u, v) * api.verticalScale() + lift, (v - .5) * W);
  };

  function clear(target) {
    for (const child of [...target.children]) {
      target.remove(child);
      child.geometry?.dispose?.();
      if (child.material && child.material !== poleMaterial && child.material !== lineMaterial) {
        child.material.map?.dispose?.();
        child.material.dispose?.();
      }
    }
  }

  // A sprite on a thin pole standing on the ground.
  function addPin(target, u, v, texture, { pole, size, aspect = 1 }) {
    const base = world(u, v);
    const top = base.clone();
    top.y += pole;
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([base, top]), poleMaterial);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, sizeAttenuation: false, depthWrite: false }));
    sprite.scale.set(size * aspect, size, 1);
    sprite.center.set(.5, 0);
    sprite.position.copy(top);
    sprite.renderOrder = 6;
    target.add(line, sprite);
  }

  function buildCourse(points, W) {
    clear(courseGroup);
    if (points.length < 1) return;
    // Legs follow the ground: sampled every ~1% of the map and lifted a little above it.
    if (points.length > 1) {
      const positions = [];
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        const steps = Math.max(2, Math.ceil(Math.hypot(b.u - a.u, b.v - a.v) / .01));
        for (let s = i === 1 ? 0 : 1; s <= steps; s++) {
          const t = s / steps;
          const p = world(a.u + (b.u - a.u) * t, a.v + (b.v - a.v) * t, W * .006);
          positions.push(p.x, p.y, p.z);
        }
      }
      lineMaterial ||= new LineMaterial({ color: new THREE.Color(COURSE).getHex(), linewidth: 3, transparent: true, opacity: .9 });
      const res = api.resolution();
      lineMaterial.resolution.set(res.x, res.y);
      const line = new Line2(new LineGeometry().setPositions(positions), lineMaterial);
      line.computeLineDistances();
      line.renderOrder = 5;
      courseGroup.add(line);
    }
    points.forEach((p) => {
      if (p.kind === 'finish' && p.implicit) return; // a loop: the finish is the start
      const texture = p.kind === 'start' ? badgeTexture({ shape: 'triangle' }) : p.kind === 'finish' ? badgeTexture({ shape: 'double' }) : badgeTexture({ text: String(p.number) });
      addPin(courseGroup, p.u, p.v, texture, { pole: W * .04, size: .044 });
    });
  }

  function buildNames(labels, W) {
    clear(namesGroup);
    // The model is small on screen: settlements and peaks only, the most important first.
    const shown = labels.filter((l) => ['city', 'town', 'village', 'hamlet', 'peak'].includes(l.kind)).slice(0, 10);
    for (const label of shown) {
      const style = NAME_STYLE[label.kind] || NAME_STYLE.locality;
      const text = `${style.mark || ''}${label.name}${label.ele != null ? ` ${label.ele}` : ''}`;
      const { texture, aspect } = nameTexture(text, style);
      addPin(namesGroup, label.u, label.v, texture, { pole: W * .022, size: .029 * style.scale, aspect });
    }
  }

  function buildWaypoints(waypoints, W) {
    clear(waypointGroup);
    waypoints.forEach((p, i) => addPin(waypointGroup, p.u, p.v, badgeTexture({ text: String(i + 1), color: WAYPOINT }), { pole: W * .03, size: .036 }));
  }

  return {
    group,
    // Rebuild what changed. `version` covers the terrain (heights, size, exaggeration).
    sync({ visible, show, course, labels, waypoints, version }) {
      group.visible = visible;
      if (!visible) return false;
      courseGroup.visible = show.course;
      namesGroup.visible = show.names;
      waypointGroup.visible = show.course;
      const next = `${version}|${course.map((p) => `${p.kind}${p.number || ''}:${p.u.toFixed(4)},${p.v.toFixed(4)}${p.implicit ? 'i' : ''}`).join(';')}|${labels.map((l) => `${l.name}${l.u.toFixed(3)}${l.v.toFixed(3)}`).join(';')}|${waypoints.map((p) => `${p.u.toFixed(4)},${p.v.toFixed(4)}`).join(';')}`;
      if (next === key) return false;
      key = next;
      const W = api.worldSize();
      buildCourse(course, W);
      buildNames(labels, W);
      buildWaypoints(waypoints, W);
      return true;
    },
    setResolution(x, y) { lineMaterial?.resolution.set(x, y); },
    // A small pin where the map's pointer is (null hides it).
    setPointer(point) {
      if (!point) { if (pin) pin.visible = false; return; }
      if (!pin) {
        pin = new THREE.Group();
        const material = new THREE.MeshBasicMaterial({ color: 0xe2552d, depthTest: false, transparent: true, opacity: .95 });
        const head = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), material);
        head.position.y = 5;
        const stem = new THREE.Mesh(new THREE.CylinderGeometry(.14, .14, 5, 6).translate(0, 2.5, 0), material);
        head.renderOrder = 11;
        stem.renderOrder = 11;
        pin.add(stem, head);
        group.add(pin);
      }
      const W = api.worldSize();
      pin.visible = true;
      pin.position.copy(world(point.u, point.v));
      pin.scale.setScalar(W * .012);
    },
  };
}
