/**
 * Round-trip safety of the Milkdown compat plugins and the editor's own
 * serializer — executable.
 *
 * Every case runs against a real Milkdown editor built from the app's plugin
 * chain: on `baseline` (the unpatched upstream preset, read and written by
 * remark) and on `compat` (what the app ships: `@futo-notes/editor/milkdown-
 * compat` reading, the owned serializer writing in the house style of
 * docs/spec/editor.md "Markdown house style").
 *
 * The `baseline` half is the CANARY. It asserts the upstream bugs are still
 * present in `@milkdown/kit` 7.22.1. When upstream fixes one, its canary fails
 * — and that failure is the signal to delete the corresponding local fork
 * rather than carry it forever. Do not "fix" a red canary by relaxing it. The
 * canaries of the remark-stringify patches went with the patches when the
 * owned serializer replaced them (#266): what they guarded is now the
 * serializer's, held by its goldens (tests/conformance/markdown-house-style-*.json).
 *
 * The `compat` half is the contract: the two loss classes the census measured
 * are gone, and an empty paragraph round-trips as a blank line — never as the
 * `<br />` placeholder upstream's plugin exists for.
 */

import { expect, test, type Page } from '@playwright/test';
import { useCensusPage, roundTrip, twoSaves } from './lib/editorEmbedMilkdownCompat';

useCensusPage();

test.describe('inline <br> survives (upstream deletes it with no replacement)', () => {
  const SENTENCES = 'sentence one.<br>sentence two.\n';
  const TABLE = '| a | b |\n| --- | --- |\n| one.<br>two. | x |\n';
  const TABLE_IN_QUOTE = '> | a | b |\n> | --- | --- |\n> | one.<br>two. | x |\n';

  test('canary: upstream still fuses the words on either side', async ({ page }) => {
    expect(await roundTrip(page, 'baseline', SENTENCES)).toContain('sentence one.sentence two.');
    expect(await roundTrip(page, 'baseline', TABLE)).toContain('one.two.');
    expect(await roundTrip(page, 'baseline', TABLE_IN_QUOTE)).toContain('one.two.');
  });

  test('compat keeps the tag between two sentences', async ({ page }) => {
    expect(await roundTrip(page, 'compat', SENTENCES)).toBe(SENTENCES);
  });

  test('compat keeps the tag inside a table cell', async ({ page }) => {
    expect(await roundTrip(page, 'compat', TABLE)).toContain('one.<br>two.');
  });

  test('compat keeps the tag inside a table nested in a blockquote', async ({ page }) => {
    // The parked string-guard version could not see this container nesting and
    // left the note unstable across loads (census idx 25957).
    expect(await roundTrip(page, 'compat', TABLE_IN_QUOTE)).toContain('one.<br>two.');
  });

  test('compat keeps a tag on its own line inside a soft-wrapped paragraph', async ({ page }) => {
    expect(await roundTrip(page, 'compat', 'line a\n<br />\nline b\n')).toContain('<br />');
  });

  test('compat keeps the hard break before the tag, and adds no backslash', async ({ page }) => {
    // remark cannot write an eol directly before inline HTML, so a kept tag
    // left in second place strands the hard break's backslash mid-line:
    // "a  \n<br/>b" would come back as "a\\ <br/>b". Six census notes.
    const out = await roundTrip(page, 'compat', 'a  \n<br/>b\n');
    expect(out).toBe('a<br/>\\\nb\n');
    expect(await roundTrip(page, 'compat', out)).toBe(out);
  });
});

test.describe('an empty paragraph round-trips as a blank line, never as <br />', () => {
  // Upstream spells a non-final empty paragraph as a literal `<br />` on its
  // own line. The compat set retires that: N blank lines load as N-1 empty
  // paragraphs and save back as N blank lines (packages/editor/src/
  // milkdown-compat/emptyLine.ts). Each case is asserted twice — the first
  // save is allowed to re-spell (ADR-0002), the second must be a fixed point.
  // Fixed points of the house style (docs/spec/editor.md "Markdown house
  // style"): `-` bullets, `---` delimiter rows, one space either side of a cell.
  const STABLE: Record<string, string> = {
    'two blank lines between paragraphs': 'para one\n\n\npara two\n',
    'three blank lines between paragraphs': 'para one\n\n\n\npara two\n',
    'blank lines before the first block': '\n\npara\n',
    'two blank lines inside a blockquote': '> a\n>\n>\n> b\n',
    'two blank lines inside a list item': '- a\n\n\n  b\n- c\n',
    'an empty list item': '- a\n-\n- b\n',
    // The schema puts an empty paragraph in front of an item whose only content
    // is a block; that filler is not the note's and is not written. Written, it
    // would save as a bare `-` over an indented block, and the NEXT save would
    // escape it to a literal `\-` — 60 census notes before the fix.
    'a list item holding only a blockquote': '- > quote\n- b\n',
    'a list item holding only a heading': '- # heading\n',
    'a list item holding only a nested list': '- - nested\n  - deeper\n',
    // Two lists with a gap between them: the second list alternates its marker
    // as if adjacent, or CommonMark would read the pair back as ONE list.
    'two bullet lists with a blank line between them': '- a\n\n\n* b\n',
    'two ordered lists with a blank line between them': '1. a\n\n\n1) b\n',
    'an empty table cell': '| a | b |\n| --- | --- |\n|  | x |\n',
  };

  for (const [name, markdown] of Object.entries(STABLE)) {
    test(`compat keeps ${name} byte-for-byte`, async ({ page }) => {
      const once = await roundTrip(page, 'compat', markdown);
      expect(once).toBe(markdown);
      expect(await roundTrip(page, 'compat', once)).toBe(once);
    });
  }

  test('canary: upstream still round-trips its placeholder as <br />', async ({ page }) => {
    // Upstream cannot see blank lines at all (two of them load as one), so the
    // canary feeds it the tag it wrote itself: when this stops coming back as
    // `<br />`, upstream changed the placeholder scheme and this module's
    // legacy reader needs re-checking against it.
    const out = await roundTrip(page, 'baseline', 'para one\n\n<br />\n\npara two\n');
    expect(out).toContain('<br />');
    expect(await roundTrip(page, 'baseline', 'para one\n\n\npara two\n')).toBe(
      'para one\n\npara two\n',
    );
  });

  test('a blank line typed two Enters deep survives a reload as blank lines', async ({ page }) => {
    // The report that started this: "It's me!", Enter, Enter, "yes." saved as
    // a `<br />` line between the two. Same document, different spelling.
    const out = await roundTrip(page, 'compat', 'a\n\n\nb\n');
    expect(out).not.toContain('<br');
    expect(out).toBe('a\n\n\nb\n');
  });

  const LEGACY: Record<string, [string, string]> = {
    'a blank line between paragraphs': [
      'para one\n\n<br />\n\npara two\n',
      'para one\n\n\npara two\n',
    ],
    'an empty table cell': [
      '| a | b |\n| --- | --- |\n| <br /> | x |\n',
      '| a | b |\n| --- | --- |\n|  | x |\n',
    ],
    'an empty list item': ['- a\n- <br />\n- b\n', '- a\n-\n- b\n'],
    'an empty blockquote line': ['> <br />\n', '>\n'],
    'an empty footnote definition': ['ref[^4]\n\n[^4]: <br />\n', 'ref[^4]\n\n[^4]:\n'],
  };

  for (const [name, [legacy, respelled]] of Object.entries(LEGACY)) {
    test(`compat reads the placeholder an older build wrote for ${name}`, async ({ page }) => {
      const out = await roundTrip(page, 'compat', legacy);
      expect(out).not.toContain('<br');
      expect(out).toBe(respelled);
      expect(await roundTrip(page, 'compat', out)).toBe(out);
    });
  }
});

test.describe('the parked end-of-document paragraph is not written', () => {
  // @milkdown/plugin-trailing parks an empty paragraph after a last block that
  // is not a paragraph or heading, and remark-stringify wrote it as one more
  // blank line: the first edit of every such note ended the file in `\n\n`
  // (RC-22). The spec drops a trailing empty paragraph on save.
  const LAST_BLOCKS: Record<string, string> = {
    'a list': '- a\n- b\n',
    'a task list': '- [ ] a\n- [x] b\n',
    'a blockquote': '> quote\n',
    'a table': '| a | b |\n| --- | --- |\n| 1 | 2 |\n',
    'a fence': '```\ncode\n```\n',
    'a thematic break': 'a\n\n---\n',
  };
  for (const [name, markdown] of Object.entries(LAST_BLOCKS)) {
    test(`compat ends a note whose last block is ${name} in one newline`, async ({ page }) => {
      const { once, twice } = await twoSaves(page, 'compat', markdown);
      expect(once).toBe(markdown);
      expect(twice).toBe(once);
    });
  }

  test('compat still writes an empty paragraph that is not at the end', async ({ page }) => {
    const { once, twice } = await twoSaves(page, 'compat', '- a\n\n\npara\n');
    expect(once).toBe('- a\n\n\npara\n');
    expect(twice).toBe(once);
  });
});

test.describe('typed markdown converts only where the saved line would read the same', () => {
  // The presets' input rules (milkdown-compat/inputRules.ts) disagreed with the
  // parser that reads a note back: a fence language with a capital or a `+`
  // did not open a fence, seven `#` made a level-7 heading, and a delimiter run
  // padded with spaces, or escaped with a backslash, became formatting, and so
  // did an opener CommonMark's punctuation rule says cannot open.
  const typed = (page: Page, variant: 'compat' | 'baseline', keys: string) =>
    page.evaluate(([v, k]) => window.__futoCensus.typeText(v as 'compat' | 'baseline', k), [
      variant,
      keys,
    ] as const);

  const MARKS: [keys: string, mark: string][] = [
    ['2 * 3 *', 'mark:emphasis'],
    ['** not bold **', 'mark:strong'],
    ['~~ not struck ~~', 'mark:strike_through'],
    ['\\*not italic*', 'mark:emphasis'],
    ['\\**not bold**', 'mark:strong'],
    ['\\_not italic_', 'mark:emphasis'],
    ['\\`not code`', 'mark:inlineCode'],
    ['\\~not struck~', 'mark:strike_through'],
    ['*foo\\*', 'mark:emphasis'],
    ['**foo\\**', 'mark:strong'],
    ['_foo\\_', 'mark:emphasis'],
    ['~~foo\\~~', 'mark:strike_through'],
    ['a*"b"*', 'mark:emphasis'],
    ['a~~"b"~~', 'mark:strike_through'],
    ['café_b_', 'mark:emphasis'],
  ];

  test('canary: upstream still formats padded, escaped and unflanked delimiter runs', async ({
    page,
  }) => {
    for (const [keys, mark] of MARKS) {
      expect((await typed(page, 'baseline', keys)).histogram[mark], keys).toBe(1);
    }
  });

  test('compat leaves them text', async ({ page }) => {
    for (const [keys, mark] of MARKS) {
      expect((await typed(page, 'compat', keys)).histogram[mark], keys).toBeUndefined();
    }
  });

  test('compat still formats a flanked, unescaped run', async ({ page }) => {
    for (const [keys, mark] of [
      ['2 *3*', 'mark:emphasis'],
      ['**bold**', 'mark:strong'],
      ['a _em_', 'mark:emphasis'],
      ['~~gone~~', 'mark:strike_through'],
      ['`code`', 'mark:inlineCode'],
      ['\\\\*em*', 'mark:emphasis'],
      ['a *"b"*', 'mark:emphasis'],
      ['x `a\\`', 'mark:inlineCode'],
    ] as const) {
      expect((await typed(page, 'compat', keys)).histogram[mark], keys).toBe(1);
    }
  });

  test('canary: upstream still opens a fence for lowercase letters only', async ({ page }) => {
    expect((await typed(page, 'baseline', '```js ')).histogram.code_block).toBe(1);
    expect((await typed(page, 'baseline', '```c++ ')).histogram.code_block).toBeUndefined();
    expect((await typed(page, 'baseline', '```JavaScript ')).histogram.code_block).toBeUndefined();
  });

  test('compat opens a fence for any info word', async ({ page }) => {
    for (const language of ['js', 'c++', 'JavaScript', 'C#', 'ps1']) {
      const out = await typed(page, 'compat', '```' + language + ' x');
      expect(out.markdown, language).toBe('```' + language + '\nx\n```\n');
    }
  });

  test('canary: upstream still makes a level-7 heading of seven #', async ({ page }) => {
    expect((await typed(page, 'baseline', '####### seven')).headingLevels).toEqual([7]);
  });

  test('compat leaves seven # text and still makes headings of one to six', async ({ page }) => {
    const seven = await typed(page, 'compat', '####### seven');
    expect(seven.headingLevels).toEqual([]);
    expect(seven.markdown).toBe('####### seven\n');
    expect((await typed(page, 'compat', '###### six')).headingLevels).toEqual([6]);
  });
});
