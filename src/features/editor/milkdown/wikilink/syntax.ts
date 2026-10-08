/**
 * `[[wikilink]]` markdown syntax for Milkdown's remark pipeline.
 *
 * WHY THIS IS HAND-WRITTEN (the #101 survey, 2026-08-28). Every published
 * wikilink extension for the unified ecosystem was measured against two
 * requirements — serialize our syntax back byte-for-byte, and tokenize exactly
 * what `$shared/note/wikilinks` `WIKILINK_RE` tokenizes (the conformance-locked
 * rule the Rust store rewrites renames with). None passed both:
 *
 * | candidate | verdict |
 * |---|---|
 * | `remark-wiki-link@2.0.1` (89k/mo) | escapes `*`, `_`, `[`, `\` INSIDE the target on serialize — `[[a_b_c]]` comes back `[[a\_b\_c]]` (9/26 byte diffs); splits on its `:` alias divider |
 * | `@moritzrs/*-ofm-wikilink@0.0.1` | Obsidian semantics: `value` is the LAST path segment, `\|`/`#` split the target, `[[ x ]]` rewritten to `[[x]]` (9/26 target mismatches) |
 * | `@flowershow/remark-wiki-link@4.0.0` | publishes no `dist/` — the package cannot be imported at all |
 * | `mdast-util-wikilink-syntax@2.0.1` | parse only, no `toMarkdown` export (22 downloads/month, 0 stars) |
 * | `@portaljs/remark-wiki-link@1.2.0`, `remark-wikirefs@0.0.12-rm` | built for micromark 3/mdast-util 1; both throw under Milkdown's micromark 4 pipeline |
 *
 * Every one of them also implements Obsidian's `[[target|alias]]` and
 * `[[target#heading]]`, which docs/spec/editor.md explicitly rejects: our rules
 * treat the WHOLE inner text as the target, and the Rust port pins that.
 * Adopting any of them would have split the wikilink grammar in two — the
 * editor showing a link where a rename will not rewrite it, or the reverse.
 *
 * So this file states the grammar a third time (TS regex, Rust regex, this
 * tokenizer) and `syntax.test.ts` locks it with a differential against
 * `findWikilinks` — the same shape as the TS↔Rust rule differential. Registered
 * in `scripts/drift-registry.json`.
 *
 * The grammar, verbatim from `WIKILINK_RE`: `[[`, then ONE OR MORE characters
 * that are neither a line ending nor the start of `]]`, then `]]`. Code spans
 * and fences are excluded for free — micromark never runs text constructs
 * inside them, which is what docs/spec/editor.md already says should happen.
 */
import type { RemarkPluginRaw } from '@milkdown/kit/transformer';

/** The mdast node type this extension parses to and serializes from. */
export const WIKILINK_MDAST_TYPE = 'wikilink';

/** The mdast node `[[target]]` becomes. `target` is the RAW inner text. */
export interface WikilinkMdastNode {
  type: typeof WIKILINK_MDAST_TYPE;
  target: string;
}

const EXCLAMATION_MARK = 33;
const LEFT_SQUARE_BRACKET = 91;
const RIGHT_SQUARE_BRACKET = 93;

/**
 * micromark's `Extension`, `Tokenizer` and friends are types only — importing
 * `micromark-util-types` would add a dependency for zero runtime code, and this
 * module builds nothing but plain objects. The shapes below are the parts of
 * that contract this tokenizer actually touches.
 */
type MicromarkState = (code: number | null) => MicromarkState | undefined;
interface MicromarkConstruct {
  name: string;
  tokenize: MicromarkTokenizer;
}
interface MicromarkEffects {
  enter(type: string): void;
  exit(type: string): void;
  consume(code: number | null): void;
  /** Runs `construct` from the current point and REWINDS either way. */
  check(construct: MicromarkConstruct, ok: MicromarkState, nok: MicromarkState): MicromarkState;
}
/** The tokenizer's `this`: where it is, and which parse it belongs to. */
interface MicromarkTokenizeContext {
  now(): { offset: number };
  /** One object per `parse()` of a document. */
  parser: object;
}
type MicromarkTokenizer = (
  this: MicromarkTokenizeContext,
  effects: MicromarkEffects,
  ok: MicromarkState,
  nok: MicromarkState,
) => MicromarkState;

/** A line ending or the end of the document — both end the run per the regex. */
function endsTheLine(code: number | null): boolean {
  return code === null || code === -5 || code === -4 || code === -3;
}

/**
 * The stretch of the current line, per parse, already proven to hold no `]]`:
 * an attempt that started at `from` read its target up to the line ending at
 * `to` without finding one. Every `[[` in between would read the same
 * characters to the same line ending and fail the same way, so it fails at
 * once instead. Without this, micromark retries the construct at EVERY `[`,
 * and a long line of unclosed `[[` cost O(n²) to open — measured at 2.7 s for
 * a 40k-character line against 32 ms for plain text (hardening L6e-7).
 * Keyed on the parser, so no two documents (or two parses of one) share it.
 */
const lineWithoutCloser = new WeakMap<object, { from: number; to: number }>();

const tokenizeWikilink: MicromarkTokenizer = function tokenizeWikilink(effects, ok, nok) {
  const parser = this.parser;
  const offset = (): number => this.now().offset;
  /* Characters accepted into the target so far. `WIKILINK_RE` needs one or
   * more, so `[[]]` is literal text, not an empty wikilink. */
  let size = 0;
  /* Where this attempt's `[[` began. */
  let from = 0;

  /**
   * ONE token spans the whole `[[target]]`. The target is read back in
   * `fromMarkdown` as `slice(2, -2)` of that token rather than from a nested
   * token, because a `]` inside the target (`[[a]b]]`) is only recognisable as
   * content one character AFTER it has been consumed — by which time a nested
   * target token would already have had to close around it.
   *
   * The `[` guard is load-bearing, not belt-and-braces (issue #112). Reached
   * from the construct map this state only ever sees `[`, but the `!` construct
   * below runs this same tokenizer as `effects.check` lookahead, which hands it
   * whatever follows the bang — a `|`, a space, another `!`, a line ending, or
   * `null` at end of document. Entering `wikilink` before that check and then
   * consuming an EOF stranded the token OPEN: micromark stops feeding states
   * once the final chunk is consumed, so neither `ok` nor `nok` ran and nothing
   * rewound it, and the enclosing `paragraph`/`tableHeader` could no longer
   * close — the note threw on open and rendered blank. Declining before `enter`
   * keeps the invariant this whole machine rests on: every path out of an
   * entered token reaches `ok` or `nok`, and no path ever consumes a line
   * ending or `null`.
   */
  function start(code: number | null): MicromarkState | undefined {
    if (code !== LEFT_SQUARE_BRACKET) return nok(code);
    from = offset();
    const known = lineWithoutCloser.get(parser);
    if (known && from > known.from && from < known.to) return nok(code);
    effects.enter('wikilink');
    effects.consume(code);
    return afterFirstBracket;
  }

  function afterFirstBracket(code: number | null): MicromarkState | undefined {
    if (code !== LEFT_SQUARE_BRACKET) return nok(code);
    effects.consume(code);
    return inTarget;
  }

  function inTarget(code: number | null): MicromarkState | undefined {
    if (endsTheLine(code)) {
      lineWithoutCloser.set(parser, { from, to: offset() });
      return nok(code);
    }
    if (code === RIGHT_SQUARE_BRACKET) {
      effects.consume(code);
      return afterFirstClosingBracket;
    }
    size += 1;
    effects.consume(code);
    return inTarget;
  }

  /**
   * A `]` was consumed. If the next character closes the pair we are done;
   * otherwise that `]` was ordinary target content and the run continues —
   * `[[a]b]]` is one wikilink whose target is `a]b`.
   */
  function afterFirstClosingBracket(code: number | null): MicromarkState | undefined {
    if (code === RIGHT_SQUARE_BRACKET) {
      if (size === 0) return nok(code);
      effects.consume(code);
      effects.exit('wikilink');
      return ok;
    }
    size += 1;
    return inTarget(code);
  }

  return start;
};

const wikilinkConstruct: MicromarkConstruct = { name: 'wikilink', tokenize: tokenizeWikilink };

/**
 * `![[x]]` — Obsidian's embed syntax, and ordinary text to us: `WIKILINK_RE`
 * sees a bare `!` followed by the wikilink `[[x]]`. micromark disagrees on its
 * own, because `labelStartImage` fires at `!` and swallows the `![` pair, after
 * which the surviving single `[` cannot start a wikilink and the whole run gets
 * escaped to `!\[\[x]]` — a wikilink silently broken on the first edit of any
 * imported Obsidian note.
 *
 * So claim the `!` as plain text, but ONLY when a real wikilink follows.
 * `effects.check` runs the wikilink tokenizer as pure lookahead and rewinds, so
 * `[[x]]` is still tokenized by the construct below; a lone `!` or a `![` image
 * label is left to micromark untouched.
 */
const bangBeforeWikilinkConstruct: MicromarkConstruct = {
  name: 'wikilinkBang',
  tokenize: (effects, ok, nok) => {
    return function start(code) {
      effects.enter('data');
      effects.consume(code);
      effects.exit('data');
      return effects.check(wikilinkConstruct, ok, nok);
    };
  },
};

/**
 * micromark syntax extension. Extension constructs are spliced AHEAD of the
 * core ones for the same character (micromark-util-combine-extensions splices
 * at index 0 unless `add: 'after'`), so this is tried before `labelStartLink`
 * and `labelStartImage`, and claims the whole `[[...]]` run before emphasis or
 * link resolution can see inside it — `[[a*b*c]]` keeps `a*b*c` as one target.
 */
export const wikilinkMicromarkExtension = {
  text: {
    [LEFT_SQUARE_BRACKET]: wikilinkConstruct,
    [EXCLAMATION_MARK]: bangBeforeWikilinkConstruct,
  },
};

interface FromMarkdownContext {
  enter(node: WikilinkMdastNode, token: unknown): void;
  exit(token: unknown): void;
  sliceSerialize(token: unknown): string;
  stack: WikilinkMdastNode[];
  /** `mdast-util-gfm-table` sets `inTable` for the rows of a table. */
  data: { inTable?: boolean };
}

/*
 * A pipe inside a GFM table cell. The row is split on every unescaped `|`
 * BEFORE any inline parsing, so a wikilink whose target holds one — `[[a|b]]`,
 * typed by hand or written by Obsidian — has to be spelled `[[a\|b]]` there,
 * or the next open splits the cell in two and the link with it. This is
 * `mdast-util-gfm-table`'s own rule for inline code, restated for this node:
 * `\|` reads back as `|` inside a table (the serializer writes `|` as `\|` in
 * a cell, docs/spec/editor.md "Markdown house style"). No rule outcome moves:
 * `|` is a forbidden note-title character, so a target holding one never
 * resolves and no rename ever rewrites it.
 */
function unescapeCellPipes(target: string): string {
  // Pipes work, backslashes do not (but cannot escape pipes) — upstream's rule.
  return target.replace(/\\([\\|])/g, (escape, character: string) =>
    character === '|' ? character : escape,
  );
}

export const wikilinkFromMarkdownExtension = {
  enter: {
    wikilink(this: FromMarkdownContext, token: unknown): void {
      this.enter({ type: WIKILINK_MDAST_TYPE, target: '' }, token);
    },
  },
  exit: {
    wikilink(this: FromMarkdownContext, token: unknown): void {
      const node = this.stack[this.stack.length - 1];
      // The token spans `[[` + target + `]]`; the target is what is between.
      const target = this.sliceSerialize(token).slice(2, -2);
      node.target = this.data.inTable ? unescapeCellPipes(target) : target;
      this.exit(token);
    },
  },
};

/**
 * The remark plugin Milkdown mounts through `$remark`. Registers both halves —
 * tokenizer and mdast build — on the shared processor. Writing `[[target]]`
 * back is the serializer's (`@futo-notes/editor/markdown`): the target
 * verbatim, but for a `|` inside a table cell, written `\|`.
 */
export const remarkWikilink: RemarkPluginRaw<undefined> = function remarkWikilinkPlugin() {
  const data = this.data() as Record<string, unknown[]>;
  const push = (key: string, value: unknown): void => {
    const list = (data[key] ??= []);
    list.push(value);
  };
  push('micromarkExtensions', wikilinkMicromarkExtension);
  push('fromMarkdownExtensions', wikilinkFromMarkdownExtension);
};
