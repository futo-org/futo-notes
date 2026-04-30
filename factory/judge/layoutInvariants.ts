// Layout invariants — geometric / computed-style assertions that run
// against the live editor DOM after each scenario finishes dispatching.
// Independent of Obsidian: these are absolute UX guarantees FUTO Notes
// must hold ("cursor must be visually clear of the bullet glyph", etc.)
// rather than a parity check.
//
// All invariants run in a single `page.evaluate` round-trip — one
// CDP message per scenario — so adding more is cheap.
//
// An invariant returns:
//   null      → not applicable to this state (e.g. no list line present)
//   undefined → applicable and passing
//   string    → failure detail surfaced in the report
//
// New invariants: add an entry to INVARIANTS_SOURCE below. Keep them
// small and self-contained — they're stringified into the page.

import type { Page } from 'playwright';

export interface LayoutViolation {
  // Invariant id (machine-readable, stable).
  invariant: string;
  // One-sentence human-readable description.
  description: string;
  // Specifics of this particular failure (e.g. "gap = 1.2px, want >= 4px").
  detail: string;
}

// Each invariant is `{ name, description, fn }` evaluated in-page. We
// build the array as a JS source string so we can inject it into
// `page.evaluate` without serialization issues with function bodies.
const INVARIANTS_SOURCE = `
[
  {
    name: 'caret-visible-on-list-line',
    description: 'When the editor is focused and the cursor is on a list line, the caret must render at least one client rect.',
    fn: () => {
      const root = document.querySelector('.cm-content[data-factory-target="true"]');
      if (!root) return null;
      // Only fire when the editor actually has focus — otherwise the
      // selection's default (0,0) position can land inside a replaced
      // bullet range and look like a "caret invisible" bug, but the
      // user never sees a caret on a blurred editor.
      const cmEditor = root.closest('.cm-editor');
      if (!cmEditor || !cmEditor.classList.contains('cm-focused')) return null;
      const line = root.querySelector('.cm-line.cm-md-list-line, .cm-line.HyperMD-list-line');
      if (!line) return null;
      const sel = window.getSelection && window.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      const range = sel.getRangeAt(0).cloneRange();
      if (!line.contains(range.startContainer) && line !== range.startContainer) return null;
      range.collapse(true);
      const rects = Array.from(range.getClientRects());
      if (rects.length === 0) {
        const b = range.getBoundingClientRect();
        if ((!b.width && !b.height && !b.top && !b.left)) {
          return 'caret has no client rect (cursor likely landed inside a replaced range, e.g. the bullet source)';
        }
      }
      return undefined;
    }
  },
  {
    name: 'cursor-clear-of-bullet',
    description: 'When the caret is on a list line and visible, it must sit right of the bullet/number marker.',
    fn: () => {
      const root = document.querySelector('.cm-content[data-factory-target="true"]');
      if (!root) return null;
      const line = root.querySelector('.cm-line.cm-md-list-line, .cm-line.HyperMD-list-line');
      if (!line) return null;

      const sel = window.getSelection && window.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      const range = sel.getRangeAt(0).cloneRange();
      if (!line.contains(range.startContainer)) return null;
      range.collapse(true);

      const caretRects = Array.from(range.getClientRects());
      const caretRect = caretRects[0] || range.getBoundingClientRect();
      if (!caretRect || (!caretRect.width && !caretRect.height)) return null;

      const marker =
        line.querySelector('.cm-md-bullet, .cm-md-number, .cm-md-task-checkbox-wrapper') ||
        line.querySelector('.list-bullet, .list-number, .task-list-item-checkbox');
      if (!marker) return null;
      const m = marker.getBoundingClientRect();
      const gap = caretRect.left - m.right;
      // Negative gap is fine when the caret is logically before the bullet
      // (e.g. cursor at column 0 of a list line where the bullet is a
      // visual widget). Only flag a *positive small* gap — the cursor is
      // visually past the marker but uncomfortably close to it.
      const MIN_GAP = 2;
      if (gap >= 0 && gap < MIN_GAP) {
        return 'caret left = ' + caretRect.left.toFixed(1) +
          'px, marker right = ' + m.right.toFixed(1) +
          'px, gap = ' + gap.toFixed(1) + 'px (want >= ' + MIN_GAP + 'px)';
      }
      return undefined;
    }
  },
  {
    name: 'heading-line-height-ordering',
    description: 'Heading line-heights must monotonically shrink: h1 >= h2 >= h3 >= h4 >= h5 >= h6 >= body.',
    fn: () => {
      const root = document.querySelector('.cm-content[data-factory-target="true"]');
      if (!root) return null;
      const lh = (sel) => {
        const el = root.querySelector(sel);
        if (!el) return null;
        const v = parseFloat(getComputedStyle(el).lineHeight);
        return isFinite(v) ? v : null;
      };
      // SF and Obsidian use different class names; check both shapes.
      const heights = [
        lh('.cm-md-h1, .cm-header-1'),
        lh('.cm-md-h2, .cm-header-2'),
        lh('.cm-md-h3, .cm-header-3'),
        lh('.cm-md-h4, .cm-header-4'),
        lh('.cm-md-h5, .cm-header-5'),
        lh('.cm-md-h6, .cm-header-6'),
      ];
      const present = heights.filter(h => h !== null);
      if (present.length < 2) return null;
      for (let i = 0; i < heights.length - 1; i++) {
        const a = heights[i], b = heights[i + 1];
        if (a !== null && b !== null && a < b - 0.5) {
          return 'h' + (i + 1) + ' line-height (' + a + ') < h' + (i + 2) + ' (' + b + ')';
        }
      }
      return undefined;
    }
  },
  {
    name: 'cursor-reveal-does-not-shift-content',
    description: 'When the cursor reveals a marker on one line of a multi-line blockquote, the text content after the marker must not move horizontally relative to adjacent non-revealed lines AT THE SAME NESTING LEVEL. The revealed marker should sit in a gutter (negative margin / absolute position), not push content right. Lines at different nesting levels naturally have different x-positions; only compare within a level.',
    fn: () => {
      const root = document.querySelector('.cm-content[data-factory-target="true"]');
      if (!root) return null;
      const lines = Array.from(root.querySelectorAll('.cm-line'));
      // Group quote-text spans by their nesting-level class so we
      // only compare apples-to-apples (level-1 to level-1, etc.).
      const groups = new Map();
      for (const line of lines) {
        // Skip lines that have a list-item structure inside the quote —
        // their bullet/number widget legitimately offsets the text from
        // a quote-only line, and that's not a cursor-reveal bug.
        if (line.classList.contains('cm-md-list-line') ||
            line.classList.contains('HyperMD-list-line') ||
            line.querySelector('.cm-md-bullet, .cm-md-number, .list-bullet, .list-number')) {
          continue;
        }
        // For each line, find the LEFTMOST quote-text span per level —
        // a single line can have multiple spans (one per inline run
        // around emphasis/code/links), and we only care about where the
        // line's content STARTS, not where each span sits.
        const perLevel = new Map();
        const spans = Array.from(line.querySelectorAll('.cm-md-quote-text-1, .cm-md-quote-text-2, .cm-md-quote-text-3, .cm-quote-1, .cm-quote-2, .cm-quote-3'));
        for (const span of spans) {
          let level = '?';
          for (const c of Array.from(span.classList)) {
            const m = c.match(/(?:cm-md-quote-text-|cm-quote-)([1-9])/);
            if (m) { level = m[1]; break; }
          }
          const r = span.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          const cur = perLevel.get(level);
          if (cur === undefined || r.left < cur) perLevel.set(level, r.left);
        }
        for (const [level, x] of perLevel) {
          if (!groups.has(level)) groups.set(level, []);
          groups.get(level).push({ x, sample: (line.textContent || '').slice(0, 20) });
        }
      }
      for (const [level, xs] of groups) {
        if (xs.length < 2) continue;
        const left = Math.min(...xs.map((s) => s.x));
        const right = Math.max(...xs.map((s) => s.x));
        if (right - left > 3) {
          return 'blockquote level-' + level + ' text x-positions differ by ' +
            (right - left).toFixed(1) + 'px across lines (' +
            xs.map((s) => JSON.stringify(s.sample) + '@' + s.x.toFixed(0)).join(', ') +
            ') — revealed marker shifted content right';
        }
      }
      return undefined;
    }
  },
  {
    name: 'no-quote-marker-bleeds-through',
    description: 'A blockquote line that is not cursor-revealed must not display literal > characters in its rendered text — SF hides them via the marker-hidden class.',
    fn: () => {
      const root = document.querySelector('.cm-content[data-factory-target="true"]');
      if (!root) return null;
      if (!root.querySelector('.cm-md-quote-marker-hidden, .cm-md-quote-marker, .cm-md-quote-text')) return null;
      const sel = window.getSelection && window.getSelection();
      const cursorContainer = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).startContainer : null;
      const lines = root.querySelectorAll('.cm-line');
      for (const line of Array.from(lines)) {
        const isQuote = !!line.querySelector('.cm-md-quote-marker-hidden, .cm-md-quote-marker, .cm-md-quote-text');
        if (!isQuote) continue;
        const cursorOnThisLine = cursorContainer && line.contains(cursorContainer);
        if (cursorOnThisLine) continue;
        const txt = line.innerText || '';
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node) {
          const parent = node.parentElement;
          if (parent) {
            const cs = getComputedStyle(parent);
            const visible = cs.visibility !== 'hidden' &&
              cs.color !== 'transparent' &&
              cs.color !== 'rgba(0, 0, 0, 0)' &&
              parseFloat(cs.fontSize) > 0;
            if (visible && /[>]/.test(node.data)) {
              return 'line "' + txt.slice(0, 40) + '" leaks a literal > (parent classes: ' +
                Array.from(parent.classList).join(' ') + ')';
            }
          }
          node = walker.nextNode();
        }
      }
      return undefined;
    }
  },
  {
    name: 'list-line-has-hanging-indent',
    description: 'List lines must apply hanging indent so wrapped text aligns with the first content character, not the bullet.',
    fn: () => {
      const root = document.querySelector('.cm-content[data-factory-target="true"]');
      if (!root) return null;
      const line = root.querySelector('.cm-line.cm-md-list-line, .cm-line.HyperMD-list-line');
      if (!line) return null;
      const cs = getComputedStyle(line);
      const padLeft = parseFloat(cs.paddingLeft) || 0;
      const textIndent = parseFloat(cs.textIndent) || 0;
      // Hanging indent: padding-left positive AND text-indent negative
      // (or applied via a different mechanism on Obsidian — accept any
      // padding > 0 as evidence the line's first wrap aligns).
      if (padLeft <= 0) {
        return 'padding-left = ' + padLeft + 'px (want > 0 for hanging indent)';
      }
      // Text-indent isn't always negative on Obsidian (uses different
      // hanging-indent mechanism), so only enforce on SF where we use it.
      if (line.classList.contains('cm-md-list-line') && textIndent >= 0) {
        return 'text-indent = ' + textIndent + 'px (want < 0 for hanging indent)';
      }
      return undefined;
    }
  }
]
`;

export async function runLayoutInvariants(page: Page): Promise<LayoutViolation[]> {
  const result = await page.evaluate((src: string) => {
    // eslint-disable-next-line no-eval
    const invariants = (0, eval)('(' + src + ')') as Array<{
      name: string;
      description: string;
      fn: () => string | null | undefined;
    }>;
    const out: Array<{ invariant: string; description: string; detail: string }> = [];
    for (const inv of invariants) {
      try {
        const res = inv.fn();
        if (typeof res === 'string') {
          out.push({ invariant: inv.name, description: inv.description, detail: res });
        }
      } catch (e) {
        out.push({
          invariant: inv.name,
          description: inv.description,
          detail: 'invariant threw: ' + (e instanceof Error ? e.message : String(e)),
        });
      }
    }
    return out;
  }, INVARIANTS_SOURCE);
  return result as LayoutViolation[];
}
