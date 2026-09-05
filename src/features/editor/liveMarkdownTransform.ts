import { ViewPlugin } from '@codemirror/view';
import { LiveMarkdownPlugin } from './live-preview/LiveMarkdownPlugin';

export {
  clearLocalImageUrlCache,
  preloadImages,
  registerLocalImageUrl,
  resolveImageSrc,
  setLocalImageBaseUrl,
} from './live-preview/images';
export {
  clearMarkdownSelectionReveal,
  createSelectionRevealSnapshot,
  freezeMarkdownSelectionReveal,
  getCursorLinesForReveal,
  isBlockRevealSensitive,
  isInlineRevealSensitive,
  isMarkdownSelectionRevealSuppressed,
  markdownSelectionRevealState,
  selectionTouchesRange,
  selectionWithinMarkerRange,
  shouldHideHeaderTagBlock,
  shouldSkipBlockDecorations,
  shouldSkipInlineDecorations,
  suppressMarkdownSelectionReveal,
} from './live-preview/selectionReveal';

export { liveMarkdownRefresh } from './live-preview/refreshEffect';

/** Installs live markdown decorations for the current editor view. */
export const liveMarkdownTransform = ViewPlugin.fromClass(LiveMarkdownPlugin, {
  decorations: (plugin) => plugin.decorations,
});
