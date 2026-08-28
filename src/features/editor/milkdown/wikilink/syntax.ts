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
type MicromarkTokenizer = (
  effects: MicromarkEffects,
  ok: MicromarkState,
  nok: MicromarkState,
) => MicromarkState;

/** A line ending or the end of the document — both end the run per the regex. */
function endsTheLine(code: number | null): boolean {
  return code === null || code === -5 || code === -4 || code === -3;
}

const tokenizeWikilink: MicromarkTokenizer = (effects, ok, nok) => {
  /* Characters accepted into the target so far. `WIKILINK_RE` needs one or
   * more, so `[[]]` is literal text, not an empty wikilink. */
  let size = 0;

  /**
   * ONE token spans the whole `[[target]]`. The target is read back in
   * `fromMarkdown` as `slice(2, -2)` of that token rather than from a nested
   * token, because a `]` inside the target (`[[a]b]]`) is only recognisable as
   * content one character AFTER it has been consumed — by which time a nested
   * target token would already have had to close around it.
   */
  function start(code: number | null): MicromarkState | undefined {
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
    if (endsTheLine(code)) return nok(code);
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
      node.target = this.sliceSerialize(token).slice(2, -2);
      this.exit(token);
    },
  },
};

/**
 * Serialization is the whole reason this exists: `mdast-util-to-markdown`'s
 * text handler escapes a leading `[`, so an unhandled `[[x]]` leaves the editor
 * as `\[\[x]]` and every link in the note stops resolving. The handler returns
 * the target verbatim — no `safe()`, no escaping — so a round trip is
 * byte-identical, and no `unsafe` pattern is registered, so neighbouring text
 * is not escaped on our account either.
 */
export const wikilinkToMarkdownExtension = {
  handlers: {
    [WIKILINK_MDAST_TYPE]: (node: WikilinkMdastNode): string => `[[${node.target}]]`,
  },
};

/**
 * The remark plugin Milkdown mounts through `$remark`. Registers all three
 * halves — tokenizer, mdast build, mdast serialize — on the shared processor.
 */
export const remarkWikilink: RemarkPluginRaw<undefined> = function remarkWikilinkPlugin() {
  const data = this.data() as Record<string, unknown[]>;
  const push = (key: string, value: unknown): void => {
    const list = (data[key] ??= []);
    list.push(value);
  };
  push('micromarkExtensions', wikilinkMicromarkExtension);
  push('fromMarkdownExtensions', wikilinkFromMarkdownExtension);
  push('toMarkdownExtensions', wikilinkToMarkdownExtension);
};
