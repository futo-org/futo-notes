// @vitest-environment jsdom
import { Schema } from '@milkdown/kit/prose/model';
import { EditorState, TextSelection } from '@milkdown/kit/prose/state';
import { EditorView } from '@milkdown/kit/prose/view';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FindMatchReport } from './findMatches';
import {
  FIND_CURRENT_CLASS,
  FIND_MATCH_CLASS,
  closeFind,
  createFindPlugin,
  findSuppressesSelectionToolbar,
  getFindState,
  isFindOpen,
  openFind,
  setFindOverlayInset,
  setFindQuery,
  stepFind,
} from './findPlugin';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block',
      content: 'text*',
      toDOM: () => ['p', 0],
      parseDOM: [{ tag: 'p' }],
    },
    text: {},
  },
  marks: {},
});

const views: EditorView[] = [];

afterEach(() => {
  while (views.length) views.pop()?.destroy();
});

interface Harness {
  view: EditorView;
  reports: FindMatchReport[];
}

function mount(paragraphs: string[], onMatches?: (report: FindMatchReport) => void): Harness {
  const reports: FindMatchReport[] = [];
  const doc = schema.nodes.doc.create(
    null,
    paragraphs.map((text) =>
      schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined),
    ),
  );
  const host = document.createElement('div');
  document.body.appendChild(host);
  const view = new EditorView(host, {
    state: EditorState.create({
      doc,
      plugins: [
        createFindPlugin({
          onMatches: (report) => {
            reports.push(report);
            onMatches?.(report);
          },
        }),
      ],
    }),
  });
  views.push(view);
  return { view, reports };
}

/** Set the query and let the rescan it schedules run. */
async function query(view: EditorView, text: string): Promise<void> {
  setFindQuery(view, text);
  await settle();
}

/** Let the plugin's scheduled rescan (one animation frame) run. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function selectionText(view: EditorView): string {
  const { from, to } = view.state.selection;
  return view.state.doc.textBetween(from, to);
}

function decoratedText(view: EditorView): { all: string[]; current: string[] } {
  const set = getFindState(view.state).decorations;
  const all: string[] = [];
  const current: string[] = [];
  for (const decoration of set.find()) {
    const text = view.state.doc.textBetween(decoration.from, decoration.to);
    const spec = (decoration as unknown as { type: { attrs?: { class?: string } } }).type.attrs;
    if (spec?.class?.includes(FIND_CURRENT_CLASS)) current.push(text);
    if (spec?.class?.includes(FIND_MATCH_CLASS)) all.push(text);
  }
  return { all, current };
}

function placeCaret(view: EditorView, pos: number): void {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
}

describe('open', () => {
  it('seeds the query from a non-empty selection and jumps to the nearest match', async () => {
    const { view } = mount(['cat dog', 'cat again']);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 4)));

    openFind(view);

    expect(getFindState(view.state).query).toBe('cat');
    expect(getFindState(view.state).matches).toHaveLength(2);
    expect(selectionText(view)).toBe('cat');
    expect(isFindOpen(view.state)).toBe(true);
  });

  it('reuses the previous query when the selection is empty', async () => {
    const { view } = mount(['cat dog cat']);
    openFind(view);
    await query(view, 'cat');
    closeFind(view);

    placeCaret(view, 1);
    openFind(view);

    expect(getFindState(view.state).query).toBe('cat');
    expect(getFindState(view.state).matches).toHaveLength(2);
  });

  it('reports 0 for a query that matches nothing', async () => {
    const { view, reports } = mount(['cat dog']);
    openFind(view);
    await query(view, 'zebra');

    expect(reports.at(-1)).toEqual({ query: 'zebra', current: 0, total: 0, label: '0' });
  });
});

describe('decorations', () => {
  it('marks every match and distinguishes the current one', async () => {
    const { view } = mount(['cat dog CAT']);
    openFind(view);
    await query(view, 'cat');

    const decorated = decoratedText(view);
    expect(decorated.all).toEqual(['cat', 'CAT']);
    expect(decorated.current).toEqual(['cat']);
  });

  it('clears every decoration on close', async () => {
    const { view } = mount(['cat cat']);
    openFind(view);
    await query(view, 'cat');
    expect(decoratedText(view).all).toHaveLength(2);

    closeFind(view);

    expect(decoratedText(view).all).toEqual([]);
  });
});

describe('stepping', () => {
  it('steps forward and wraps past the last match', async () => {
    const { view, reports } = mount(['cat', 'cat', 'cat']);
    openFind(view);
    await query(view, 'cat');
    expect(reports.at(-1)?.label).toBe('1 of 3');

    stepFind(view, 1);
    expect(reports.at(-1)?.label).toBe('2 of 3');
    stepFind(view, 1);
    expect(reports.at(-1)?.label).toBe('3 of 3');
    stepFind(view, 1);
    expect(reports.at(-1)?.label).toBe('1 of 3');
  });

  it('steps backward and wraps past the first match', async () => {
    const { view, reports } = mount(['cat', 'cat']);
    openFind(view);
    await query(view, 'cat');

    stepFind(view, -1);

    expect(reports.at(-1)?.label).toBe('2 of 2');
  });

  it('moves the selection onto the match it steps to', async () => {
    const { view } = mount(['alpha cat', 'beta cat']);
    openFind(view);
    await query(view, 'cat');
    const first = { ...view.state.selection };

    stepFind(view, 1);

    expect(view.state.selection.from).not.toBe(first.from);
    expect(selectionText(view)).toBe('cat');
  });

  it('is a no-op with zero matches', async () => {
    const { view } = mount(['cat']);
    openFind(view);
    await query(view, 'zebra');

    expect(stepFind(view, 1)).toBe(false);
  });

  it('does nothing while find is closed', async () => {
    const { view } = mount(['cat']);
    expect(stepFind(view, 1)).toBe(false);
    expect(setFindQuery(view, 'cat')).toBe(false);
  });
});

describe('editing while find is open', () => {
  it('rescans without moving the selection', async () => {
    const { view } = mount(['cat dog']);
    openFind(view);
    await query(view, 'cat');

    // The user clicks into the body past the match and types.
    placeCaret(view, 8);
    view.dispatch(view.state.tr.insertText(' cat', 8));
    const caret = view.state.selection.from;
    await settle();

    expect(getFindState(view.state).matches).toHaveLength(2);
    expect(view.state.selection.from).toBe(caret);
    expect(view.state.selection.empty).toBe(true);
  });

  it('keeps highlights on the matches an edit moved', async () => {
    const { view } = mount(['cat']);
    openFind(view);
    await query(view, 'cat');

    view.dispatch(view.state.tr.insertText('xx', 1));
    await settle();

    expect(decoratedText(view).all).toEqual(['cat']);
    expect(view.state.doc.textBetween(1, 6)).toBe('xxcat');
  });
});

describe('close', () => {
  it('restores the pre-find selection when asked', async () => {
    const { view } = mount(['alpha', 'cat here']);
    placeCaret(view, 3);
    openFind(view);
    await query(view, 'cat');
    expect(selectionText(view)).toBe('cat');

    closeFind(view, { restoreOrigin: true });

    expect(view.state.selection.from).toBe(3);
    expect(isFindOpen(view.state)).toBe(false);
  });

  it('leaves the selection on the current match otherwise', async () => {
    const { view } = mount(['alpha', 'cat here']);
    placeCaret(view, 3);
    openFind(view);
    await query(view, 'cat');

    closeFind(view, { returnFocus: false });

    expect(selectionText(view)).toBe('cat');
  });

  it('is a no-op when find is not open', async () => {
    const { view } = mount(['cat']);
    expect(closeFind(view)).toBe(false);
  });
});

describe('the selection-toolbar gate', () => {
  it('is on while find is open', async () => {
    const { view } = mount(['cat dog']);
    openFind(view);
    await query(view, 'cat');
    expect(findSuppressesSelectionToolbar(view.state)).toBe(true);
  });

  it('stays on for the selection a close leaves behind', async () => {
    const { view } = mount(['cat dog']);
    openFind(view);
    await query(view, 'cat');
    closeFind(view);
    expect(findSuppressesSelectionToolbar(view.state)).toBe(true);
  });

  it('lifts as soon as the user selects something else', async () => {
    const { view } = mount(['cat dog']);
    openFind(view);
    await query(view, 'cat');
    closeFind(view);

    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 5, 8)));

    expect(findSuppressesSelectionToolbar(view.state)).toBe(false);
  });
});

describe('reports', () => {
  it('never repeats an identical report', async () => {
    const { view, reports } = mount(['cat cat']);
    openFind(view);
    await query(view, 'cat');
    const before = reports.length;

    // A transaction that changes nothing find cares about.
    placeCaret(view, 1);
    placeCaret(view, 2);

    expect(reports).toHaveLength(before);
  });
});

describe('the overlay inset', () => {
  it('records what a bar says it covers, and ignores a repeat', async () => {
    const { view } = mount(['cat']);
    openFind(view);
    setFindOverlayInset(view, 44);
    expect(getFindState(view.state).overlayInset).toBe(44);

    const dispatch = vi.spyOn(view, 'dispatch');
    setFindOverlayInset(view, 44);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
