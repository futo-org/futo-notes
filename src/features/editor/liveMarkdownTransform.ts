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
  clearSelectionRevealFreeze,
  freezeSelectionReveal,
  getCursorLinesForReveal,
  isBlockRevealSensitive,
  isInlineRevealSensitive,
  isMarkdownSelectionRevealSuppressed,
  selectionIntersectsRange,
  selectionTouchesRange,
  selectionWithinMarkerRange,
  setSuppressSelectionReveal,
  shouldHideHeaderTagBlock,
  shouldRevealInlineMarkers,
  shouldRevealMarkdownSyntax,
  shouldSkipBlockDecorations,
  shouldSkipInlineDecorations,
  type SelectionRangeLike,
} from './live-preview/selectionReveal';

export { liveMarkdownRefresh } from './live-preview/refreshEffect';

export const liveMarkdownTransform = ViewPlugin.fromClass(LiveMarkdownPlugin, {
  decorations: (v) => v.decorations,
});
