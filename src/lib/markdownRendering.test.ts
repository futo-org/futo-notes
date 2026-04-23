// @vitest-environment jsdom
/**
 * Regression test: markdown decorations must actually render.
 *
 * Root cause: pnpm can hoist a stale copy of @codemirror/language at the root
 * node_modules while sub-dependencies use the pnpm store copy. Two physical
 * copies of the same package means different class identities — Language
 * instanceof checks fail, the syntax tree parser never attaches, and
 * liveMarkdownTransform produces zero decorations. The editor shows raw
 * markdown text instead of rendered output.
 *
 * This test catches that failure by constructing an EditorView with the same
 * extensions used in MarkdownEditor.svelte — including liveMarkdownTransform —
 * and asserting that decoration CSS classes appear in the DOM.
 *
 * This test is fast (~100ms) and runs in jsdom, unlike the Playwright suite.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { EditorView, drawSelection, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree, Language } from '@codemirror/language';
import { liveMarkdownTransform } from './liveMarkdownTransform';

/**
 * Create an EditorView with the same extension stack as MarkdownEditor.svelte,
 * including liveMarkdownTransform. Returns the view and its container.
 */
function createEditorWithRendering(doc: string): { view: EditorView; container: HTMLDivElement } {
  const extensions = [
    drawSelection(),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    markdown({ base: markdownLanguage }),
    liveMarkdownTransform,
    EditorView.lineWrapping,
    EditorView.theme({
      '&': { height: 'auto', fontSize: '18px' },
      '.cm-content': { padding: '0' },
    }),
  ];

  const container = document.createElement('div');
  document.body.appendChild(container);

  const view = new EditorView({
    state: EditorState.create({ doc, extensions }),
    parent: container,
  });

  // Blur to ensure decorations are not suppressed by cursor-line logic
  view.contentDOM.blur();
  view.dom.blur();

  return { view, container };
}

describe('Markdown rendering (liveMarkdownTransform decorations)', () => {
  let view: EditorView;
  let container: HTMLDivElement;

  afterEach(() => {
    view?.destroy();
    container?.remove();
  });

  it('markdown language parser attaches to EditorState (single-instance guard)', () => {
    // If @codemirror/language is duplicated (stale hoisted copy + pnpm store
    // copy), the Language instanceof check fails and the parser never attaches.
    // This makes syntaxTree() return an empty tree with length 0.
    const state = EditorState.create({
      doc: '# Heading\n\n**bold**',
      extensions: [markdown({ base: markdownLanguage })],
    });

    // Verify the LanguageSupport's language is recognized as a Language instance
    const mdSupport = markdown({ base: markdownLanguage });
    expect(
      mdSupport.language instanceof Language,
      '@codemirror/language is duplicated: markdownLanguage is not instanceof Language. ' +
      'Pin @codemirror/language in package.json to force a single copy.',
    ).toBe(true);

    // Verify the parser actually produces a syntax tree
    const tree = ensureSyntaxTree(state, state.doc.length, 5000);
    expect(tree, 'ensureSyntaxTree returned null — parser did not attach').not.toBeNull();
    expect(tree!.length).toBe(state.doc.length);

    // Verify specific markdown nodes are parsed
    let hasHeading = false;
    let hasEmphasis = false;
    tree!.iterate({
      enter: (node) => {
        if (/ATXHeading/.test(node.name)) hasHeading = true;
        if (node.name === 'StrongEmphasis') hasEmphasis = true;
      },
    });
    expect(hasHeading, 'Syntax tree has no ATXHeading node').toBe(true);
    expect(hasEmphasis, 'Syntax tree has no StrongEmphasis node').toBe(true);
  });

  it('renders heading decorations', () => {
    ({ view, container } = createEditorWithRendering('# Heading 1\n\nSome body text.'));

    const h1 = container.querySelector('.cm-md-h1');
    expect(h1, 'Expected .cm-md-h1 decoration for "# Heading 1"').toBeTruthy();
    expect(h1!.textContent).toContain('Heading 1');
    expect(h1!.textContent, 'Expected `#` marker to be replaced out of DOM').not.toContain('#');
  });

  it('renders bold decorations', () => {
    ({ view, container } = createEditorWithRendering('This is **bold** text.\n\nMore.'));

    const strong = container.querySelector('.cm-md-strong');
    expect(strong, 'Expected .cm-md-strong decoration for "**bold**"').toBeTruthy();
    expect(strong!.textContent).toBe('bold');
  });

  it('renders italic decorations', () => {
    ({ view, container } = createEditorWithRendering('This is *italic* text.\n\nMore.'));

    const em = container.querySelector('.cm-md-emphasis');
    expect(em, 'Expected .cm-md-emphasis decoration for "*italic*"').toBeTruthy();
    expect(em!.textContent).toBe('italic');
  });

  it('renders inline code decorations', () => {
    ({ view, container } = createEditorWithRendering('Use `code` here.\n\nMore.'));

    const code = container.querySelector('.cm-md-code');
    expect(code, 'Expected .cm-md-code decoration for "`code`"').toBeTruthy();
  });

  it('renders multiple markdown elements together', () => {
    const doc = [
      '# Title',
      '',
      'Paragraph with **bold** and *italic* words.',
      '',
      '## Subtitle',
      '',
      'Some `code` inline.',
    ].join('\n');

    ({ view, container } = createEditorWithRendering(doc));

    expect(container.querySelector('.cm-md-h1'), 'h1 decoration missing').toBeTruthy();
    expect(container.querySelector('.cm-md-h2'), 'h2 decoration missing').toBeTruthy();
    expect(container.querySelector('.cm-md-strong'), 'bold decoration missing').toBeTruthy();
    expect(container.querySelector('.cm-md-emphasis'), 'italic decoration missing').toBeTruthy();
    expect(container.querySelector('.cm-md-code'), 'code decoration missing').toBeTruthy();
  });

  it('renders decorations after content is replaced via transaction', () => {
    // Start with plain text — no markdown
    ({ view, container } = createEditorWithRendering('Just plain text.'));
    expect(container.querySelector('.cm-md-h1')).toBeNull();

    // Replace with markdown content (simulates note switch)
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: '# New Heading\n\nWith **bold**.' },
    });

    const h1 = container.querySelector('.cm-md-h1');
    expect(h1, 'h1 decoration missing after content replacement').toBeTruthy();

    const strong = container.querySelector('.cm-md-strong');
    expect(strong, 'bold decoration missing after content replacement').toBeTruthy();
  });
});
