import { expect, type Page, test } from '@playwright/test';

import { EDITOR, editorMarkdown, openNewNote } from './lib/desktopEditor';

/*
 * Opening a note whose one paragraph holds tens of thousands of inline nodes
 * froze the desktop app on WebKit for 5-25 s per open headless and 30-80 s in
 * the app (RC-14, L6f-3), while Chromium and the native embed opened the same
 * note in about a second.
 *
 * The cost was the browser's, not the editor's JavaScript. A live DOM Range
 * whose boundary sits on an element is updated on every change to that
 * element's children, and WebKit re-indexes the boundary to do it — O(children)
 * per change. Its writing-suggestions pass likewise walks to the caret's child
 * index for every element it builds. Two such boundaries sat in the very
 * paragraph an open rewrites: the focused editable's caret, and the Range
 * prosemirror-view reuses for every measurement (the desktop's block handle
 * measures the caret on each selection change). Rewriting n children under
 * them cost O(n²).
 *
 * Chromium does not pay for this, and CI runs Chromium, so the test asserts
 * the CONDITION rather than a time (M15): when an open starts rewriting the
 * editor's DOM, neither the DOM selection nor any live Range has a boundary
 * inside it. The check runs once, at the open's first write — reading the
 * selection on every write would force a layout per write in Blink. It is
 * load-independent, and the unfixed editor fails it on every open.
 */

/** 28,000 inline nodes in one paragraph: emphasis and strong, no blank line. */
function denseParagraph(tag: string): string {
  return `${tag} a *b* _c_ **d** `.repeat(4000) + '\n';
}

/** One paragraph of 10,000 soft-broken lines. */
function softBrokenParagraph(tag: string): string {
  return [tag, ...Array.from({ length: 10_000 }, (_, i) => `lorem ipsum dolor sit amet ${i}`)].join(
    '\n',
  );
}

interface OpenProbe {
  armed: boolean;
  /** Child-list changes inside the editor while the probe was armed. */
  writes: number;
  /** Selection ends and live Range boundaries inside the editor at the first write. */
  boundariesAtFirstWrite: number;
}

type ProbeWindow = typeof window & {
  __openProbe: OpenProbe;
  __notesShellTest: { seedOpenNote: (id: string, body: string) => void };
};

/** Installed before any page script, so it sees every Range the editor makes. */
function installOpenProbe(): void {
  const probe: OpenProbe = { armed: false, writes: 0, boundariesAtFirstWrite: 0 };
  (window as ProbeWindow).__openProbe = probe;
  const ranges: WeakRef<Range>[] = [];
  const createRange = Document.prototype.createRange;
  Document.prototype.createRange = function (this: Document) {
    const range = createRange.call(this);
    ranges.push(new WeakRef(range));
    return range;
  };
  const boundariesInside = (root: Element): number => {
    const selection = document.getSelection();
    const ends: (Node | null | undefined)[] = selection?.rangeCount
      ? [selection.anchorNode, selection.focusNode]
      : [];
    for (const ref of ranges) {
      const range = ref.deref();
      if (range) ends.push(range.startContainer, range.endContainer);
    }
    return ends.filter((node) => !!node && root.contains(node)).length;
  };
  const record = (parent: Node): void => {
    if (!probe.armed) return;
    const root = document.querySelector('.ProseMirror');
    if (!root?.contains(parent)) return;
    probe.writes += 1;
    if (probe.writes === 1) probe.boundariesAtFirstWrite = boundariesInside(root);
  };
  for (const name of ['insertBefore', 'appendChild', 'removeChild', 'replaceChild'] as const) {
    const original = Node.prototype[name] as (...args: unknown[]) => unknown;
    Object.defineProperty(Node.prototype, name, {
      configurable: true,
      writable: true,
      value: function (this: Node, ...args: unknown[]) {
        record(this);
        return original.apply(this, args);
      },
    });
  }
}

/** Opens `body` the way the shell does (focus returns to the editor) and reads the probe. */
async function openWhileProbed(page: Page, id: string, body: string): Promise<OpenProbe> {
  return page.evaluate(
    ({ id, body }) => {
      const w = window as ProbeWindow;
      Object.assign(w.__openProbe, { armed: true, writes: 0, boundariesAtFirstWrite: 0 });
      w.__notesShellTest.seedOpenNote(id, body);
      w.__openProbe.armed = false;
      return { ...w.__openProbe };
    },
    { id, body },
  );
}

/** A caret inside the paragraph's text, which also has the block handle measure it. */
async function placeCaretInText(page: Page): Promise<void> {
  await page.locator(EDITOR).click({ position: { x: 120, y: 30 } });
  await page.keyboard.press('ArrowRight');
}

test('opening a large paragraph never rewrites DOM under a live selection or Range', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(installOpenProbe);
  await openNewNote(page);
  await page.locator(EDITOR).click();

  const opens: [string, string][] = [
    ['dense-1', denseParagraph('first')],
    ['soft', softBrokenParagraph('soft')],
    ['dense-2', denseParagraph('second')],
  ];
  for (const [index, [id, body]] of opens.entries()) {
    if (index > 0) await placeCaretInText(page);
    const probe = await openWhileProbed(page, id, body);
    // The probe saw the open's DOM work, so a zero below is a measurement.
    expect(probe.writes, `${id}: child-list changes observed`).toBeGreaterThan(1_000);
    expect(probe.boundariesAtFirstWrite, `${id}: live boundaries in the editor`).toBe(0);
    await expect.poll(() => editorMarkdown(page)).toContain(body.slice(0, 40));
  }

  // The caret the load let go of is back, in the editor: typing still lands.
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.matches('.ProseMirror')))
    .toBe(true);
  await page.keyboard.type('Z');
  await expect.poll(() => editorMarkdown(page)).toContain('Z');
  expect(pageErrors).toEqual([]);
});
