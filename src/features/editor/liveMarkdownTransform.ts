import { ViewPlugin } from '@codemirror/view';
import { LiveMarkdownPlugin } from './live-preview/LiveMarkdownPlugin';

export {
  clearLocalImageUrlCache,
  imageCacheUpdated,
  preloadImages,
  registerLocalImageUrl,
  resolveImageSrc,
  setLocalImageBaseUrl,
} from './live-preview/images';
export {
  getCursorLinesForReveal,
  isBlockRevealSensitive,
  isInlineRevealSensitive,
  isMarkdownSelectionRevealSuppressed,
  selectionIntersectsRange,
  selectionTouchesRange,
  selectionWithinMarkerRange,
  shouldHideHeaderTagBlock,
  shouldRevealInlineMarkers,
  shouldRevealMarkdownSyntax,
  shouldSkipBlockDecorations,
  shouldSkipInlineDecorations,
  type SelectionRangeLike,
} from './live-preview/selectionReveal';

export { liveMarkdownRefresh } from './live-preview/refreshEffect';

/** Installs live markdown decorations for the current editor view. */
export const liveMarkdownTransform = ViewPlugin.fromClass(LiveMarkdownPlugin, {
  decorations: (plugin) => plugin.decorations,
});
