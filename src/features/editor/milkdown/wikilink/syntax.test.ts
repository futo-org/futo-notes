// @vitest-environment jsdom
/**
 * The wikilink grammar, locked against the rule that owns it.
 *
 * `syntax.ts` states the `[[target]]` grammar a third time (after the TS regex
 * and its Rust mirror) because no published extension could both serialize our
 * syntax byte-for-byte and tokenize it our way — see that file's survey table.
 * A third statement earns a differential, the same shape as the TS↔Rust rule
 * differential: every case below asks `findWikilinks` — the conformance-locked
 * scanner the Rust rename rewriter mirrors — and the real editor the same
 * question, and fails on any disagreement.
 *
 * A disagreement is not cosmetic. If the editor renders a chip the rewriter
 * will not rewrite, a rename silently breaks that link; if the rewriter rewrites
 * text the editor showed as plain, a rename mangles the user's prose.
 */
import { describe, expect, it } from 'vitest';

import { findWikilinks } from '$shared/note/wikilinks';
import { roundTrip } from './__fixtures__/roundTrip';

/** What the conformance-locked rule calls a wikilink in `source`. */
function conformanceTargets(source: string): string[] {
  return findWikilinks(source).map((occurrence) => occurrence.target);
}

/**
 * Inline contexts the grammar has to survive. Each is a paragraph-level string
 * — the differential's claim is about INLINE parsing, which is the only place
 * the two implementations are meant to agree (see the code-span case below).
 */
const INLINE_CASES = [
  // The everyday shapes.
  '[[a]]',
  'See [[notes/alpha]] here.',
  '[[a]] [[b]]',
  'x[[a]]y',
  '[[a/b/c/d]]',
  '[[Über/naïve]]',
  'text with [[a]] and **bold [[b]]** mixed',
  '**[[a]]**',
  '# [[heading]]',
  '> quote [[q]]',
  '- item [[g/d]]',

  // The whole inner text is the target — no alias, no heading anchor
  // (docs/spec/editor.md: "`[[target|alias]]` links are not rewritten — the TS
  // rules treat the whole inner text as the target, and the Rust port pins
  // that"). Every surveyed library splits these.
  '[[a|b]]',
  '[[a#h]]',
  '[[a:b]]',

  // Characters CommonMark would otherwise claim inside the brackets.
  '[[a*b*c]]',
  '[[a_b_c]]',
  '[[a[b]]',
  '[[a](b)]]',
  '[[a\\]]',
  '[[ spaced ]]',
  '[[a  b]]',
  '[[-]]',

  // Bracket pile-ups: the run ends at the FIRST `]]`, and a lone `]` is content.
  '[[a]b]]',
  '[[[a]]]',
  '[[a]]]',
  '[[[[a]]',

  // Not wikilinks: no target, no closer, or a closer on another line.
  '[[]]',
  '[[unclosed',
  '[[multi\nline]]',

  // `!` in front is ordinary text to both implementations (see the escape note
  // in the round-trip block below).
  '![[embed]]',
  '! [[a]]',
  '![[a]] and ![[b]]',

  // A real image must still be an image — the `!` lookahead has to decline.
  '![alt](pic.png)',
  '![](pic.png)',

  // Inside a link label.
  '[link [[a]] text](http://x)',
];

/**
 * Cross-product cover: every target shape in every surrounding shape. Cheap to
 * grow, and it is where an off-by-one in the tokenizer's `]`-handling shows up.
 */
const TARGETS = ['a', 'a/b', 'a]b', 'a[b', 'a*b*', 'a|b', 'a b', '-', 'Ü', 'a\\'];
const FRAMES = [
  (link: string) => link,
  (link: string) => `before ${link} after`,
  (link: string) => `${link}${link}`,
  (link: string) => `**${link}**`,
  // `*`, not `-`: the preset normalizes the bullet marker, which is list work
  // (pinned below), not wikilink work.
  (link: string) => `* ${link}`,
  (link: string) => `# ${link}`,
  (link: string) => `> ${link}`,
  (link: string) => `_${link}_ and *x*`,
];
const GENERATED_CASES = TARGETS.flatMap((target) => FRAMES.map((frame) => frame(`[[${target}]]`)));

describe('wikilink tokenizing', () => {
  it.each([...INLINE_CASES, ...GENERATED_CASES])(
    'finds the same wikilinks the conformance rule does in %j',
    async (source) => {
      const document_ = `${source}\n`;
      const { targets } = await roundTrip(document_);
      expect(targets).toEqual(conformanceTargets(document_));
    },
  );

  /**
   * The ONE place the two are meant to disagree, and it is the editor that is
   * right: docs/spec/editor.md — "Wikilinks and tags inside inline code or
   * fenced blocks are NOT decorated and NOT extracted". `findWikilinks` is a
   * raw-text scanner with no notion of code, which is why the CodeMirror path
   * filters code separately and this one gets it from micromark for free.
   */
  it.each(['`[[code]]`', '``a [[code]] b``', '    [[indented code]]', '```\n[[fence]]\n```'])(
    'does not make a wikilink inside code: %j',
    async (source) => {
      const { targets } = await roundTrip(`${source}\n`);
      expect(targets).toEqual([]);
    },
  );
});

describe('wikilink serialization', () => {
  /**
   * THE acceptance criterion. Without the `toMarkdown` handler, remark's text
   * escaping turns every `[[x]]` into `\[\[x]]` on the first real edit and the
   * whole vault's link graph stops resolving.
   */
  it.each(INLINE_CASES.filter((source) => conformanceTargets(`${source}\n`).length > 0))(
    'never backslash-escapes the wikilink in %j',
    async (source) => {
      const { markdown } = await roundTrip(`${source}\n`);
      expect(markdown).not.toContain('\\[\\[');
      for (const target of conformanceTargets(`${source}\n`)) {
        expect(markdown).toContain(`[[${target}]]`);
      }
    },
  );

  it.each([...INLINE_CASES, ...GENERATED_CASES].filter((source) => !NORMALIZES.has(source)))(
    'round-trips %j byte for byte',
    async (source) => {
      const document_ = `${source}\n`;
      expect((await roundTrip(document_)).markdown).toBe(document_);
    },
  );
});

/**
 * Sources Milkdown re-spells, pinned so a change to any of them is a decision
 * rather than a surprise. All three are ADR-0002 normalization: no content is
 * lost, no wikilink is touched, and each is idempotent (asserted below).
 */
const NORMALIZATIONS: Array<[source: string, normalized: string]> = [
  // A `!` immediately before a wikilink gains a backslash, because
  // mdast-util-to-markdown escapes `!` whenever a `[` follows it and cannot be
  // told otherwise (its `unsafe` list only grows). The wikilink itself is
  // untouched and still resolves; `\!` renders as `!`. The alternative — having
  // the wikilink handler's `peek` lie about its first character — would suppress
  // this escape by suppressing every `after`-keyed escape next to a wikilink,
  // trading a cosmetic byte for a class of under-escaping bugs.
  ['![[embed]]', '\\![[embed]]'],
  ['![[a]] and ![[b]]', '\\![[a]] and \\![[b]]'],
  // Literal `[[` that is NOT a wikilink is escaped, exactly as Milkdown already
  // escapes a bare `[`. Neither implementation reads these as links.
  ['[[]]', '\\[\\[]]'],
  ['[[unclosed', '\\[\\[unclosed'],
  ['[[multi\nline]]', '\\[\\[multi\nline]]'],
  // Not wikilink work at all: list-marker and table normalization the preset
  // does to every note (docs/adr/0002-roundtrip-normalization-accepted.md).
  ['- item [[g/d]]', '* item [[g/d]]'],
];
const NORMALIZES = new Set(NORMALIZATIONS.map(([source]) => source));

describe('accepted normalization', () => {
  it.each(NORMALIZATIONS)('re-spells %j as %j', async (source, normalized) => {
    expect((await roundTrip(`${source}\n`)).markdown).toBe(`${normalized}\n`);
  });

  it.each(NORMALIZATIONS)(
    '%j settles after one pass (%j is stable)',
    async (_source, normalized) => {
      expect((await roundTrip(`${normalized}\n`)).markdown).toBe(`${normalized}\n`);
    },
  );
});

/**
 * Issue #112 — a `!` that is NOT the start of an `![[embed]]`.
 *
 * The `!` construct exists only to claim the bang in front of a real wikilink
 * (see `syntax.ts`), and it decides by running the wikilink tokenizer as
 * lookahead. That tokenizer is therefore handed whatever follows the `!` —
 * including a line ending or the end of the document — where every other entry
 * into it is guaranteed a `[`. Entering the `wikilink` token before checking
 * that guarantee stranded it open at end of input: micromark stops feeding
 * states once the final chunk is consumed, so neither `ok` nor `nok` ran and
 * nothing rewound the token. The enclosing `paragraph`/`tableHeader` then could
 * not close, the parse threw, and the WHOLE note opened blank.
 *
 * So: a `!` is a wikilink candidate only when `[[` immediately follows it.
 * Anywhere else — end of line, end of file, `|`, a space, another `!` — it is
 * plain text, and no token is left open.
 */
const BANG_CASES = [
  // The original report: a line ENDING in `!`.
  'hello!\n',
  // …and at the end of the document, with no trailing newline at all.
  'hello!',
  // Two in a row: the first `!` declines on the second, the second on the EOL.
  'no!!\n',
  'a! b!\n',
  // Inside a table cell, where the cell's content ends at the `!`.
  '| a | no!! |\n| - | - |\n| x | y |\n',
  '| a | b! |\n| - | - |\n| x | y |\n',
  // A `!` before a `[[` that never closes is still plain text.
  '![[unclosed\n',
  // The embed shape the construct exists for still parses to a wikilink.
  '![[Note]]\n',
  // …and a plain wikilink still works inside a table cell.
  '| a | [[Note]] |\n| - | - |\n| x | y |\n',
  // A real image in a table cell keeps working (the `!` lookahead declines).
  '| a | ![img](x.png) |\n| - | - |\n| x | y |\n',
];

describe('a `!` not followed by `[[` (issue #112)', () => {
  it.each(BANG_CASES)('parses %j instead of stranding a wikilink token', async (document_) => {
    const { targets } = await roundTrip(document_);
    expect(targets).toEqual(conformanceTargets(document_));
  });

  it.each(['hello!\n', 'no!!\n', 'a! b!\n', 'a!b\n'])(
    'round-trips %j byte for byte',
    async (document_) => {
      expect((await roundTrip(document_)).markdown).toBe(document_);
    },
  );
});
