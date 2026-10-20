// Part of the futoBridge Milkdown suite: scope and input rules are in
// editor-embed-milkdown.spec.ts.

import { expect, type Page } from '@playwright/test';
import { EDITOR_URL } from './editorEmbedBundle';
import { getContent, messagesOfType, type FakeHostWindow } from './lib/editorEmbedHost';
import { test, hostConfig, initialize } from './lib/editorEmbedMilkdown';
import { largeNote, waitForStreamComplete } from './lib/editorEmbedMilkdownStream';

// ------------------------------------------------------------
// Progressive open agrees with the whole-document parse (RC-38, RC-39, RC-40)
// ------------------------------------------------------------
//
// The planner is a line scanner standing in for micromark, and the release-
// hardening fuzz (lens B) found it cutting INSIDE a code or HTML block, or
// chunking a note whose definitions resolve document-wide, in a dozen shapes.
// The fix is to DECLINE whatever it cannot prove top-level and block-bounded
// (markdownChunks.ts, "THE RULE"), so these notes now load whole. The oracle
// does not care which path a note takes: the first edit after opening must
// write exactly the bytes a whole-document parse writes, with the keystroke
// applied. Each case fails against the scanner it replaces.

/** 84 lines of one plain paragraph: no blank line, no hard starter, no boundary. */
const CHUNK_INTRO = [
  'Intro paragraph.',
  ...Array.from({ length: 84 }, (_, i) => `plain line ${i}`),
].join('\n');
/** A tail long enough to push the note past the 400-line threshold. */
const CHUNK_TAIL = Array.from({ length: 330 }, (_, i) => `tail line ${i}`).join('\n');
const CHUNK_INTRO_REST = CHUNK_INTRO.split('\n').slice(1).join('\n');

const CHUNK_AGREEMENT_CASES: Array<{ name: string; note: string }> = [
  {
    // A fence indented 1 space and closed at column 0, then a second bare
    // fence: the scanner "closed" on the line micromark OPENS, and cut in
    // front of a `#` line that is inside a code block.
    name: 'a fence indented one space and closed at column 0',
    note: `${CHUNK_INTRO}\n\n \`\`\`\ncode A\n\`\`\`\ntext\n \`\`\`\n# not a heading\n\nmore code\n\`\`\`\n\n${CHUNK_TAIL}\n`,
  },
  {
    // A U+FEFF at the start of a line that became a chunk start: micromark
    // strips it and the line re-parsed as a heading.
    name: 'a U+FEFF in the middle of the note, at the start of a line',
    note: `${CHUNK_INTRO}\n\n\ufeff# not a heading\n\n${CHUNK_TAIL}\n`,
  },
  {
    // A lone CR ends `para` for micromark, so the fence after it opens a code
    // block the (\n-only) scanner never saw.
    name: 'a lone CR hiding a fence opener',
    note: `${CHUNK_INTRO}\r\`\`\`\n\n# in code\n\n\`\`\`\n\n${CHUNK_TAIL}\n`,
  },
  {
    name: 'a link reference definition inside a list item',
    note: `Intro [site][a].\n${CHUNK_INTRO_REST}\n\n- [a]: https://example.com/x\n\n${CHUNK_TAIL}\n`,
  },
  {
    name: 'a link reference definition inside a blockquote',
    note: `Intro [site][a].\n${CHUNK_INTRO_REST}\n\n> [a]: https://example.com/x\n\n${CHUNK_TAIL}\n`,
  },
  {
    name: 'a footnote definition inside a list item',
    note: `Intro text[^n].\n${CHUNK_INTRO_REST}\n\n- [^n]: note body\n\n${CHUNK_TAIL}\n`,
  },
  {
    // U+00A0 is not blank to CommonMark (space and tab are), so the NBSP line
    // is a paragraph line and `2. x` continues it. `String#trim` called it blank.
    name: 'a NBSP-only line, which CommonMark does not call blank',
    note: `${CHUNK_INTRO}\n\n\u00a0\n2. not a list item\n\n${CHUNK_TAIL}\n`,
  },
  {
    // micromark strips the BOM, so the whole parse sees front matter; the
    // scanner tested line 0 with the BOM on and cut inside the YAML.
    name: 'a BOM before a long front matter block with blank lines in it',
    note: `\ufeff---\n${Array.from({ length: 90 }, (_, i) => (i % 10 === 9 ? '' : `key${i}: v`)).join('\n')}\n---\n\n${CHUNK_INTRO}\n\n${CHUNK_TAIL}\n`,
  },
  {
    // A fence line directly under an HTML block is HTML to micromark, but
    // opened a fence for the scanner.
    name: 'a fence line directly under an HTML block',
    note: `Intro para.\n\n<div>\n\`\`\`\n\ntext\n\n\`\`\`\`\n# in code\n${Array.from({ length: 85 }, (_, i) => `code line ${i}`).join('\n')}\n\nmore code\n\`\`\`\`\n\n${CHUNK_TAIL}\n`,
  },
  {
    // `<!DOCTYPE x` directly under a type-6 line is part of THAT block; the
    // scanner opened a type-4 block that survived the blank line and closed on
    // the `>` of `<pre>`, so a blank-line cut landed inside the real <pre>.
    name: 'an HTML declaration line under an HTML block, hiding a <pre> block',
    note: `Intro para.\n\n<div>\n<!DOCTYPE x\n\n<pre>\n${Array.from({ length: 85 }, (_, i) => `pre line ${i}`).join('\n')}\n\n# not a heading\n* not a list\n</pre>\n\n${CHUNK_TAIL}\n`,
  },
  {
    // HTML opened INSIDE a container (unit-tested in markdownChunks.test.ts;
    // the embed suite had none). An unclosed comment in a list item runs through
    // every blank line up to the end of the ITEM, so a blank-line cut inside it
    // turns the comment's body into live markdown.
    name: 'an HTML comment opened in a list item and never closed there',
    note: `Intro para.\n\n- <!--\n${Array.from({ length: 85 }, (_, i) => `  comment line ${i}`).join('\n')}\n\n  # not a heading\n\n- second item\n\n${CHUNK_TAIL}\n`,
  },
  {
    name: 'a <pre> opened in a blockquote',
    note: `Intro para.\n\n> <pre>\n${Array.from({ length: 85 }, (_, i) => `> pre line ${i}`).join('\n')}\n>\n> # h\n> </pre>\n\n${CHUNK_TAIL}\n`,
  },
  {
    name: 'a <script> opened in an ordered list item',
    note: `Intro para.\n\n1. <script>\n${Array.from({ length: 85 }, (_, i) => `   var x${i};`).join('\n')}\n\n   # h\n   </script>\n\n${CHUNK_TAIL}\n`,
  },
  {
    // A ``` line inside the note's own YAML opened a phantom fence in the
    // scanner, which swallowed the real structure after it.
    name: 'a fence-looking line inside the front matter',
    note: `---\n\`\`\`\n---\n\nIntro [x].\n${CHUNK_INTRO_REST}\n\n[x]: /u\n\n\`\`\`\n\n${CHUNK_TAIL}\n`,
  },
  {
    name: 'a reference definition with an escaped bracket in its label',
    note: `Intro [si\\]te].\n${CHUNK_INTRO_REST}\n\n[si\\]te]: https://example.com/x\nmore text\n\n${CHUNK_TAIL}\n`,
  },
  {
    name: 'a reference definition whose label spans two lines',
    note: `Intro [my site].\n${CHUNK_INTRO_REST}\n\n[my\nsite]: https://example.com/x\nmore text\n\n${CHUNK_TAIL}\n`,
  },
  {
    // The unclosed fence on a list marker line: the chunk alone ran the fence to
    // ITS end, so blank lines that belong to the list item landed in the code.
    name: 'an unclosed fence opened on a list item line',
    note: `Intro paragraph.\n\n- ~~~\n${Array.from({ length: 85 }, (_, i) => `  code ${i}`).join('\n')}\n\n\n\n${CHUNK_TAIL}\n`,
  },
];

/** The whole-document parse's serialization, from the same bundle's `?census` door. */
async function wholeDocumentSerialization(page: Page, note: string): Promise<string> {
  const census = await page.context().newPage();
  await census.goto(`${EDITOR_URL}&census`);
  await census.waitForFunction(
    () =>
      typeof (window as unknown as { __futoSerializeCensus?: unknown }).__futoSerializeCensus ===
        'function' &&
      (window as unknown as { __futoEditorMounted?: boolean }).__futoEditorMounted === true,
  );
  const whole = await census.evaluate(
    (md) =>
      (
        window as unknown as { __futoSerializeCensus: (m: string) => { whole: string } }
      ).__futoSerializeCensus(md).whole,
    note,
  );
  await census.close();
  return whole;
}

/** Selection-only placement in front of the first text occurrence of `marker`. */
async function placeCaretBeforeText(page: Page, marker: string): Promise<void> {
  await page.evaluate((m) => {
    const w = window as unknown as FakeHostWindow & {
      __futoProseMirrorView: () => {
        state: {
          doc: {
            descendants(
              cb: (node: { isText: boolean; text?: string }, pos: number) => boolean | void,
            ): void;
          };
          selection: { constructor: { create(doc: unknown, pos: number): unknown } };
          tr: { setSelection(selection: unknown): unknown };
        };
        dispatch(tr: unknown): void;
      };
    };
    w.FutoEditor.focus();
    const view = w.__futoProseMirrorView();
    let at = -1;
    view.state.doc.descendants((node, pos) => {
      if (at >= 0) return false;
      if (node.isText && node.text?.includes(m)) at = pos + node.text.indexOf(m);
      return true;
    });
    if (at < 0) throw new Error(`marker ${m} not in the document`);
    const Selection = view.state.selection.constructor;
    view.dispatch(view.state.tr.setSelection(Selection.create(view.state.doc, at)));
    w.__msgs.length = 0;
  }, marker);
}

/** Types one real key in front of `marker` and returns the bytes the host is told to save. */
async function typeInFrontOfAndReadChange(page: Page, marker: string): Promise<string> {
  await placeCaretBeforeText(page, marker);
  await page.keyboard.type('Z');
  await page.waitForFunction(
    () => (window as unknown as FakeHostWindow).__msgs.some((m) => m.type === 'change'),
    null,
    { timeout: 10_000 },
  );
  const changes = await messagesOfType(page, 'change');
  return String(changes[changes.length - 1].content);
}

for (const { name, note } of CHUNK_AGREEMENT_CASES) {
  test(`the first edit after opening a note with ${name} writes the whole-parse bytes`, async ({
    page,
  }) => {
    const expected = (await wholeDocumentSerialization(page, note)).replace('Intro', 'ZIntro');
    expect(expected).toContain('ZIntro');

    await initialize(page, hostConfig({ content: note }));
    // The stream, if the planner chose one, must finish before the edit.
    await page.waitForSelector('.milkdown-stream-tail', { state: 'detached', timeout: 30_000 });
    // Load echo: an untouched open hands back the host's bytes.
    expect(await getContent(page)).toBe(note);

    const written = await typeInFrontOfAndReadChange(page, 'Intro');
    expect(written.length, 'sanity: the whole note was written').toBeGreaterThan(1000);
    // The BOM is dropped by the first edit (RC-38, Q18 18A); nothing else may differ.
    expect(written).toBe(expected.replace(/^\ufeff/, ''));
  });
}

// RC-38: micromark strips a leading U+FEFF, so every node position is one code
// unit short of `file.value`, and Milkdown's remarkMarker reads
// `file.value.charAt(offset)` — the character BEFORE each `*`/`_` run — as the
// strong/emphasis marker. The first edit re-spelled every emphasis in the note.
// This is the ordinary whole-document open, not the progressive one. The edit
// writes the house style, whose italic is `*` (docs/spec/editor.md "Markdown
// house style"): every mark kept, and spelled the way any note's would be.
for (const where of ['in another block', 'in the same block'] as const) {
  test(`a BOM-leading note keeps its bold and italic markers on the first edit (${where})`, async ({
    page,
  }) => {
    const body =
      where === 'in another block'
        ? 'Intro para\n\nsome **bold** and _it_ word\n\nx**y**z\n'
        : 'Intro para with **bold** and _it_ and x**y**z\n';
    const note = `\ufeff${body}`;

    await initialize(page, hostConfig({ content: note }));
    // Load echo: the host's bytes, BOM included, until the user edits.
    expect(await getContent(page)).toBe(note);
    expect(
      await page.evaluate(() => ({
        strong: document.querySelectorAll('.ProseMirror strong').length,
        em: document.querySelectorAll('.ProseMirror em').length,
      })),
    ).toEqual({ strong: 2, em: 1 });

    const written = await typeInFrontOfAndReadChange(page, 'Intro');
    expect(written).toBe(body.replace('Intro', 'ZIntro').replace('_it_', '*it*'));
  });
}

test('a note with a DOUBLED leading BOM keeps its emphasis and echoes the host bytes', async ({
  page,
}) => {
  const body = 'Intro **b** and _it_ x**y**z\n';
  const note = `\ufeff\ufeff${body}`;
  await initialize(page, hostConfig({ content: note }));
  expect(await getContent(page)).toBe(note);
  expect(await messagesOfType(page, 'change')).toHaveLength(0);

  const written = await typeInFrontOfAndReadChange(page, 'Intro');
  // The house style's italic is `*`.
  expect(written).toBe(body.replace('Intro', 'ZIntro').replace('_it_', '*it*'));
});

test('a BOM-leading note that IS large still opens progressively and keeps its emphasis', async ({
  page,
}) => {
  // The BOM is stripped once, before the planner and the parser (Q18 18A), so a
  // BOM note is not a reason to lose progressive open.
  const body = `Intro **bold** para\n\n${largeNote()}`;
  await initialize(page, hostConfig({ content: `\ufeff${body}` }));
  await waitForStreamComplete(page);

  const written = await typeInFrontOfAndReadChange(page, 'Intro');
  expect(written).toBe(body.replace('Intro', 'ZIntro'));
});
