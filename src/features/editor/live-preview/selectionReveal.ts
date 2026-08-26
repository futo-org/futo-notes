import {
  EditorSelection,
  StateEffect,
  StateField,
  type EditorState,
  type SelectionRange,
} from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

export interface SelectionRangeLike {
  from: number;
  to: number;
}

interface LineNumberLookup {
  lineAt(position: number): { number: number };
}

interface FrozenSelectionReveal {
  hasFocus: boolean;
  ranges: readonly SelectionRange[];
}

/**
 * Independent owners of a reveal freeze. A pointer gesture and find can each
 * hold one at the same time, so they get their own layer instead of sharing a
 * slot: with one slot, a click's settle cleared the freeze that was holding the
 * current find match's markdown syntax revealed. The higher priority wins.
 */
export type SelectionRevealOwner = 'pointer' | 'find';

const OWNER_PRIORITY: Record<SelectionRevealOwner, number> = { pointer: 0, find: 1 };

interface SelectionRevealLayer {
  frozen: FrozenSelectionReveal | null;
  suppressed: boolean;
}

type SelectionRevealLayers = Partial<Record<SelectionRevealOwner, SelectionRevealLayer>>;

interface SelectionRevealValue {
  layers: SelectionRevealLayers;
  /** The highest-priority owner's snapshot, or null when no owner holds one. */
  frozen: FrozenSelectionReveal | null;
  /** True when ANY owner suppresses selection-driven rebuilding. */
  suppressed: boolean;
}

function layerEntries(
  layers: SelectionRevealLayers,
): [SelectionRevealOwner, SelectionRevealLayer][] {
  return Object.entries(layers) as [SelectionRevealOwner, SelectionRevealLayer][];
}

function resolveLayers(layers: SelectionRevealLayers): SelectionRevealValue {
  let frozen: FrozenSelectionReveal | null = null;
  let winningPriority = -1;
  let suppressed = false;

  for (const [owner, layer] of layerEntries(layers)) {
    suppressed ||= layer.suppressed;
    if (layer.frozen && OWNER_PRIORITY[owner] > winningPriority) {
      frozen = layer.frozen;
      winningPriority = OWNER_PRIORITY[owner];
    }
  }
  return { layers, frozen, suppressed };
}

/** Freezes markdown selection reveal at the given selection until that owner releases it. */
export const freezeMarkdownSelectionReveal = StateEffect.define<{
  owner: SelectionRevealOwner;
  snapshot: FrozenSelectionReveal;
}>();

/** Clears one owner's markdown selection reveal snapshot. */
export const clearMarkdownSelectionReveal = StateEffect.define<SelectionRevealOwner>();

/** Suppresses selection-driven decoration rebuilding on behalf of one owner. */
export const suppressMarkdownSelectionReveal = StateEffect.define<{
  owner: SelectionRevealOwner;
  suppressed: boolean;
}>();

/** Per-editor markdown selection reveal state shared by live preview, pointer interactions, and find. */
export const markdownSelectionRevealState = StateField.define<SelectionRevealValue>({
  create: () => resolveLayers({}),
  update(value, transaction) {
    const next: SelectionRevealLayers = { ...value.layers };
    let changed = false;

    function patch(owner: SelectionRevealOwner, fields: Partial<SelectionRevealLayer>): void {
      const current = next[owner] ?? { frozen: null, suppressed: false };
      const merged = { ...current, ...fields };
      if (merged.frozen === current.frozen && merged.suppressed === current.suppressed) return;
      changed = true;
      if (merged.frozen || merged.suppressed) next[owner] = merged;
      else delete next[owner];
    }

    if (transaction.docChanged) {
      for (const [owner, layer] of layerEntries(value.layers)) {
        if (!layer.frozen) continue;
        patch(owner, {
          frozen: {
            ...layer.frozen,
            ranges: layer.frozen.ranges.map((range) => range.map(transaction.changes)),
          },
        });
      }
    }

    for (const effect of transaction.effects) {
      if (effect.is(freezeMarkdownSelectionReveal)) {
        patch(effect.value.owner, { frozen: effect.value.snapshot });
      } else if (effect.is(clearMarkdownSelectionReveal)) {
        patch(effect.value, { frozen: null });
      } else if (effect.is(suppressMarkdownSelectionReveal)) {
        patch(effect.value.owner, { suppressed: effect.value.suppressed });
      }
    }
    return changed ? resolveLayers(next) : value;
  },
});

/** Creates a detached selection snapshot suitable for freezeMarkdownSelectionReveal. */
export function createSelectionRevealSnapshot(
  hasFocus: boolean,
  ranges: readonly SelectionRangeLike[],
): FrozenSelectionReveal {
  return {
    hasFocus,
    ranges: ranges.map(({ from, to }) => EditorSelection.range(from, to)),
  };
}

/** True when selection-driven decoration rebuilding is suppressed for this editor state. */
export function isMarkdownSelectionRevealSuppressed(state: EditorState): boolean {
  return state.field(markdownSelectionRevealState, false)?.suppressed ?? false;
}

export function getCursorLinesForReveal(
  hasFocus: boolean,
  ranges: readonly SelectionRangeLike[],
  doc: LineNumberLookup,
): Set<number> {
  if (!hasFocus) return new Set();
  return new Set(ranges.map((range) => doc.lineAt(range.from).number));
}

export function isBlockRevealSensitive(nodeName: string): boolean {
  return /^(ATXHeading|FencedCode|CodeBlock|HorizontalRule)/.test(nodeName);
}

export function isInlineRevealSensitive(nodeName: string): boolean {
  return /^(Link|Image|Task)/.test(nodeName);
}

export function selectionTouchesRange(
  state: EditorState,
  hasFocus: boolean,
  ranges: readonly SelectionRangeLike[],
  from: number,
  to: number,
): boolean {
  const effectiveRanges = getEffectiveRanges(state, hasFocus, ranges);
  return effectiveRanges !== null && selectionIntersectsRange(effectiveRanges, from, to);
}

export function selectionIntersectsRange(
  ranges: readonly SelectionRangeLike[],
  from: number,
  to: number,
): boolean {
  return ranges.some((range) =>
    range.from === range.to
      ? range.from >= from && range.from <= to
      : range.from < to && range.to > from,
  );
}

export function selectionWithinMarkerRange(
  state: EditorState,
  hasFocus: boolean,
  ranges: readonly SelectionRangeLike[],
  markerStart: number,
  contentStart: number,
): boolean {
  const effectiveRanges = getEffectiveRanges(state, hasFocus, ranges);
  if (!effectiveRanges) return false;
  return effectiveRanges.some((range) =>
    range.from === range.to
      ? range.from >= markerStart && range.from < contentStart
      : range.from < contentStart && range.to > markerStart,
  );
}

export function shouldRevealMarkdownSyntax(
  state: EditorState,
  hasFocus: boolean,
  ranges: readonly SelectionRangeLike[],
  from: number,
  to: number,
): boolean {
  return selectionTouchesRange(state, hasFocus, ranges, from, to);
}

export function shouldRevealInlineMarkers(view: EditorView, from: number, to: number): boolean {
  return selectionTouchesRange(view.state, view.hasFocus, view.state.selection.ranges, from, to);
}

export function shouldSkipBlockDecorations(
  nodeName: string,
  line: number,
  cursorLines: Set<number>,
): boolean;
export function shouldSkipBlockDecorations(
  nodeName: string,
  state: EditorState,
  from: number,
  to: number,
  hasFocus: boolean,
  ranges: readonly SelectionRangeLike[],
): boolean;
export function shouldSkipBlockDecorations(
  nodeName: string,
  lineOrState: number | EditorState,
  fromOrCursorLines: number | Set<number>,
  to = 0,
  hasFocus = false,
  ranges: readonly SelectionRangeLike[] = [],
): boolean {
  if (!isBlockRevealSensitive(nodeName)) return false;
  if (typeof lineOrState === 'number') {
    return (fromOrCursorLines as Set<number>).has(lineOrState);
  }
  return shouldRevealMarkdownSyntax(lineOrState, hasFocus, ranges, fromOrCursorLines as number, to);
}

export function shouldSkipInlineDecorations(
  nodeName: string,
  state: EditorState,
  from: number,
  to: number,
  hasFocus: boolean,
  ranges: readonly SelectionRangeLike[],
): boolean {
  return (
    isInlineRevealSensitive(nodeName) && selectionTouchesRange(state, hasFocus, ranges, from, to)
  );
}

export function shouldHideHeaderTagBlock(blockLastLine: number, cursorLines: Set<number>): boolean {
  for (let line = 1; line <= blockLastLine; line += 1) {
    if (cursorLines.has(line)) return false;
  }
  return true;
}

function getEffectiveRanges(
  state: EditorState,
  hasFocus: boolean,
  ranges: readonly SelectionRangeLike[],
): readonly SelectionRangeLike[] | null {
  const reveal = state.field(markdownSelectionRevealState, false);
  if (reveal?.frozen) return reveal.frozen.hasFocus ? reveal.frozen.ranges : null;
  if (reveal?.suppressed || !hasFocus) return null;
  return ranges;
}
