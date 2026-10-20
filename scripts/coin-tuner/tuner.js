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

import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { applyAll } from './apply-all.js';
import { buildControls } from './controls.js';
import { renderSnippet } from './readouts.js';
import { applyRenderer, faceMaterials, failure, rimMaterials, pivot } from './stage.js';
import { syncControls } from './sync-controls.js';
import { animate } from './turntable.js';

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

buildControls();
applyRenderer();
syncControls();
renderSnippet();
