/*
 * Fenced-code syntax colouring for the Milkdown editor.
 *
 * Same grammars, same curated set, same lazy load as the CodeMirror editor:
 * `codeFenceLanguages.ts` is the single list, a fence in an unlisted language
 * still renders as a code block just uncoloured, and a grammar is fetched the
 * first time a fence uses it (docs/spec/editor.md, "Markdown elements"). What
 * changes is only the renderer — Lezer's `highlightTree` walks the parse tree
 * and `classHighlighter` names the tokens, and those names become ProseMirror
 * inline decorations instead of CodeMirror ones. The `tok-*` classes are
 * therefore identical, so both editors are painted by one stylesheet
 * (src/styles/code-tokens.css) off one palette.
 *
 * Why the plugin is ours and not a dependency: see blockDecorations.ts, which
 * has the measurements. Both published ProseMirror highlight plugins cost work
 * proportional to the document on every keystroke; this one costs work
 * proportional to the fence you are typing in.
 */
import { LanguageDescription, type LanguageSupport } from '@codemirror/language';
import { classHighlighter, highlightTree } from '@lezer/highlight';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import { Decoration, type DecorationSet } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';

import { codeFenceLanguages } from '../codeFenceLanguages';
import {
  changedRanges,
  decorateAllBlocks,
  isCodeBlock,
  repaintBlocks,
  type PositionedBlock,
} from './blockDecorations';

/**
 * Fences longer than this are left uncoloured.
 *
 * Lezer parses a fence from scratch on each edit inside it — there is no
 * viewport to parse to, the way CodeMirror has for the note itself — so the
 * cost of a keystroke inside a fence is the cost of parsing that fence. 20k
 * characters is roughly 400 lines of code, comfortably inside a frame, and far
 * beyond any fence in the 31k-note corpus. A note is not a source file.
 */
export const MAX_HIGHLIGHTED_FENCE_CHARS = 20_000;

export const codeHighlightKey = new PluginKey<DecorationSet>('FUTO_CODE_HIGHLIGHT');

/** Transaction meta that asks for a repaint after a grammar finished loading. */
const REFRESH = 'refresh';

/** Every `code_block` in `[from, to]`, with its position. */
export function codeBlocksIn(doc: ProseNode, from: number, to: number): PositionedBlock[] {
  const out: PositionedBlock[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!isCodeBlock(node)) return true;
    out.push({ node, pos });
    return false;
  });
  return out;
}

/** The curated-set entry for a fence's info string, or null if we have none. */
export function matchFenceLanguage(info: unknown): LanguageDescription | null {
  const name = typeof info === 'string' ? info.trim() : '';
  if (!name) return null;
  // `true` = also match aliases, which is the whole point of the alias column
  // in codeFenceLanguages.ts.
  return LanguageDescription.matchLanguageName(codeFenceLanguages, name, true);
}

/**
 * Token decorations for one fence whose grammar is already loaded.
 *
 * Exported for the unit tests, which supply a grammar directly rather than
 * waiting on a dynamic import.
 */
export function highlightFence(
  node: ProseNode,
  pos: number,
  support: LanguageSupport,
): Decoration[] {
  const code = node.textContent;
  if (code.length === 0 || code.length > MAX_HIGHLIGHTED_FENCE_CHARS) return [];

  const decorations: Decoration[] = [];
  // +1: the position of the fence's first character, just inside the node.
  const offset = pos + 1;
  highlightTree(support.language.parser.parse(code), classHighlighter, (from, to, classes) => {
    if (classes && from < to) {
      decorations.push(Decoration.inline(offset + from, offset + to, { class: classes }));
    }
  });
  return decorations;
}

export function createCodeHighlightPlugin(): Plugin<DecorationSet> {
  let editorView: ProseView | null = null;
  /** Grammars whose dynamic import is in flight, so it is asked for once. */
  const loading = new Set<string>();

  /**
   * The loaded grammar for a fence, or null — starting the load, and asking
   * for a repaint when it lands, if this is the first fence to want it.
   */
  function grammarFor(info: unknown): LanguageSupport | null {
    const description = matchFenceLanguage(info);
    if (!description) return null;
    if (description.support) return description.support;
    if (!loading.has(description.name)) {
      loading.add(description.name);
      void description
        .load()
        .then(() => {
          loading.delete(description.name);
          const view = editorView;
          if (view && !view.isDestroyed) {
            view.dispatch(view.state.tr.setMeta(codeHighlightKey, REFRESH));
          }
        })
        .catch(() => {
          // A grammar that will not load leaves its fences uncoloured, which
          // is exactly what an unlisted language does. Nothing to recover.
          loading.delete(description.name);
        });
    }
    return null;
  }

  /*
   * Not a pure function: for a fence whose grammar has not arrived yet this
   * STARTS the load (once per language) and returns the marker alone, and the
   * fence is decorated properly by the refresh that load dispatches.
   */
  function decorate(node: ProseNode, pos: number): Decoration[] {
    // Token decorations ONLY. There is no per-fence marker decoration, and
    // there must not be: a node decoration spanning a whole top-level block
    // lands in the decoration tree's root, so one per fence turns every
    // keystroke into O(fences) — 4.6 ms at 1000 fences, against 0.075 ms
    // without (AGENTS.md M5). src/styles/code-tokens.css scopes Milkdown's
    // token colours to `.futo-milkdown .ProseMirror pre` instead, which costs
    // nothing at runtime.
    const support = grammarFor(node.attrs.language);
    return support ? highlightFence(node, pos, support) : [];
  }

  function decorateAll(doc: ProseNode): DecorationSet {
    return decorateAllBlocks(doc, codeBlocksIn, decorate);
  }

  return new Plugin<DecorationSet>({
    key: codeHighlightKey,
    state: {
      init: (_config, state) => decorateAll(state.doc),
      apply: (tr, set) => {
        // A grammar just arrived: every fence in the note may now be
        // colourable, and this happens once per language, not per keystroke.
        if (tr.getMeta(codeHighlightKey) === REFRESH) return decorateAll(tr.doc);
        if (!tr.docChanged) return set;
        return repaintBlocks(
          set.map(tr.mapping, tr.doc),
          tr.doc,
          changedRanges(tr),
          codeBlocksIn,
          decorate,
        );
      },
    },
    view: (view) => {
      editorView = view;
      return {
        destroy: () => {
          editorView = null;
        },
      };
    },
    props: {
      decorations(state) {
        return codeHighlightKey.getState(state);
      },
    },
  });
}

/** The Milkdown plugin: `.use(codeHighlight)`. */
export const codeHighlight = $prose(() => createCodeHighlightPlugin());
