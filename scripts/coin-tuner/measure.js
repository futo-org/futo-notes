// How bright the coin actually is: read the drawing buffer back, report it a few times a
// second, and sweep a full turn for the palest angle.

import { COIN_ALPHA, WHITE_AT } from './constants.js';
import { renderReadouts } from './readouts.js';
import { draw, pivot, renderer } from './stage.js';
import { state } from './state.js';
import { syncControls } from './sync-controls.js';

// ── How bright is it, actually ───────────────────────────────────────────────

/// Fraction of the coin's own pixels that are pinned at the top of the 8-bit
/// range, plus the mean brightness over the coin. Reading the drawing buffer
/// back is what turns "seems really bright" into a number you can tune against.
export function measure() {
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
    // How much color is left in the pixel. Gold that has been overlit walks
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
export function reportOften(now) {
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
export function worstAngle() {
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
