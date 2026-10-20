// The three.js stage: renderer, scene, camera, and the functions that push the tuner's state
// into the room, the materials and the renderer.

import * as THREE from 'three';

import { buildStudioEnvironment } from '/scripts/lib/studio-env.mjs';

import { BASE_FOV, CAMERA_DISTANCE, SHIPPED_EXPOSURE, TONE_MAPS } from './constants.js';
import { state, studioFrom } from './state.js';

// ── The stage ────────────────────────────────────────────────────────────────

export const mount = document.getElementById('mount');
export const backdrop = document.getElementById('backdrop');
export const failure = document.getElementById('failure');

export const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: true,
  // The clipping readout reads the drawing buffer back; without this the read
  // is allowed to come back empty.
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor(0x000000, 0);
mount.appendChild(renderer.domElement);
renderer.domElement.style.width = '100%';
renderer.domElement.style.height = '100%';
renderer.domElement.style.display = 'block';

export const scene = new THREE.Scene();
export const camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.1, 10);
camera.position.set(0, 0, CAMERA_DISTANCE);
camera.lookAt(0, 0, 0);

export const pivot = new THREE.Group();
scene.add(pivot);

const pmrem = new THREE.PMREMGenerator(renderer);
let environmentTarget = null;
export let faceMaterials = [];
export let rimMaterials = [];

/// Rebuild the room and hand it to the scene. Cheap enough to do on every
/// slider frame: 256x128 pixels of arithmetic, then one prefilter.
export function applyEnvironment() {
  const { width, height, data } = buildStudioEnvironment(studioFrom(state));

  // Half-float, not float: WebGL2 filters half-float textures natively, and
  // PMREM's prefilter samples with linear filtering. Full float would need an
  // extension that is not guaranteed.
  const texels = new Uint16Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    texels[pixel * 4] = THREE.DataUtils.toHalfFloat(data[pixel * 3]);
    texels[pixel * 4 + 1] = THREE.DataUtils.toHalfFloat(data[pixel * 3 + 1]);
    texels[pixel * 4 + 2] = THREE.DataUtils.toHalfFloat(data[pixel * 3 + 2]);
    texels[pixel * 4 + 3] = THREE.DataUtils.toHalfFloat(1);
  }

  // Everything HDRLoader sets on the texture it hands back, because matching the
  // app means matching its texture and not just its numbers. A raw DataTexture
  // defaults to NearestFilter and flipY false; the loader uses LinearFilter and
  // flipY TRUE, which is what puts the studio's first scanline — straight up in
  // the .hdr — at the top in texture space. Getting this wrong renders the room
  // upside down, which is lit plausibly enough to look like a tuning choice
  // rather than a bug: measured against the app's own path it was off by up to
  // 79/255 per channel.
  const equirect = new THREE.DataTexture(
    texels,
    width,
    height,
    THREE.RGBAFormat,
    THREE.HalfFloatType,
    THREE.EquirectangularReflectionMapping,
    THREE.ClampToEdgeWrapping,
    THREE.ClampToEdgeWrapping,
    THREE.LinearFilter,
    THREE.LinearFilter,
    1,
    THREE.LinearSRGBColorSpace,
  );
  equirect.flipY = true;
  equirect.generateMipmaps = false;
  equirect.needsUpdate = true;

  const next = pmrem.fromEquirectangular(equirect);
  equirect.dispose();
  environmentTarget?.dispose();
  environmentTarget = next;
  scene.environment = next.texture;
}

export function applyMaterials() {
  const { material } = state;
  const face = state.showShipped
    ? { roughness: 0.22, hex: 0xffbb00 }
    : { roughness: material.faceRoughness, hex: material.faceHex };
  const rim = state.showShipped
    ? { roughness: 0.3, hex: 0xb8860b }
    : { roughness: material.rimRoughness, hex: material.rimHex };
  for (const entry of faceMaterials) {
    entry.roughness = face.roughness;
    entry.color.setHex(face.hex, THREE.SRGBColorSpace);
  }
  for (const entry of rimMaterials) {
    entry.roughness = rim.roughness;
    entry.color.setHex(rim.hex, THREE.SRGBColorSpace);
  }
}

export function applyRenderer() {
  const [, , mapping] = TONE_MAPS.find(([key]) => key === state.toneMap);
  renderer.toneMapping = mapping;
  renderer.toneMappingExposure = state.showShipped ? SHIPPED_EXPOSURE : state.exposure;
  pivot.rotation.x = state.tilt;
  backdrop.style.background = state.backdrop;
  mount.style.width = `${state.sizePx}px`;
  mount.style.height = `${state.sizePx}px`;
  const size = Math.round(state.sizePx);
  renderer.setSize(size, size, false);
}

export function draw() {
  renderer.render(scene, camera);
}
