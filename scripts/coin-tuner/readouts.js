// The numbers readout and the paste-back panel that says what to change and where.

import { SHIPPED } from '/scripts/lib/studio-env.mjs';

import { SHIPPED_ANDROID_IBL, SHIPPED_EXPOSURE, SHIPPED_IOS_EXPONENT } from './constants.js';
import { number } from './format-number.js';
import { pivot } from './stage.js';
import { state } from './state.js';

const readouts = document.getElementById('readouts');
const snippet = document.getElementById('snippet');

// ── Readouts and the paste-back panel ────────────────────────────────────────

/// Less than half the gold left is the point where the coin reads as a pale disc
/// rather than as metal. It is a judgment call, and it is here so the number
/// has somewhere to be judged against.
const PALE_BELOW = 0.5;

export function renderReadouts(reading, worst) {
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

export function renderSnippet() {
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
    `# ── Material + studio: assets/coin/build-coin.py (material) and studio_env.py (studio) ──
FACE_ROUGHNESS = ${number(state.material.faceRoughness, 2)}
RIM_ROUGHNESS = ${number(state.material.rimRoughness, 2)}
FACE_SRGB = ${hexTriple(state.material.faceHex)}
RIM_SRGB = ${hexTriple(state.material.rimHex)}

${pythonLobes()}

# inside build_environment in studio_env.py:
${pythonRoom()}`,
  );

  parts.push(
    `# ── Landing it ──
# The studio is a REGISTERED duplicate (scripts/drift-registry.json,
# \`coin-studio-environment\`): the same numbers live in studio_env.py and in
# scripts/lib/studio-env.mjs, and \`just coin-check\` fails if they disagree.
# So, in one commit:
#   1. edit assets/coin/build-coin.py (material) and assets/coin/studio_env.py (ENV_LOBES, room)
#   2. mirror ENV_LOBES + the room into scripts/lib/studio-env.mjs SHIPPED
#   3. just coin        # Blender re-exports .glb/.usdz/.hdr, rebuilds Android's
#                       # cubemap, and re-runs the gate
# Exposure-only changes skip all of that — they are three constants.
# The tone map is not printed above: all three shells are on Khronos PBR
# Neutral deliberately (ACES smears the gold's hue toward gray), so switching it
# here is for comparison, not for pasting.`,
  );

  snippet.textContent = parts.join('\n\n');
}
