// @vitest-environment jsdom
import { markdown } from '@codemirror/lang-markdown';
import { Decoration, EditorView, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LiveMarkdownPlugin } from './LiveMarkdownPlugin';

const { actualSyntaxTree, ensureSyntaxTreeMock, syntaxTreeMock } = vi.hoisted(() => ({
  actualSyntaxTree: {
    current: null as null | (typeof import('@codemirror/language'))['syntaxTree'],
  },
  ensureSyntaxTreeMock: vi.fn(),
  syntaxTreeMock: vi.fn(),
}));

vi.mock('@codemirror/language', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@codemirror/language')>();
  actualSyntaxTree.current = actual.syntaxTree;
  return {
    ...actual,
    ensureSyntaxTree: ensureSyntaxTreeMock,
    syntaxTree: syntaxTreeMock,
  };
});

describe('LiveMarkdownPlugin', () => {
  beforeEach(() => {
    syntaxTreeMock.mockImplementation((state) => actualSyntaxTree.current!(state));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rebuilds decorations when the viewport changes', () => {
    const view = new EditorView({
      doc: '# visible',
      extensions: [markdown()],
      parent: document.body,
    });
    const plugin = new LiveMarkdownPlugin(view);
    const buildDecorations = vi.fn(() => Decoration.none);
    (
      plugin as unknown as {
        buildDecorations: (editorView: EditorView) => DecorationSet;
      }
    ).buildDecorations = buildDecorations;

    plugin.update({
      view,
      state: view.state,
      transactions: [],
      docChanged: false,
      viewportChanged: true,
      focusChanged: false,
      selectionSet: false,
    } as unknown as ViewUpdate);

    expect(buildDecorations).toHaveBeenCalledOnce();
    expect(buildDecorations).toHaveBeenCalledWith(view);

    plugin.destroy();
    view.destroy();
  });

  it('observes incremental tree growth after the parsed tree shrinks', () => {
    const view = new EditorView({
      doc: '# visible',
      extensions: [markdown()],
      parent: document.body,
    });
    const plugin = new LiveMarkdownPlugin(view);
    const buildDecorations = vi.fn(() => Decoration.none);
    const privatePlugin = plugin as unknown as {
      buildDecorations: (editorView: EditorView) => DecorationSet;
      lastTreeLength: number;
    };
    privatePlugin.buildDecorations = buildDecorations;
    privatePlugin.lastTreeLength = 100;
    const update = {
      view,
      state: view.state,
      transactions: [],
      docChanged: false,
      viewportChanged: false,
      focusChanged: false,
      selectionSet: false,
    } as unknown as ViewUpdate;

    syntaxTreeMock.mockReturnValueOnce({ length: 50 });
    plugin.update(update);
    expect(buildDecorations).not.toHaveBeenCalled();

    syntaxTreeMock.mockReturnValueOnce({ length: 75 });
    plugin.update(update);
    expect(buildDecorations).toHaveBeenCalledOnce();

    plugin.destroy();
    view.destroy();
  });

  it('limits eager and scheduled parsing to the viewport plus a 5,000 character margin', () => {
    vi.useFakeTimers();
    ensureSyntaxTreeMock.mockClear();
    const view = new EditorView({
      doc: `> ${'large block '.repeat(4_000)}`,
      extensions: [markdown()],
      parent: document.body,
    });
    Object.defineProperty(view, 'viewport', {
      configurable: true,
      value: { from: 0, to: 1_000 },
    });

    const plugin = new LiveMarkdownPlugin(view);
    const scheduledState = view.state;
    expect(ensureSyntaxTreeMock).toHaveBeenNthCalledWith(1, scheduledState, 6_000, 200);

    syntaxTreeMock.mockReturnValueOnce({ length: 0 });
    (
      plugin as unknown as {
        scheduleParseRefresh: (editorView: EditorView) => void;
      }
    ).scheduleParseRefresh(view);

    vi.advanceTimersByTime(16);
    expect(ensureSyntaxTreeMock).toHaveBeenNthCalledWith(2, scheduledState, 6_000, 200);

    ensureSyntaxTreeMock.mockClear();
    syntaxTreeMock.mockReturnValueOnce({ length: 6_000 });
    (
      plugin as unknown as {
        scheduleParseRefresh: (editorView: EditorView) => void;
      }
    ).scheduleParseRefresh(view);
    vi.advanceTimersByTime(16);
    expect(ensureSyntaxTreeMock).not.toHaveBeenCalled();

    plugin.destroy();
    view.destroy();
  });
});
