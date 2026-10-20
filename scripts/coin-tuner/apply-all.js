// Push the whole state out: room, materials, renderer, control readouts, paste-back panel.

import { renderSnippet } from './readouts.js';
import { applyEnvironment, applyMaterials, applyRenderer, draw } from './stage.js';
import { syncControls } from './sync-controls.js';

export function applyAll() {
  applyEnvironment();
  applyMaterials();
  applyRenderer();
  syncControls();
  renderSnippet();
  draw();
}
