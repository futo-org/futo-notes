// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { EditorState, Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ensureSyntaxTree } from '@codemirror/language';
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
  const state = EditorState.create({
    doc,
    extensions: [markdown(), liveMarkdownTransform],
  });
  const tree = ensureSyntaxTree(state, state.doc.length, 5000);
  if (!tree || tree.length < state.doc.length) {
    throw new Error(
      `test setup did not finish parsing the document (${tree?.length ?? 0}/${state.doc.length})`,
    );
  }
  const view = new EditorView({
    state,
    parent: document.body,
  });
  views.push(view);
  return view;
}

function collectDecos(view: EditorView): DecoInfo[] {
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
  return decos.filter((d) => d.class?.includes(cls));
}

function visibleText(view: EditorView): string {
  return view.contentDOM.textContent ?? '';
}

/**
 * Reach a document the way a user does: one character at a time through the
 * update path, then move the caret off the text so its markers un-reveal and
 * the hide (replacing) decorations are actually attempted.
 */
function typeThenMoveCaretAway(doc: string): EditorView {
  const view = setup('');
  for (const ch of doc) {
    const pos = view.state.selection.main.head;
    view.dispatch({ changes: { from: pos, insert: ch }, selection: { anchor: pos + ch.length } });
  }
  view.dispatch({ selection: { anchor: 0 } });
  view.dispatch({ effects: liveMarkdownRefresh.of(null) });
  return view;
}

describe('liveMarkdownTransform decorations', () => {
  describe('wikilinks', () => {
    it('hides [[ and ]] and styles content as wikilink', () => {
      const view = setup('text [[foo]] more');
      const all = collectDecos(view);

      const classDecosOverBrackets = all.filter(
        (d) => d.class && ((d.from === 5 && d.to === 7) || (d.from === 10 && d.to === 12)),
      );
      expect(classDecosOverBrackets).toEqual([]);

      const wikilinks = withClass(all, 'cm-md-wikilink');
      expect(wikilinks).toHaveLength(1);
      expect(wikilinks[0]).toMatchObject({ from: 7, to: 10 });
      expect(wikilinks[0].class).toContain('cm-md-wikilink');
      expect(wikilinks[0].attributes).toEqual({ 'data-wikilink': 'foo' });
    });

    it('decorates multiple wikilinks on a single line', () => {
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

  describe('inline tags', () => {
    it('applies cm-md-tag class to hashtags', () => {
      const view = setup('hello #project world');
      const tags = withClass(collectDecos(view), 'cm-md-tag');
      expect(tags).toHaveLength(2);
      expect(tags[0]).toMatchObject({ from: 6, to: 7 });
      expect(tags[1]).toMatchObject({ from: 7, to: 14 });
    });

    it('decorates header-block tags and still hides those lines', () => {
      const view = setup('#tag1 #tag2\n\nhello #tag3 world');
      const all = collectDecos(view);

      const tags = withClass(all, 'cm-md-tag');
      expect(tags).toHaveLength(6);

      const hiddenLines = withClass(all, 'cm-header-tag-hidden');
      expect(hiddenLines).toHaveLength(2);
      expect(hiddenLines[0]).toMatchObject({ from: 0, to: 0 }); // line 1
      expect(hiddenLines[1]).toMatchObject({ from: 12, to: 12 }); // line 2 (separator)
    });

    it('skips tags inside inline code', () => {
      const view = setup('before `#notag` after');
      expect(withClass(collectDecos(view), 'cm-md-tag')).toHaveLength(0);
    });

    it('decorates multiple tags on one line', () => {
      const view = setup('hello #a #bc world');
      expect(withClass(collectDecos(view), 'cm-md-tag')).toHaveLength(4);
    });
  });

  describe('hot-path regression guards', () => {
    it('wikilink processing does not add full-doc toString calls', () => {
      const plain = setup('just some plain text here today');
      const spy = vi.spyOn(Text.prototype, 'toString');
      plain.dispatch({ effects: liveMarkdownRefresh.of(null) });
      const baselineCalls = spy.mock.calls.length;
      spy.mockClear();

      const wiki = setup('text [[foo]] and [[bar]] here');
      spy.mockClear();
      wiki.dispatch({ effects: liveMarkdownRefresh.of(null) });
      const wikiCalls = spy.mock.calls.length;

      expect(wikiCalls).toBe(baselineCalls);
    });

    it('decoration rebuild has at most 2 full-doc toString calls', () => {
      const view = setup('text [[wiki]] #tag and more');
      const spy = vi.spyOn(Text.prototype, 'toString');
      view.dispatch({ effects: liveMarkdownRefresh.of(null) });

      expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
    });

    it('decorations remain correct after selection-only updates', () => {
      const view = setup('text [[foo]] and #tag here');

      const check = () => {
        expect(withClass(collectDecos(view), 'cm-md-wikilink')).toHaveLength(1);
        expect(withClass(collectDecos(view), 'cm-md-tag')).toHaveLength(2);
      };

      check(); // initial
      view.dispatch({ selection: { anchor: 0 } });
      check(); // after cursor move
      view.dispatch({ selection: { anchor: 15 } });
      check(); // after second cursor move
    });
  });

  describe('list marker widgets accept editor events (tap-to-caret)', () => {
    it('bullet and number markers return ignoreEvent() === false', () => {
      const assertMarkerContract = (doc: string, markerClass: string) => {
        const view = setup(doc);
        const plugin: any = view.plugin(liveMarkdownTransform);
        const cur = plugin.decorations.iter();
        let marker: any;
        while (cur.value) {
          const widget = cur.value.spec.widget;
          if (widget?.toDOM(view).className?.includes(markerClass)) {
            marker = widget;
            break;
          }
          cur.next();
        }

        expect(marker, `${markerClass} widget was not rendered`).toBeDefined();
        expect(marker.ignoreEvent()).toBe(false);
      };

      // Parse each widget independently. Requiring every decoration from one
      // mixed, multi-line document made this contract test depend on CM6's
      // background parse scheduling under a loaded CI worker.
      assertMarkerContract('- alpha', 'cm-md-bullet');
      assertMarkerContract('1. one', 'cm-md-number');
    });
  });
});

// CM6 rejects a replacing decoration that covers a line break when it comes
// from a view plugin ("Decorations that replace line breaks may not be
// specified via plugins"). Malformed-but-parsed inline nodes can straddle a
// newline, and hiding their syntax then threw whenever the markers were not
// revealed: on the very first render of a freshly created state (the shape
// `openNote`/`view.setState` produces, which left the PREVIOUS note on
// screen), and equally on the update path — typing the same text one
// character at a time and then moving the caret off it throws identically.
// Both shapes are covered below; the guard is needed on both.
describe('inline nodes that straddle a line break', () => {
  it('renders a link whose "](...)" crosses a newline instead of throwing', () => {
    const view = setup(' [](\n)');

    expect(visibleText(view)).toContain('[](');
    expect(visibleText(view)).toContain(')');
    const linkMarkers = withClass(collectDecos(view), 'cm-md-link');
    expect(linkMarkers.length).toBeGreaterThan(0);
  });

  it('renders an image whose "](...)" crosses a newline instead of throwing', () => {
    const view = setup(' ![](\n)');

    expect(visibleText(view)).toContain('![](');
    expect(visibleText(view)).toContain(')');
  });

  it('still hides link syntax when only the link text crosses the newline', () => {
    const view = setup('[a\nb](c)');

    expect(visibleText(view)).toBe('ab');
    expect(withClass(collectDecos(view), 'cm-md-link')).toHaveLength(1);
  });

  it('still hides link syntax for a single-line link', () => {
    const view = setup('see [text](https://example.com) end');

    expect(visibleText(view)).toBe('see text end');
  });

  it('renders a link typed one character at a time instead of throwing', () => {
    const view = typeThenMoveCaretAway(' [](\n)');

    expect(view.state.doc.toString()).toBe(' [](\n)');
    expect(visibleText(view)).toContain('[](');
    expect(visibleText(view)).toContain(')');
  });

  it('renders an image typed one character at a time instead of throwing', () => {
    const view = typeThenMoveCaretAway(' ![](\n)');

    expect(view.state.doc.toString()).toBe(' ![](\n)');
    expect(visibleText(view)).toContain('![](');
    expect(visibleText(view)).toContain(')');
  });
});

// Kept as a top-level sibling rather than nested in the describe above, which
// is already at the max-lines-per-function ceiling.
describe('list items carrying leading indentation', () => {
  // lezer-markdown spans a ListItem from the MARKER when the item opens a
  // nested BulletList, but from the LINE START — indent included — when the
  // item is a sibling that merely happens to be indented. parseListMarker used
  // to anchor on the marker with no allowance for that indent, so the whole
  // item fell through undecorated: raw `*` on screen, no bullet.
  function bulletWidgetCount(view: EditorView): number {
    const plugin: any = view.plugin(liveMarkdownTransform);
    const cur = plugin.decorations.iter();
    let count = 0;
    while (cur.value) {
      const widget = cur.value.spec.widget;
      if (widget?.toDOM(view).className?.includes('cm-md-bullet')) count += 1;
      cur.next();
    }
    return count;
  }

  it('renders a bullet for a sibling indented less than the parent content column', () => {
    // `*  Parent.` puts its content at column 3, so a two-space child is not
    // deep enough to nest and CommonMark demotes it to an outer-list sibling.
    const view = setup('*  Parent.\n  * child\n');

    expect(bulletWidgetCount(view)).toBe(2);
    expect(withClass(collectDecos(view), 'cm-md-ul-item')).toHaveLength(2);
  });

  it('renders bullets for a whole list indented by one space', () => {
    const view = setup(' * alpha\n * beta\n');

    expect(bulletWidgetCount(view)).toBe(2);
    expect(withClass(collectDecos(view), 'cm-md-ul-item')).toHaveLength(2);
  });

  it('indents a shallow sibling at level 0, not at the parent depth', () => {
    const view = setup('*  Parent.\n  * child\n');
    const lines = withClass(collectDecos(view), 'cm-md-list-line');

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.attributes?.style).toBe('--list-depth: 0px; --list-marker-slot: 1em;');
    }
  });

  it('still indents a genuinely nested item one level in', () => {
    const view = setup('* Parent.\n  * child\n');
    const lines = withClass(collectDecos(view), 'cm-md-list-line');

    expect(lines).toHaveLength(2);
    expect(lines[0].attributes?.style).toBe('--list-depth: 0px; --list-marker-slot: 1em;');
    expect(lines[1].attributes?.style).toBe('--list-depth: 24px; --list-marker-slot: 1em;');
  });
});
