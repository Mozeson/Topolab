// Engine v2 for the navigation game's field: real (CC0, Poly Haven) materials on the terrain,
// a photographic sky with image-based lighting, and a post-processing chain (ambient
// occlusion, bloom, colour grading). scene.js owns the renderer and calls this from game
// mode only; the map editor's 3D view is untouched. See docs/NAVIGATION.md ("מנוע v2").

import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const BASE = `${import.meta.env?.BASE_URL ?? '/'}assets/field/`;

// Terrain layers: [uniform prefix, file stem]. Albedo in sRGB, normals in linear (OpenGL).
const LAYERS = [['Grass', 'aerial_grass_rock'], ['Soil', 'red_laterite_soil_stones'], ['Rock', 'rock_boulder_dry']];

// A gentle grade after tone mapping: a touch more contrast and warmth, a soft vignette.
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 1 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uAmount; varying vec2 vUv;
    void main(){
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = src.rgb;
      float l = dot(c, vec3(.299, .587, .114));
      vec3 g = mix(vec3(l), c, 1.1);
      g = (g - .5) * 1.06 + .5;
      g *= vec3(1.025, 1.0, .965);
      vec2 d = vUv - .5;
      g *= 1.0 - dot(d, d) * .45;
      gl_FragColor = vec4(mix(c, clamp(g, 0.0, 1.0), uAmount), src.a);
    }`,
};

export function createFieldEngine({ renderer, scene, camera, terrainUniforms, metersToWorld }) {
  const loader = new THREE.TextureLoader();
  let loading = null;
  let skyTexture = null;
  let envMap = null;
  const sunDir = new THREE.Vector3(-10, 13, -9).normalize();
  let sunKnown = false;
  let composer = null;
  let passes = null;
  let active = false;
  let day = true;
  let full = true;

  function texture(file, srgb) {
    return new Promise((resolve) => {
      loader.load(BASE + file, (t) => {
        t.wrapS = THREE.RepeatWrapping;
        t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        if (srgb) t.colorSpace = THREE.SRGBColorSpace;
        resolve(t);
      }, undefined, () => resolve(null));
    });
  }

  // The HDR's brightest pixel is the sun: light the field from there so shadows match the sky.
  function findSun(hdr) {
    const { data, width, height } = hdr.image;
    let best = -1;
    let at = 0;
    const toFloat = data instanceof Uint16Array ? THREE.DataUtils.fromHalfFloat : (v) => v;
    for (let i = 0; i < width * height; i++) {
      const l = toFloat(data[i * 4]) * .2 + toFloat(data[i * 4 + 1]) * .7 + toFloat(data[i * 4 + 2]) * .1;
      if (l > best) { best = l; at = i; }
    }
    const u = (at % width + .5) / width;
    const row = Math.floor(at / width);
    const lat = (.5 - (row + .5) / height) * Math.PI;
    const phi = (u - .5) * Math.PI * 2;
    // three.js equirect lookup: u = atan(dir.z, dir.x) / 2π + .5, v = asin(dir.y) / π + .5
    sunDir.set(Math.cos(phi) * Math.cos(lat), Math.sin(lat), Math.sin(phi) * Math.cos(lat)).normalize();
    sunKnown = sunDir.y > .1;
  }

  function load() {
    if (loading) return loading;
    loading = (async () => {
      const maps = await Promise.all(LAYERS.flatMap(([, stem]) => [texture(`${stem}_diff_1k.jpg`, true), texture(`${stem}_nor_gl_1k.jpg`, false)]));
      if (maps.every(Boolean)) {
        LAYERS.forEach(([name], i) => {
          terrainUniforms[`u${name}Map`].value = maps[i * 2];
          terrainUniforms[`u${name}Normal`].value = maps[i * 2 + 1];
        });
        terrainUniforms.uTexReady.value = 1;
      }
      skyTexture = await texture('sky_4k.jpg', true);
      if (skyTexture) skyTexture.mapping = THREE.EquirectangularReflectionMapping;
      const hdr = await new Promise((resolve) => new HDRLoader().load(BASE + 'sky_1k.hdr', resolve, undefined, () => resolve(null)));
      if (hdr) {
        findSun(hdr);
        hdr.mapping = THREE.EquirectangularReflectionMapping;
        const pmrem = new THREE.PMREMGenerator(renderer);
        envMap = pmrem.fromEquirectangular(hdr).texture;
        pmrem.dispose();
        hdr.dispose();
      }
      if (active) apply();
    })();
    return loading;
  }

  function buildComposer() {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    composer = new EffectComposer(renderer, target);
    const render = new RenderPass(scene, camera);
    const ao = new GTAOPass(scene, camera, size.x, size.y);
    ao.output = GTAOPass.OUTPUT.Default;
    ao.blendIntensity = .85;
    ao.updateGtaoMaterial({ radius: 2.5 * metersToWorld(), distanceExponent: 1.5, thickness: 1.2 * metersToWorld(), scale: 1.2, samples: 12 });
    const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), .22, .45, .92);
    const output = new OutputPass();
    const grade = new ShaderPass(GradeShader);
    composer.addPass(render);
    composer.addPass(ao);
    composer.addPass(bloom);
    composer.addPass(output);
    composer.addPass(grade);
    passes = { render, ao, bloom, output, grade };
  }

  // Day: the photographic sky and its light. Dusk and night keep the game's own sky (sky.js).
  function apply() {
    if (!active) return;
    if (day && skyTexture) {
      scene.background = skyTexture;
      scene.backgroundIntensity = 1.25;
    }
    scene.environment = day ? envMap : null;
    scene.environmentIntensity = .55;
  }

  return {
    get active() { return active; },
    get usesPost() { return active && full && day && Boolean(composer); },
    get realSky() { return active && day && Boolean(skyTexture); },
    get sunDirection() { return sunKnown ? sunDir : null; },
    preload: load,
    // quality 'full' adds post-processing; 'light' keeps the materials and the sky only.
    enter({ isDay = true, quality = 'full' } = {}) {
      active = true;
      day = isDay;
      full = quality === 'full';
      if (full && !composer) buildComposer();
      // Occlusion radius in real metres (the world is scaled to the map).
      if (passes) passes.ao.updateGtaoMaterial({ radius: 2.5 * metersToWorld(), thickness: 1.2 * metersToWorld() });
      load();
      apply();
    },
    exit() {
      active = false;
      scene.environment = null;
      scene.backgroundIntensity = 1;
    },
    setSize(width, height) {
      if (!composer) return;
      const ratio = renderer.getPixelRatio();
      composer.setPixelRatio(ratio);
      composer.setSize(width, height);
    },
    // Draw the frame through the post chain; returns false to let the caller draw it plainly.
    render() {
      if (!this.usesPost) return false;
      passes.ao.camera = camera;
      composer.render();
      return true;
    },
  };
}
