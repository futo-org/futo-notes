# CodeMirror 6 Scroll Compensation for External Scroll Containers

**Date:** 2026-02-06
**Problem:** Scroll jumping when scrolling notes with line wrapping + live markdown decorations
**Status:** Solved

## The Problem

When scrolling through notes with wrapped lines and live markdown decorations (hiding syntax markers, rendering tables/images as widgets), the viewport would visibly jump. This was especially bad on longer notes with lots of wrapped content.

## Root Cause

CodeMirror 6 estimates heights for off-screen wrapped lines using `estimatedLineHeight`. When those lines scroll into view and get rendered, the actual height differs from the estimate. CM normally compensates by adjusting `scrollDOM.scrollTop` — but in our architecture, `.cm-scroller` has `overflow: visible` (so the title and editor scroll together in `.note-body`), meaning CM's `scrollDOM` can't actually scroll. The height correction is silently discarded, and the content shifts visibly.

### Our Layout

```
.note-body          ← real scroll container (overflow-y: auto)
  .note-title-row   ← title scrolls with content
  .editor-container
    .cm-editor
      .cm-scroller  ← CM's scrollDOM (overflow: visible !important)
        .cm-content
```

CM walks DOM ancestors and correctly detects `.note-body` as a scrollable parent (attaches scroll listeners to it). Its viewport detection works fine. But its scroll compensation (`scrollDOM.scrollTop += adjust`) is a no-op because `.cm-scroller` can't scroll.

## What Didn't Work

### `forceFullMeasure` (scrolling through entire document on load)

The idea: scroll through the entire document in viewport-sized steps on load, forcing CM to render and measure every line. Then scroll back to top.

Problems:
1. Initially was scrolling `.cm-scroller` (can't scroll — no-op)
2. Even after fixing to scroll `.note-body`, CM may not retain all height measurements for lines far outside the viewport
3. Hides the editor during measurement (blank flash on note open)
4. Slow for large documents (hundreds of rAF frames)

### Widget `estimatedHeight` overrides alone

Setting accurate `estimatedHeight` on widgets (HiddenWidget → 0, HorizontalRuleWidget → 18, inline widgets → 0) helps reduce the magnitude of jumps but doesn't eliminate them. The main source of height mismatch is wrapped text lines, not widgets.

## What Worked: Scroll Compensation

Instead of preventing height mismatches, we **detect and compensate** for them in real-time.

### Algorithm

1. **On every scroll event**: Save an "anchor" — the document position of the line at the top of the viewport and its position in CM's height map (`lineBlockAtHeight(vpTop).from` and `.top`)

2. **On CM update with `heightChanged`**: Check if the anchor line's position in the height map shifted. If so, adjust `scrollParent.scrollTop` by the delta.

3. **Timing**: CM's `updateListener` fires within the same `requestAnimationFrame` as its measure cycle — before the browser paints. So the scroll correction is applied before the user sees any shift.

### Key Implementation Details

```typescript
// Save anchor on scroll
function updateScrollAnchor(v: EditorView) {
  const vpTop = sp.getBoundingClientRect().top - v.dom.getBoundingClientRect().top;
  if (vpTop > 0) {
    const block = v.lineBlockAtHeight(vpTop);
    anchorPos = block.from;
    anchorBlockTop = block.top;
  }
}

// Compensate on height change
EditorView.updateListener.of(update => {
  if (update.heightChanged && !update.docChanged && anchorPos >= 0) {
    const block = update.view.lineBlockAt(anchorPos);
    const delta = block.top - anchorBlockTop;
    if (Math.abs(delta) > 0.5) {
      scrollParent.scrollTop += delta;
      anchorBlockTop = block.top;
    }
  }
  updateScrollAnchor(update.view);
});
```

### Why `!update.docChanged`

We only compensate for **rendering-induced** height changes (CM discovering actual heights differ from estimates when lines enter the viewport). User edits that change height are handled normally by CM's cursor-keeping logic.

### The `compensating` flag

When we adjust `scrollTop`, it fires a scroll event. Without protection, that would update the anchor with stale data. The `compensating` flag (reset on next rAF) prevents the scroll handler from updating the anchor during our correction.

### Svelte 5 Reactivity Considerations

`scrollParent` is read lazily inside callbacks (not synchronously in the `$effect` body), so it's NOT tracked as an `$effect` dependency. This prevents the editor from being destroyed and recreated when `scrollParent` goes from `null` to the bound element. The same pattern is used for `onchange`.

## Files

- `src/components/MarkdownEditor.svelte` — scroll compensation logic
- `src/components/NotesShell.svelte` — binds `.note-body`, passes as `scrollParent`
- `src/lib/liveMarkdownTransform.ts` — widget `estimatedHeight` overrides (supplementary)
- `src/lib/tableWidget.ts` — table widget `estimatedHeight` (already existed)

## Lessons Learned

1. When using CM6 with an external scroll container (`overflow: visible` on `.cm-scroller`), CM's built-in scroll compensation breaks silently. You must implement your own.
2. `lineBlockAtHeight()` and `lineBlockAt()` use CM's internal height map and work for any position (not just visible ones). They're the right API for scroll compensation.
3. CM's `updateListener` fires synchronously within the measure cycle (same rAF), so scroll corrections applied there happen before browser paint — making them invisible.
4. Pre-measuring all lines (`forceFullMeasure`) is fragile and slow. Real-time compensation is more robust and has no startup cost.
