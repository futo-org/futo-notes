// The coin tuner: every dial that decides how bright the FUTO coin is, on a
// slider, against the real model.
//
// What is real here and what is a stand-in:
//   REAL   assets/coin/futo-coin.glb — the shipped mesh, materials and all
//   REAL   the studio, rebuilt from scripts/lib/studio-env.mjs, which
//          `just coin-check` holds to build-coin.py's numpy to within a
//          quantisation step
//   REAL   the camera framing, tilt and tone map curve the desktop shell uses
//   STAND-IN  iOS and Android, which are shown as converted numbers rather than
//          rendered — RealityKit and Filament each scale an image-based light
//          differently, and the conversions below are the ones their own
//          constants' comments record
//
// Nothing here writes to the repo. The panel at the bottom prints what to paste
// and which files to paste it into.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { SHIPPED, buildStudioEnvironment } from '/scripts/lib/studio-env.mjs';

// ── What the desktop shell does, copied so the tuner frames the coin the same ──
// src/features/license/supporterCoin.ts. If these drift the tuner lies about
// framing, which is why they are named rather than inlined.
const BASE_FOV = 30;
const CAMERA_DISTANCE = 1.55;
const SHIPPED_TILT_X = 0.24;
const SHIPPED_EXPOSURE = 1.0;
const SHIPPED_BASE_SPIN = 1.25;
/// The coin's box in the licensed plate (LicenseSettingsSection.svelte).
const SHIPPED_COIN_PX = 160;

/// The other two shells' shipped brightness, and how each converts from the
/// desktop exposure. Both comments live next to the constants themselves:
/// Filament measures indirect light in lux on a normalised cubemap, RealityKit
/// takes a power of two, and three.js multiplies the environment's own values.
const SHIPPED_ANDROID_IBL = 4.5;
const SHIPPED_IOS_EXPONENT = -1.5;

const TONE_MAPS = [
  ['neutral', 'Khronos PBR Neutral (shipped)', THREE.NeutralToneMapping],
  ['aces', 'ACES Filmic', THREE.ACESFilmicToneMapping],
  ['agx', 'AgX', THREE.AgXToneMapping],
  ['reinhard', 'Reinhard', THREE.ReinhardToneMapping],
  ['cineon', 'Cineon', THREE.CineonToneMapping],
  ['linear', 'Linear', THREE.LinearToneMapping],
  ['none', 'None (raw, will clip)', THREE.NoToneMapping],
];

/// The app's real surfaces (src/styles/theme.css), so "is it too bright" is
/// asked against the card the coin actually sits on.
const BACKDROPS = [
  ['#171717', 'Dark card'],
  ['#0a0a0a', 'Dark app'],
  ['#f2f2f2', 'Light card'],
  ['#fcfcfc', 'Light app'],
  ['#808080', 'Mid grey'],
];

/// A pixel is blown out when EVERY channel is at the top of the 8-bit range —
/// it has gone white and taken the gold's hue with it.
///
/// Not "any channel", which is the obvious metric and the wrong one: gold is
/// #FFBB00, so its red channel is pinned at 255 across the whole face at
/// perfectly ordinary brightness. Measured that way a plainly gold coin reports
/// 93% blown out, which is a reading that cannot distinguish the thing being
/// tuned from its own base colour.
const WHITE_AT = 250;
/// Alpha above this is coin rather than backdrop. The renderer clears to
/// transparent, so coverage is free.
const COIN_ALPHA = 8;

// ── State ────────────────────────────────────────────────────────────────────

/// Everything is stored as a DEPARTURE from the shipped values where that keeps
/// a reset exact: the room is three scale factors rather than nine rewritten
/// numbers, so `scale 1` reproduces build-coin.py's constants bit for bit
/// instead of to however many decimals a slider happens to land on.
function freshState() {
  return {
    room: {
      ambientScale: 1,
      skyScale: 1,
      floorScale: 1,
      skyExponent: SHIPPED.room.skyExponent,
      floorExponent: SHIPPED.room.floorExponent,
    },
    lobes: structuredClone(SHIPPED.lobes),
    material: {
      faceRoughness: 0.22,
      rimRoughness: 0.3,
      faceHex: 0xffbb00,
      rimHex: 0xb8860b,
    },
    exposure: SHIPPED_EXPOSURE,
    toneMap: 'neutral',
    tilt: SHIPPED_TILT_X,
    backdrop: '#171717',
    sizePx: SHIPPED_COIN_PX,
    spinning: true,
    /// Held while the "compare with shipped" control is down.
    showShipped: false,
  };
}

let state = freshState();

/// The studio as studio-env.mjs wants it, from the state above.
function studioFrom(current) {
  if (current.showShipped) return SHIPPED;
  const scale = (triple, by) => triple.map((channel) => channel * by);
  return {
    width: SHIPPED.width,
    height: SHIPPED.height,
    room: {
      ambient: scale(SHIPPED.room.ambient, current.room.ambientScale),
      sky: scale(SHIPPED.room.sky, current.room.skyScale),
      floor: scale(SHIPPED.room.floor, current.room.floorScale),
      skyExponent: current.room.skyExponent,
      floorExponent: current.room.floorExponent,
      minimum: SHIPPED.room.minimum,
    },
    lobes: current.showShipped ? SHIPPED.lobes : current.lobes,
  };
}

// ── The stage ────────────────────────────────────────────────────────────────

const mount = document.getElementById('mount');
const backdrop = document.getElementById('backdrop');
const failure = document.getElementById('failure');

const renderer = new THREE.WebGLRenderer({
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

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.1, 10);
camera.position.set(0, 0, CAMERA_DISTANCE);
camera.lookAt(0, 0, 0);

const pivot = new THREE.Group();
scene.add(pivot);

const pmrem = new THREE.PMREMGenerator(renderer);
let environmentTarget = null;
let faceMaterials = [];
let rimMaterials = [];

/// Rebuild the room and hand it to the scene. Cheap enough to do on every
/// slider frame: 256x128 pixels of arithmetic, then one prefilter.
function applyEnvironment() {
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

function applyMaterials() {
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

function applyRenderer() {
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

function draw() {
  renderer.render(scene, camera);
}

// ── Load the coin ────────────────────────────────────────────────────────────

new GLTFLoader().loadAsync('/assets/coin/futo-coin.glb').then(
  (gltf) => {
    pivot.add(gltf.scene);
    gltf.scene.traverse((node) => {
      const mesh = node;
      if (mesh.material === undefined) return;
      for (const entry of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        // Blender's material names survive the export; the face is the flat, the
        // rim is everything the bevel rolls onto.
        if (entry.name === 'CoinFace') faceMaterials.push(entry);
        else if (entry.name === 'CoinRim') rimMaterials.push(entry);
      }
    });
    if (faceMaterials.length === 0 || rimMaterials.length === 0) {
      showFailure(
        'futo-coin.glb no longer carries materials named CoinFace and CoinRim, so the ' +
          'material sliders are not wired to anything. Check assign_materials in build-coin.py.',
      );
    }
    applyAll();
    animate();
  },
  (error) => showFailure(`Could not load /assets/coin/futo-coin.glb: ${error.message}`),
);

function showFailure(message) {
  failure.textContent = message;
  failure.style.display = 'block';
}

// ── Turning it ───────────────────────────────────────────────────────────────

let dragging = false;
let lastX = 0;
let lastFrame = 0;

mount.addEventListener('pointerdown', (event) => {
  dragging = true;
  lastX = event.clientX;
  mount.dataset.turning = 'true';
  mount.setPointerCapture(event.pointerId);
});
mount.addEventListener('pointermove', (event) => {
  if (!dragging) return;
  // The desktop shell's 0.018 radians per pixel, so a drag here feels like a
  // drag there.
  pivot.rotation.y += (event.clientX - lastX) * 0.018;
  lastX = event.clientX;
});
for (const kind of ['pointerup', 'pointercancel']) {
  mount.addEventListener(kind, () => {
    dragging = false;
    mount.dataset.turning = 'false';
  });
}

function animate(now = 0) {
  requestAnimationFrame(animate);
  const elapsed = lastFrame === 0 ? 0 : Math.min((now - lastFrame) / 1000, 1 / 20);
  lastFrame = now;
  if (state.spinning && !dragging) pivot.rotation.y += SHIPPED_BASE_SPIN * elapsed;
  draw();
  reportOften(now);
}

// ── How bright is it, actually ───────────────────────────────────────────────

/// Fraction of the coin's own pixels that are pinned at the top of the 8-bit
/// range, plus the mean brightness over the coin. Reading the drawing buffer
/// back is what turns "seems really bright" into a number you can tune against.
function measure() {
  const gl = renderer.getContext();
  const width = renderer.domElement.width;
  const height = renderer.domElement.height;
  const pixels = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

  let coin = 0;
  let white = 0;
  let brightness = 0;
  let saturation = 0;
  for (let at = 0; at < pixels.length; at += 4) {
    if (pixels[at + 3] <= COIN_ALPHA) continue;
    coin += 1;
    const peak = Math.max(pixels[at], pixels[at + 1], pixels[at + 2]);
    const dimmest = Math.min(pixels[at], pixels[at + 1], pixels[at + 2]);
    brightness += peak;
    // How much colour is left in the pixel. Gold that has been overlit walks
    // this toward zero long before the whole coin is white, so it moves while
    // there is still something to save.
    saturation += peak === 0 ? 0 : (peak - dimmest) / peak;
    if (dimmest >= WHITE_AT) white += 1;
  }
  return {
    coverage: coin,
    white: coin === 0 ? 0 : (white / coin) * 100,
    mean: coin === 0 ? 0 : brightness / coin / 255,
    saturation: coin === 0 ? 0 : saturation / coin,
  };
}

let lastReport = 0;
function reportOften(now) {
  // A full read of the drawing buffer every frame would cost more than the
  // coin does; four times a second is plenty to watch a number move.
  if (now - lastReport < 250) return;
  lastReport = now;
  renderReadouts(measure());
}

/// Turn the coin all the way round and report the angle where the least gold is
/// left. This is the honest answer to "it is bright at SOME angles": the worst
/// one is a number, not an impression.
///
/// Ranked on saturation rather than on brightness or on white pixels, because
/// that is the reading that actually moves. Under Khronos PBR Neutral this coin
/// never drives all three channels to 255 — "gone white" sits at 0.0% even at
/// double exposure — while the gold walks from 98% saturation with the lamps off
/// down to 54% as shipped. Washing out IS the failure mode here; clipping is
/// only its endpoint.
function worstAngle() {
  const wasSpinning = state.spinning;
  const held = pivot.rotation.y;
  state.spinning = false;

  let worst = { angle: 0, saturation: Number.POSITIVE_INFINITY, mean: -1, white: 0 };
  const STEPS = 180;
  for (let step = 0; step < STEPS; step += 1) {
    pivot.rotation.y = (step / STEPS) * Math.PI * 2;
    draw();
    const reading = measure();
    // Palest first; brightest breaks a tie, so two equally pale angles report
    // the one that is harder to look at.
    const worse =
      reading.saturation < worst.saturation ||
      (reading.saturation === worst.saturation && reading.mean > worst.mean);
    if (worse) worst = { angle: (step / STEPS) * 360, ...reading };
  }

  pivot.rotation.y = (worst.angle / 360) * Math.PI * 2;
  draw();
  renderReadouts(measure(), worst);
  if (wasSpinning) {
    // Leave it parked: the point of finding the angle is to look at it.
    syncControls();
  }
}

// ── Controls ─────────────────────────────────────────────────────────────────

const panels = document.getElementById('panels');
const readouts = document.getElementById('readouts');
const snippet = document.getElementById('snippet');

function number(value, decimals = 3) {
  const fixed = Number(value.toFixed(decimals));
  return Number.isInteger(fixed) ? `${fixed}.0` : String(fixed);
}

function control(parent, spec) {
  const wrap = document.createElement('div');
  wrap.className = spec.kind === 'range' ? 'control' : 'control inline';

  const label = document.createElement('label');
  label.textContent = spec.label;
  wrap.appendChild(label);

  const readout = document.createElement('span');
  readout.className = 'value';
  wrap.appendChild(readout);

  let input;
  if (spec.kind === 'range') {
    input = document.createElement('input');
    input.type = 'range';
    input.min = spec.min;
    input.max = spec.max;
    input.step = spec.step;
  } else if (spec.kind === 'colour') {
    input = document.createElement('input');
    input.type = 'color';
  } else if (spec.kind === 'select') {
    input = document.createElement('select');
    for (const [value, text] of spec.options) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      input.appendChild(option);
    }
  } else if (spec.kind === 'toggle') {
    input = document.createElement('input');
    input.type = 'checkbox';
  }

  const push = () => {
    spec.set(spec.kind === 'toggle' ? input.checked : input.value);
    applyAll();
  };
  input.addEventListener(spec.kind === 'range' ? 'input' : 'change', push);
  if (spec.kind === 'range') input.addEventListener('change', push);
  wrap.appendChild(input);
  parent.appendChild(wrap);

  return () => {
    const value = spec.get();
    if (spec.kind === 'toggle') input.checked = value;
    else input.value = value;
    readout.textContent = spec.format === undefined ? '' : spec.format(value);
  };
}

function group(title, open, build) {
  const details = document.createElement('details');
  details.className = 'group';
  details.open = open;
  const summary = document.createElement('summary');
  summary.textContent = title;
  details.appendChild(summary);
  const body = document.createElement('div');
  body.className = 'group-body';
  details.appendChild(body);
  panels.appendChild(details);
  return build(body);
}

function noteInto(parent, text, className = 'note') {
  const paragraph = document.createElement('p');
  paragraph.className = className;
  paragraph.textContent = text;
  parent.appendChild(paragraph);
}

const syncers = [];

function buildControls() {
  syncers.push(
    ...group('Looking at it', true, (body) => {
      noteInto(
        body,
        'The coin is 160px on a 184px well in the licensed plate, on --color-surface. ' +
          'Brightness is judged against that card, not against a void. "Gold left" is ' +
          'the reading to watch: as shipped the coin sits near 54%, and the same coin ' +
          'with its five lamps off measures 98%. That gap is what "too bright" is.',
      );
      const made = [];
      made.push(
        control(body, {
          kind: 'select',
          label: 'Backdrop',
          options: BACKDROPS.map(([hex, name]) => [hex, `${name}  ${hex}`]),
          get: () => state.backdrop,
          set: (value) => (state.backdrop = value),
        }),
      );
      made.push(
        control(body, {
          kind: 'range',
          label: 'Coin size',
          min: 96,
          max: 400,
          step: 8,
          get: () => state.sizePx,
          set: (value) => (state.sizePx = Number(value)),
          format: (value) => `${value}px`,
        }),
      );
      made.push(
        control(body, {
          kind: 'toggle',
          label: 'Spin',
          get: () => state.spinning,
          set: (value) => (state.spinning = value),
        }),
      );
      made.push(
        control(body, {
          kind: 'range',
          label: 'Tilt',
          min: 0,
          max: 0.8,
          step: 0.01,
          get: () => state.tilt,
          set: (value) => (state.tilt = Number(value)),
          format: (value) => `${number(value, 2)} rad`,
        }),
      );
      made.push(
        control(body, {
          kind: 'toggle',
          label: 'Compare: show shipped values',
          get: () => state.showShipped,
          set: (value) => (state.showShipped = value),
        }),
      );

      const row = document.createElement('div');
      row.className = 'row';
      const sweep = document.createElement('button');
      sweep.textContent = 'Find the palest angle';
      sweep.addEventListener('click', worstAngle);
      row.appendChild(sweep);
      const reset = document.createElement('button');
      reset.textContent = 'Reset to shipped';
      reset.addEventListener('click', () => {
        state = freshState();
        applyAll();
      });
      row.appendChild(reset);
      body.appendChild(row);
      return made;
    }),
  );

  syncers.push(
    ...group('Per-shell exposure — no regeneration', true, (body) => {
      noteInto(
        body,
        'One number per shell, and they are a matched triple: turning one without the ' +
          'other two makes the same coin a different object on each platform. This dims ' +
          'everything at once, highlight and gold body together.',
      );
      const made = [
        control(body, {
          kind: 'range',
          label: 'Desktop exposure',
          min: 0.2,
          // Up to 6 because this slider is also how the OTHER shells get
          // calibrated: Android's Filament intensity and iOS's RealityKit
          // exponent are converted by finding the desktop exposure that renders
          // the same coin, and Android's shipped 4.5 lands well above 2.
          max: 6,
          step: 0.01,
          get: () => state.exposure,
          set: (value) => (state.exposure = Number(value)),
          format: (value) => number(value, 2),
        }),
        control(body, {
          kind: 'select',
          label: 'Tone map',
          options: TONE_MAPS.map(([key, name]) => [key, name]),
          get: () => state.toneMap,
          set: (value) => (state.toneMap = value),
        }),
      ];
      return made;
    }),
  );

  syncers.push(
    ...group('Material — needs `just coin`', true, (body) => {
      noteInto(
        body,
        'Roughness is the dial for a highlight that is too hot without making the coin ' +
          'darker: a rougher metal spreads the same light over more of the face, so the ' +
          'peak drops while the body does not. Base colour multiplies the reflection ' +
          'itself, because gold is a metal — it dims the highlight too.',
      );
      return [
        control(body, {
          kind: 'range',
          label: 'Face roughness',
          min: 0.02,
          max: 0.8,
          step: 0.01,
          get: () => state.material.faceRoughness,
          set: (value) => (state.material.faceRoughness = Number(value)),
          format: (value) => number(value, 2),
        }),
        control(body, {
          kind: 'range',
          label: 'Rim roughness',
          min: 0.02,
          max: 0.8,
          step: 0.01,
          get: () => state.material.rimRoughness,
          set: (value) => (state.material.rimRoughness = Number(value)),
          format: (value) => number(value, 2),
        }),
        control(body, {
          kind: 'colour',
          label: 'Face colour',
          get: () => `#${state.material.faceHex.toString(16).padStart(6, '0')}`,
          set: (value) => (state.material.faceHex = Number.parseInt(value.slice(1), 16)),
        }),
        control(body, {
          kind: 'colour',
          label: 'Rim colour',
          get: () => `#${state.material.rimHex.toString(16).padStart(6, '0')}`,
          set: (value) => (state.material.rimHex = Number.parseInt(value.slice(1), 16)),
        }),
      ];
    }),
  );

  syncers.push(
    ...group('The room — needs `just coin`', false, (body) => {
      noteInto(
        body,
        'The coin against everything that is not a lamp. Lowering the ceiling darkens ' +
          'the coin at every angle while the highlights keep their punch — the opposite ' +
          'trade from the exposure slider.',
      );
      return [
        control(body, {
          kind: 'range',
          label: 'Ceiling (sky)',
          min: 0,
          max: 3,
          step: 0.01,
          get: () => state.room.skyScale,
          set: (value) => (state.room.skyScale = Number(value)),
          format: (value) => `x${number(value, 2)}`,
        }),
        control(body, {
          kind: 'range',
          label: 'Ambient floor',
          min: 0,
          max: 4,
          step: 0.01,
          get: () => state.room.ambientScale,
          set: (value) => (state.room.ambientScale = Number(value)),
          format: (value) => `x${number(value, 2)}`,
        }),
        control(body, {
          kind: 'range',
          label: 'Floor take-out',
          min: 0,
          max: 4,
          step: 0.01,
          get: () => state.room.floorScale,
          set: (value) => (state.room.floorScale = Number(value)),
          format: (value) => `x${number(value, 2)}`,
        }),
        control(body, {
          kind: 'range',
          label: 'Sky exponent',
          min: 0.4,
          max: 4,
          step: 0.05,
          get: () => state.room.skyExponent,
          set: (value) => (state.room.skyExponent = Number(value)),
          format: (value) => number(value, 2),
        }),
        control(body, {
          kind: 'range',
          label: 'Floor exponent',
          min: 0.4,
          max: 4,
          step: 0.05,
          get: () => state.room.floorExponent,
          set: (value) => (state.room.floorExponent = Number(value)),
          format: (value) => number(value, 2),
        }),
      ];
    }),
  );

  state.lobes.forEach((lobe, index) => {
    syncers.push(
      ...group(`Lamp ${index + 1}: ${lobe.name} — needs \`just coin\``, false, (body) => {
        noteInto(body, lobe.note, 'lamp-note');
        const made = [
          control(body, {
            kind: 'range',
            label: 'Intensity',
            min: 0,
            max: 80,
            step: 0.1,
            get: () => state.lobes[index].intensity,
            set: (value) => (state.lobes[index].intensity = Number(value)),
            format: (value) => number(value, 1),
          }),
          control(body, {
            kind: 'range',
            label: 'Tightness (cone)',
            min: 1,
            max: 120,
            step: 0.5,
            get: () => state.lobes[index].tightness,
            set: (value) => (state.lobes[index].tightness = Number(value)),
            format: (value) => number(value, 1),
          }),
        ];

        const triple = document.createElement('div');
        triple.className = 'triple';
        ['x', 'y', 'z'].forEach((axis, axisIndex) => {
          const cell = document.createElement('div');
          const caption = document.createElement('span');
          caption.textContent = `dir ${axis}`;
          const field = document.createElement('input');
          field.type = 'number';
          field.step = '0.01';
          field.value = String(state.lobes[index].direction[axisIndex]);
          field.addEventListener('change', () => {
            const parsed = Number(field.value);
            if (Number.isFinite(parsed)) {
              state.lobes[index].direction[axisIndex] = parsed;
              applyAll();
            }
          });
          cell.appendChild(caption);
          cell.appendChild(field);
          triple.appendChild(cell);
        });
        body.appendChild(triple);

        // The lamp colours are LINEAR radiance multipliers, not sRGB, so the
        // swatch is a convenience that writes linear values back. Untouched, the
        // state keeps build-coin.py's exact numbers rather than a round trip
        // through eight bits.
        made.push(
          control(body, {
            kind: 'colour',
            label: 'Tint',
            get: () => linearToHex(state.lobes[index].colour),
            set: (value) => (state.lobes[index].colour = hexToLinear(value)),
          }),
        );
        return made;
      }),
    );
  });
}

function linearToHex(colour) {
  const channel = (value) => {
    const srgb =
      value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(Math.max(value, 0), 1 / 2.4) - 0.055;
    return Math.round(Math.min(Math.max(srgb, 0), 1) * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${colour.map(channel).join('')}`;
}

function hexToLinear(hex) {
  const bytes = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255);
  return bytes.map((value) =>
    value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4),
  );
}

function syncControls() {
  for (const sync of syncers) sync();
}

// ── Readouts and the paste-back panel ────────────────────────────────────────

/// Less than half the gold left is the point where the coin reads as a pale disc
/// rather than as metal. It is a judgement call, and it is here so the number
/// has somewhere to be judged against.
const PALE_BELOW = 0.5;

function renderReadouts(reading, worst) {
  readouts.innerHTML = '';
  const add = (value, caption, warn = false) => {
    const box = document.createElement('div');
    box.className = warn ? 'readout hot' : 'readout';
    const strong = document.createElement('b');
    strong.textContent = value;
    const span = document.createElement('span');
    span.textContent = caption;
    box.appendChild(strong);
    box.appendChild(span);
    readouts.appendChild(box);
  };
  add(`${(reading.saturation * 100).toFixed(0)}%`, 'gold left', reading.saturation < PALE_BELOW);
  add(`${(reading.mean * 100).toFixed(0)}%`, 'mean brightness');
  add(`${reading.white.toFixed(1)}%`, 'fully white');
  add(String(Math.round((pivot.rotation.y * 180) / Math.PI) % 360), 'angle (deg)');
  if (worst !== undefined) {
    add(
      `${worst.angle.toFixed(0)}deg`,
      `palest angle: ${(worst.saturation * 100).toFixed(0)}% gold`,
      true,
    );
  }
}

function pythonLobes() {
  const lines = state.lobes.map((lobe) => {
    const direction = lobe.direction.map((value) => number(value, 2)).join(', ');
    const colour = lobe.colour.map((value) => number(value, 3)).join(', ');
    return `    ((${direction}), ${number(lobe.tightness, 1)}, ${number(lobe.intensity, 1)}, (${colour})),  # ${lobe.name}`;
  });
  return `ENV_LOBES = (\n${lines.join('\n')}\n)`;
}

function pythonRoom() {
  const scaled = (triple, by) => triple.map((channel) => number(channel * by, 4));
  const ambient = scaled(SHIPPED.room.ambient, state.room.ambientScale);
  const sky = scaled(SHIPPED.room.sky, state.room.skyScale);
  const floor = scaled(SHIPPED.room.floor, state.room.floorScale);
  return [
    `    sky = numpy.clip(up, 0.0, 1.0) ** ${number(state.room.skyExponent, 2)}`,
    `    floor = numpy.clip(-up, 0.0, 1.0) ** ${number(state.room.floorExponent, 2)}`,
    `    base_r = ${ambient[0]} + ${sky[0]} * sky - ${floor[0]} * floor`,
    `    base_g = ${ambient[1]} + ${sky[1]} * sky - ${floor[1]} * floor`,
    `    base_b = ${ambient[2]} + ${sky[2]} * sky - ${floor[2]} * floor`,
  ].join('\n');
}

function hexTriple(hex) {
  const byte = (shift) =>
    `0x${((hex >> shift) & 0xff).toString(16).toUpperCase().padStart(2, '0')}`;
  return `(${byte(16)}, ${byte(8)}, ${byte(0)})`;
}

function renderSnippet() {
  const ratio = state.exposure / SHIPPED_EXPOSURE;
  const iosExponent = SHIPPED_IOS_EXPONENT + Math.log2(ratio);
  const androidIbl = SHIPPED_ANDROID_IBL * ratio;
  const exposureMoved = Math.abs(state.exposure - SHIPPED_EXPOSURE) > 1e-6;

  const parts = [];

  parts.push(
    `# ── Exposure: three files, one change. No regeneration. ──${exposureMoved ? '' : '  (unchanged)'}
src/features/license/supporterCoin.ts
    const TONE_MAPPING_EXPOSURE = ${number(state.exposure, 3)};
apps/ios/Sources/License/SupporterCoin.swift
    private let coinLightExponent: Float = ${number(iosExponent, 3)}
apps/android/app/src/main/java/com/futo/notes/ui/SupporterCoin.kt
    private const val IBL_INTENSITY = ${number(androidIbl, 2)}f`,
  );

  parts.push(
    `# ── Material + studio: assets/coin/build-coin.py ──
FACE_ROUGHNESS = ${number(state.material.faceRoughness, 2)}
RIM_ROUGHNESS = ${number(state.material.rimRoughness, 2)}
FACE_SRGB = ${hexTriple(state.material.faceHex)}
RIM_SRGB = ${hexTriple(state.material.rimHex)}

${pythonLobes()}

# inside build_environment:
${pythonRoom()}`,
  );

  parts.push(
    `# ── Landing it ──
# The studio is a REGISTERED duplicate (scripts/drift-registry.json,
# \`coin-studio-environment\`): the same numbers live in build-coin.py and in
# scripts/lib/studio-env.mjs, and \`just coin-check\` fails if they disagree.
# So, in one commit:
#   1. edit assets/coin/build-coin.py
#   2. mirror ENV_LOBES + the room into scripts/lib/studio-env.mjs SHIPPED
#   3. just coin        # Blender re-exports .glb/.usdz/.hdr, rebuilds Android's
#                       # cubemap, and re-runs the gate
# Exposure-only changes skip all of that — they are three constants.
# The tone map is not printed above: all three shells are on Khronos PBR
# Neutral deliberately (ACES smears the gold's hue toward grey), so switching it
# here is for comparison, not for pasting.`,
  );

  snippet.textContent = parts.join('\n\n');
}

// ── Tie it together ──────────────────────────────────────────────────────────

function applyAll() {
  applyEnvironment();
  applyMaterials();
  applyRenderer();
  syncControls();
  renderSnippet();
  draw();
}

buildControls();
applyRenderer();
syncControls();
renderSnippet();
