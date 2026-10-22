// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasFileSystem: true,
  onFileDrop: () => () => {},
}));

import { layOutLines, mountEditor } from './puppetEditor.fixture';
import { runPuppetCommand } from './puppetInspector';
import './puppetInspector.fixture';
import { docVersionOf } from './puppetText';
import { registerPuppetShell } from './puppetRegistry';
import { diffSnapshots, takeSnapshot } from './puppetSnapshots';

const NOTE = `# Groceries

- [ ] milk
- [x] eggs
  - nested bullet

Call **Sam** about the *lease* and [site](https://example.com).
See [[Lease plan]] and #tag here.
Line one\\
line two

| a | b |
| --- | --- |
| 1 | 2 |

---
`;

describe('doc, and text as a person sees it', () => {
  it('doc prints each line with its positions, kind and text, and its markdown where it differs', async () => {
    const { view } = await mountEditor(NOTE);
    const body = runPuppetCommand('doc', {}).body as {
      docVersion: number;
      lines: Array<Record<string, unknown>>;
    };
    expect(body.docVersion).toBe(docVersionOf(view.state.doc));
    expect(body.lines.map(({ line: _line, at: _at, end: _end, ...rest }) => rest)).toEqual([
      { kind: 'heading 1', text: 'Groceries' },
      { kind: 'task ☐', text: 'milk' },
      { kind: 'task ☑', text: 'eggs' },
      { kind: 'bullet', indent: 1, text: 'nested bullet' },
      // Every line break in a paragraph starts a line, as on screen: a single newline in the
      // markdown (what Enter types) and a `\` alike.
      {
        kind: 'paragraph',
        text: 'Call Sam about the lease and site.',
        md: 'Call **Sam** about the *lease* and [site](https://example.com).',
      },
      // No note is called Lease plan, so its chip is drawn broken.
      {
        kind: 'paragraph',
        text: 'See [[Lease plan]]!broken and #tag here.',
        md: 'See [[Lease plan]] and #tag here.',
      },
      { kind: 'paragraph', text: 'Line one' },
      { kind: 'paragraph', text: 'line two' },
      { kind: 'header r1c1', text: 'a' },
      { kind: 'header r1c2', text: 'b' },
      { kind: 'cell r2c1', text: '1' },
      { kind: 'cell r2c2', text: '2' },
      { kind: 'divider', text: '' },
      // The open line the editor keeps after a last block that is not a paragraph.
      { kind: 'paragraph', text: '' },
    ]);
    expect(body.lines[0]).toMatchObject({ line: 1, at: 1, end: 10 });
  });

  it('doc of one line gives each run its position and formatting, each chip, and the tags', async () => {
    await mountEditor(NOTE);
    const lineOf = (line: number) =>
      runPuppetCommand('doc', { line }).body as {
        runs: Array<Record<string, unknown>>;
        tags: unknown[];
      };
    expect(lineOf(5).runs.slice(0, 4)).toEqual([
      { at: 49, text: 'Call ' },
      { at: 54, text: 'Sam', marks: ['bold'] },
      { at: 57, text: ' about the ' },
      { at: 68, text: 'lease', marks: ['italic'] },
    ]);
    expect(lineOf(5).runs).toContainEqual(
      expect.objectContaining({ text: 'site', marks: ['link https://example.com'] }),
    );
    const line = lineOf(6);
    expect(line.runs).toContainEqual(
      // No note is called that, so the editor draws the chip broken, and says so.
      expect.objectContaining({
        node: 'wikilink',
        text: '[[Lease plan]]!broken',
        target: 'Lease plan',
        broken: true,
      }),
    );
    expect(line.tags).toEqual([expect.objectContaining({ tag: '#tag' })]);
  });

  it('show {"text"} is where text on screen is: positions, line, col and box, a chip one position', async () => {
    const { view } = await mountEditor('a b c\n');
    expect(runPuppetCommand('show', { text: 'b' }).body).toMatchObject({
      from: 3,
      to: 4,
      line: 1,
      col: 3,
    });
    const coordsAtPos = view.coordsAtPos;
    view.coordsAtPos = (pos: number, side?: number) =>
      pos === 3
        ? { left: 10, right: 10, top: 5, bottom: 20 }
        : pos === 4
          ? { left: 18, right: 18, top: 5, bottom: 20 }
          : coordsAtPos(pos, side);
    expect((runPuppetCommand('show', { text: 'b' }).body as { rect: unknown }).rect).toEqual({
      x: 10,
      y: 5,
      w: 8,
      h: 15,
    });

    await mountEditor('See [[Lease plan]] now\n');
    expect(runPuppetCommand('show', { text: 'Lease plan' }).body).toMatchObject({ from: 5, to: 6 });
  });
});

describe('elements', () => {
  function button(label: string, handler?: () => void): HTMLButtonElement {
    const element = document.createElement('button');
    element.textContent = label;
    if (handler) {
      // How Svelte 5 stores a delegated handler on its element.
      (element as unknown as Record<symbol, unknown>)[Symbol('events')] = { click: handler };
    }
    // jsdom lays nothing out; give the element a rect so it counts as visible.
    element.getBoundingClientRect = () => new DOMRect(10, 20, 100, 30);
    document.body.appendChild(element);
    return element;
  }

  it('lists interactables with stable refs, roles, handlers and rects', () => {
    function selectTab() {}
    button('Notes', selectTab);
    const svelteRoot = document.createElement('div');
    (svelteRoot as unknown as { __svelte_meta: unknown }).__svelte_meta = {
      loc: { file: 'src/features/tabs/TabsStrip.svelte', line: 1, column: 1 },
    };
    document.body.appendChild(svelteRoot);
    const plus = button('+');
    svelteRoot.appendChild(plus);

    const first = runPuppetCommand('elements', {}).body as {
      elements: Array<Record<string, unknown>>;
    };
    expect(first.elements).toMatchObject([
      {
        ref: 'e1',
        component: null,
        role: 'button',
        text: 'Notes',
        handlers: ['click=selectTab'],
        flags: [],
        rect: { x: 10, y: 20, w: 100, h: 30 },
      },
      {
        ref: 'e2',
        component: 'TabsStrip.svelte',
        role: 'button',
        text: '+',
        handlers: [],
        flags: [],
        rect: { x: 10, y: 20, w: 100, h: 30 },
      },
    ]);
    const again = runPuppetCommand('elements', {}).body as { elements: Array<{ ref: string }> };
    expect(again.elements.map((row) => row.ref)).toEqual(['e1', 'e2']);
  });

  it('hides zero-size elements unless asked for all, and scopes to a ref', () => {
    const hidden = document.createElement('button');
    hidden.textContent = 'ghost';
    document.body.appendChild(hidden);
    const holder = document.createElement('section');
    holder.getBoundingClientRect = () => new DOMRect(0, 0, 500, 500);
    document.body.appendChild(holder);
    holder.appendChild(button('inside'));
    holder.setAttribute('role', 'tab');

    const visible = runPuppetCommand('elements', {}).body as { elements: Array<{ text: string }> };
    expect(visible.elements.map((row) => row.text)).toEqual(['inside', 'inside']);
    const all = runPuppetCommand('elements', { all: true }).body as {
      elements: Array<{ text: string; flags: string[] }>;
    };
    expect(all.elements.find((row) => row.text === 'ghost')?.flags).toContain('hidden');
    const holderRef = (
      runPuppetCommand('elements', {}).body as { elements: Array<{ ref: string; role: string }> }
    ).elements.find((row) => row.role === 'tab')!.ref;
    const scoped = runPuppetCommand('elements', { in: holderRef }).body as {
      elements: Array<{ text: string }>;
    };
    expect(scoped.elements.map((row) => row.text)).toEqual(['inside', 'inside']);
  });

  it('observe carries the vault, so a driver sees notes a collapsed folder hides', () => {
    const vault = { notes: ['welcome', 'work/standup'], folders: ['work'] };
    registerPuppetShell({ screen: () => 'home', state: () => ({ tabs: [] }), vault: () => vault });
    const observation = runPuppetCommand('observe', {}).body as {
      notes: string[];
      folders: string[];
      tabs: unknown[];
    };
    expect(observation.notes).toEqual(vault.notes);
    expect(observation.folders).toEqual(vault.folders);
    expect(observation.tabs).toEqual([]);
  });

  it('offers no editor verbs on a screen that is not the editor, mounted or not', async () => {
    // The editor stays mounted behind the home screen, so a live view is not a visible one.
    await mountEditor();
    registerPuppetShell({ screen: () => 'home', state: () => ({}) });
    const home = (runPuppetCommand('actions', {}).body as { actions: Array<{ name: string }> })
      .actions;
    expect(home.map((verb) => verb.name)).not.toContain('Bold');
    expect(runPuppetCommand('do', { verb: 'Bold' }).status).toBe(404);

    registerPuppetShell({ screen: () => 'editor:welcome', state: () => ({}) });
    const open = (runPuppetCommand('actions', {}).body as { actions: Array<{ name: string }> })
      .actions;
    expect(open.map((verb) => verb.name)).toContain('Bold');
  });

  it('observe carries the document on a shell-less embed, which the phones mount', async () => {
    // No registerPuppetShell: the phones' editor page is nothing but an editor, and its
    // screen is the bare "editor". Its lines must still be there to write against.
    await mountEditor('one\n\ntwo\n');
    const observation = runPuppetCommand('observe', {}).body as {
      screen: string;
      lines: Array<{ line: number; text: string }>;
    };
    expect(observation.screen).toBe('editor');
    expect(observation.lines.map((line) => line.text)).toEqual(['one', 'two']);
  });

  it('show describes one ref and 404s a ref that is gone', () => {
    const element = button('Bold');
    const ref = (runPuppetCommand('elements', {}).body as { elements: Array<{ ref: string }> })
      .elements[0]!.ref;
    const shown = runPuppetCommand('show', { ref }).body as Record<string, unknown>;
    expect(shown).toMatchObject({
      ref,
      tag: 'button',
      text: 'Bold',
      hitVersusPaint: { matches: true, misses: [] },
    });
    element.remove();
    expect(runPuppetCommand('show', { ref }).status).toBe(404);
  });
});

// Last: its `elements` read numbers the editor's elements, and the refs tests above count from e1.
describe('a note larger than the screen', () => {
  it('reads the note only where it is on screen, and says the rest only as state', async () => {
    // Line 30 of 40 holds the marker; the screen shows lines 1-10.
    const text = Array.from({ length: 40 }, (_, i) => (i === 29 ? 'MARKER here' : `line ${i + 1}`));
    const { view } = await mountEditor(`${text.join('\n\n')}\n`);
    layOutLines(view, { rows: 10 });
    const read = (command: string, args = {}) =>
      JSON.stringify(runPuppetCommand(command, args).body);
    for (const command of ['doc', 'state', 'elements', 'observe']) {
      expect(read(command)).not.toContain('MARKER');
    }
    expect(runPuppetCommand('doc', {}).body).toMatchObject({
      onScreen: { first: 1, last: 10 },
      more: { above: false, below: true },
    });
    expect(runPuppetCommand('state', {}).body).toMatchObject({
      editor: { note: 'fixture', onScreen: { first: 1, last: 10 }, loading: false },
    });
    expect(runPuppetCommand('doc', { line: 30 })).toMatchObject({
      status: 409,
      body: { reach: [['ScrollToLine', { line: 30 }]] },
    });

    // An edit off screen is only where it is.
    const before = takeSnapshot();
    const marker = view.state.doc.textContent.indexOf('MARKER');
    let at = 0;
    view.state.doc.descendants((node, pos) => {
      if (node.isText && node.text?.startsWith('MARKER')) at = pos;
    });
    expect(marker).toBeGreaterThan(-1);
    view.dispatch(view.state.tr.insertText('X', at));
    expect(diffSnapshots(before, takeSnapshot()).doc).toEqual({
      line: 30,
      to: 30,
      offScreen: true,
    });

    // Scrolled to it, the line reads as any other.
    layOutLines(view, { first: 25, rows: 10 });
    expect(read('doc')).toContain('XMARKER here');
  });
});
