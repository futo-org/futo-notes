// @vitest-environment jsdom
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
      const view = setup('- alpha\n- beta\n  - nested\n1. one\n2. two');
      const plugin: any = view.plugin(liveMarkdownTransform);
      const widgets: any[] = [];
      const cur = plugin.decorations.iter();
      while (cur.value) {
        if (cur.value.spec.widget) widgets.push(cur.value.spec.widget);
        cur.next();
      }
      const markers = widgets.filter((w) => {
        const cls = w.toDOM(view).className ?? '';
        return cls.includes('cm-md-bullet') || cls.includes('cm-md-number');
      });
      expect(markers.length).toBeGreaterThanOrEqual(5);
      for (const w of markers) {
        expect(w.ignoreEvent()).toBe(false);
      }
    });
  });
});
