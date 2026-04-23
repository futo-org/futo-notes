// @vitest-environment jsdom
/**
 * Regression tests for liveMarkdownTransform decoration correctness and
 * performance-sensitive hot paths. Guards against:
 * - Wikilink/tag decoration regressions (hiding, styling, code-block skipping)
 * - Full-document string materializations in wikilink processing (must use line-by-line)
 * - Stale syntax trees after ensureSyntaxTree removal from selection-only paths
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { liveMarkdownTransform, liveMarkdownRefresh } from './liveMarkdownTransform';

interface DecoInfo {
  from: number;
  to: number;
  class?: string;
  attributes?: Record<string, string>;
}

const views: EditorView[] = [];

afterEach(() => {
  for (const v of views) v.destroy();
  views.length = 0;
  vi.restoreAllMocks();
});

function setup(doc: string): EditorView {
  const view = new EditorView({
    doc,
    extensions: [markdown(), liveMarkdownTransform],
    parent: document.body,
  });
  views.push(view);
  return view;
}

/** Collect all decorations from the plugin's DecorationSet. */
function collectDecos(view: EditorView): DecoInfo[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plugin: any = view.plugin(liveMarkdownTransform);
  if (!plugin) throw new Error('liveMarkdownTransform plugin not found');
  const result: DecoInfo[] = [];
  const cur = plugin.decorations.iter();
  while (cur.value) {
    const spec = cur.value.spec;
    const info: DecoInfo = { from: cur.from, to: cur.to };
    if (spec.class) info.class = spec.class;
    if (spec.attributes) info.attributes = spec.attributes;
    result.push(info);
    cur.next();
  }
  return result;
}

function withClass(decos: DecoInfo[], cls: string): DecoInfo[] {
  return decos.filter(d => d.class?.includes(cls));
}

describe('liveMarkdownTransform decorations', () => {
  // ── Wikilinks ─────────────────────────────────────────────────────

  describe('wikilinks', () => {
    it('hides [[ and ]] and styles content as wikilink', () => {
      // positions: text·[[foo]]·more
      //            0123456789...
      const view = setup('text [[foo]] more');
      const all = collectDecos(view);

      // [[ and ]] are removed from the DOM via Decoration.replace, so no
      // class-bearing decoration should cover those ranges.
      const classDecosOverBrackets = all.filter(
        (d) => d.class && ((d.from === 5 && d.to === 7) || (d.from === 10 && d.to === 12))
      );
      expect(classDecosOverBrackets).toEqual([]);

      // styled content at 7-10
      const wikilinks = withClass(all, 'cm-md-wikilink');
      expect(wikilinks).toHaveLength(1);
      expect(wikilinks[0]).toMatchObject({ from: 7, to: 10, class: 'cm-md-link cm-md-wikilink' });
      expect(wikilinks[0].attributes).toEqual({ 'data-wikilink': 'foo' });
    });

    it('decorates multiple wikilinks on a single line', () => {
      // [[a]](0-5) and [[bc]](10-16)
      const view = setup('[[a]] and [[bc]]');
      const wikilinks = withClass(collectDecos(view), 'cm-md-wikilink');
      expect(wikilinks).toHaveLength(2);
      expect(wikilinks[0]).toMatchObject({ from: 2, to: 3 });
      expect(wikilinks[1]).toMatchObject({ from: 12, to: 14 });
    });

    it('decorates wikilinks on different lines', () => {
      const view = setup('line1 [[a]]\nline2 [[b]]');
      const wikilinks = withClass(collectDecos(view), 'cm-md-wikilink');
      expect(wikilinks).toHaveLength(2);
    });

    it('skips wikilinks inside inline code', () => {
      const view = setup('before `[[not]]` after');
      expect(withClass(collectDecos(view), 'cm-md-wikilink')).toHaveLength(0);
    });

    it('skips wikilinks inside fenced code blocks', () => {
      const view = setup('before\n\n```\n[[not a link]]\n```\n\nafter');
      expect(withClass(collectDecos(view), 'cm-md-wikilink')).toHaveLength(0);
    });
  });

  // ── Inline tags ───────────────────────────────────────────────────

  describe('inline tags', () => {
    it('applies cm-md-tag class to hashtags', () => {
      // #project at positions 6-14
      const view = setup('hello #project world');
      const tags = withClass(collectDecos(view), 'cm-md-tag');
      expect(tags).toHaveLength(1);
      expect(tags[0]).toMatchObject({ from: 6, to: 14 });
    });

    it('skips tags in header block and hides those lines', () => {
      // Header block: "#tag1 #tag2\n" + empty separator "\n"
      // endOffset = 13, so #tag1 (0) and #tag2 (6) are skipped
      // #tag3 at position 19 is after the block
      const view = setup('#tag1 #tag2\n\nhello #tag3 world');
      const all = collectDecos(view);

      const tags = withClass(all, 'cm-md-tag');
      expect(tags).toHaveLength(1);
      expect(tags[0]).toMatchObject({ from: 19, to: 24 });

      // header block lines get cm-header-tag-hidden line decorations
      const hiddenLines = withClass(all, 'cm-header-tag-hidden');
      expect(hiddenLines).toHaveLength(2);
      expect(hiddenLines[0]).toMatchObject({ from: 0, to: 0 });   // line 1
      expect(hiddenLines[1]).toMatchObject({ from: 12, to: 12 }); // line 2 (separator)
    });

    it('skips tags inside inline code', () => {
      const view = setup('before `#notag` after');
      expect(withClass(collectDecos(view), 'cm-md-tag')).toHaveLength(0);
    });

    it('decorates multiple tags on one line', () => {
      const view = setup('hello #a #bc world');
      expect(withClass(collectDecos(view), 'cm-md-tag')).toHaveLength(2);
    });
  });

  // ── Hot-path regression guards ────────────────────────────────────

  describe('hot-path regression guards', () => {
    it('wikilink processing does not add full-doc toString calls', () => {
      // Baseline: plain text with no wikilinks
      const plain = setup('just some plain text here today');
      const spy = vi.spyOn(Text.prototype, 'toString');
      plain.dispatch({ effects: liveMarkdownRefresh.of(null) });
      const baselineCalls = spy.mock.calls.length;
      spy.mockClear();

      // With wikilinks: should have the same toString count
      const wiki = setup('text [[foo]] and [[bar]] here');
      spy.mockClear();
      wiki.dispatch({ effects: liveMarkdownRefresh.of(null) });
      const wikiCalls = spy.mock.calls.length;

      // Line-by-line wikilink iteration must not add full-doc materializations.
      // If wikiCalls > baselineCalls, processWikilinks regressed to doc.toString().
      expect(wikiCalls).toBe(baselineCalls);
    });

    it('decoration rebuild has at most 2 full-doc toString calls', () => {
      const view = setup('text [[wiki]] #tag and more');
      const spy = vi.spyOn(Text.prototype, 'toString');
      view.dispatch({ effects: liveMarkdownRefresh.of(null) });

      // Current baseline: 2 calls per build (header-tag-block + inline-tag regex).
      // If optimizations reduce this, update the bound downward.
      expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
    });

    it('decorations remain correct after selection-only updates', () => {
      // Guards: removing ensureSyntaxTree from selection-only paths
      // must not leave a stale tree that breaks decorations.
      const view = setup('text [[foo]] and #tag here');

      const check = () => {
        expect(withClass(collectDecos(view), 'cm-md-wikilink')).toHaveLength(1);
        expect(withClass(collectDecos(view), 'cm-md-tag')).toHaveLength(1);
      };

      check(); // initial
      view.dispatch({ selection: { anchor: 0 } });
      check(); // after cursor move
      view.dispatch({ selection: { anchor: 15 } });
      check(); // after second cursor move
    });
  });
});
