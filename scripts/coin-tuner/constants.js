// The numbers the tuner copies from the shells and its own judgement calls: framing, the
// shipped brightness of iOS and Android, and the menus the controls offer.

import * as THREE from 'three';

// ── What the desktop shell does, copied so the tuner frames the coin the same ──
// src/features/license/supporterCoin.ts. If these drift the tuner lies about
// framing, which is why they are named rather than inlined.
export const BASE_FOV = 30;
export const CAMERA_DISTANCE = 1.55;
export const SHIPPED_TILT_X = 0.24;
export const SHIPPED_EXPOSURE = 1.0;
export const SHIPPED_BASE_SPIN = 1.25;
/// The coin's box in the licensed plate (LicenseSettingsSection.svelte).
export const SHIPPED_COIN_PX = 160;

/// The other two shells' shipped brightness, and how each converts from the
/// desktop exposure. Both comments live next to the constants themselves:
/// Filament measures indirect light in lux on a normalised cubemap, RealityKit
/// takes a power of two, and three.js multiplies the environment's own values.
export const SHIPPED_ANDROID_IBL = 4.5;
export const SHIPPED_IOS_EXPONENT = -1.5;

export const TONE_MAPS = [
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
export const BACKDROPS = [
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
export const WHITE_AT = 250;
/// Alpha above this is coin rather than backdrop. The renderer clears to
/// transparent, so coverage is free.
export const COIN_ALPHA = 8;
