/**
 * What the census counts.
 *
 * Two of these are precise measurements of the loss classes the compat plugins
 * exist to eliminate (`br_loss`, `empty_link_loss`) — those are the numbers the
 * acceptance criteria are stated against. The rest are the same broad
 * instability/structure signals the first census used: useful for spotting a
 * regression against a baseline run, not exact in themselves.
 */

export * from './detectors/text-detectors.mjs';
export * from './detectors/house-document.mjs';
export * from './detectors/classify.mjs';
