// The tuner's one piece of mutable state, and the studio description built from it.

import { SHIPPED } from '/scripts/lib/studio-env.mjs';

import { SHIPPED_COIN_PX, SHIPPED_EXPOSURE, SHIPPED_TILT_X } from './constants.js';

// ── State ────────────────────────────────────────────────────────────────────

/// Everything is stored as a DEPARTURE from the shipped values where that keeps
/// a reset exact: the room is three scale factors rather than nine rewritten
/// numbers, so `scale 1` reproduces build-coin.py's constants bit for bit
/// instead of to however many decimals a slider happens to land on.
export function freshState() {
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

export let state = freshState();

export function resetState() {
  state = freshState();
}

/// The studio as studio-env.mjs wants it, from the state above.
export function studioFrom(current) {
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
