// Turning the coin: drag to spin, and the idle spin each animation frame.

import { SHIPPED_BASE_SPIN } from './constants.js';
import { reportOften } from './measure.js';
import { draw, mount, pivot } from './stage.js';
import { state } from './state.js';

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

export function animate(now = 0) {
  requestAnimationFrame(animate);
  const elapsed = lastFrame === 0 ? 0 : Math.min((now - lastFrame) / 1000, 1 / 20);
  lastFrame = now;
  if (state.spinning && !dragging) pivot.rotation.y += SHIPPED_BASE_SPIN * elapsed;
  draw();
  reportOften(now);
}
