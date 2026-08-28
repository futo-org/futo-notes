/*
 * `#tag` decorations for the Milkdown editor.
 *
 * The document holds tags as ordinary text — no schema node, no mark — exactly
 * as the file on disk does, so typing a tag, editing one mid-word, or deleting
 * a character out of one behaves like typing anything else (an atom node would
 * make a tag undeletable-by-character and would put an IME-hostile boundary in
 * the middle of a word). What this adds is the *decoration*: the same
 * conformance-locked rule the tag bar and the note index use, painted onto the
 * ranges it matches.
 *
 * What it deliberately does NOT do is hide the leading header tag block the way
 * the CodeMirror editor does. In CodeMirror the hidden line is still reachable,
 * because cursor motion there runs over the document rather than the DOM; a
 * ProseMirror node rendered `display: none` cannot be reached by caret or click
 * at all, so hiding it would leave the note's tags unreadable AND uneditable —
 * and on the native shells, which have no tag bar, that is the only place they
 * exist. Recorded as a gap in docs/spec/editor.md against the desktop swap,
 * which is where the tag bar and this editor first meet.
 *
 * Two things it must not do, both of them spec (docs/spec/editor.md "Code /
 * fence isolation"):
 *   - decorate inside inline code or a fenced block, and
 *   - cost anything per keystroke that scales with the document.
 *
 * The second is why decorations are rebuilt per TEXTBLOCK rather than per
 * document: a transaction re-scans only the blocks its own steps touched, and
 * maps the rest (AGENTS.md M5).
 */
import { scanTags } from '@futo-notes/editor';
import { $prose } from '@milkdown/kit/utils';

import { changedRanges, repaintBlocks, type PositionedBlock } from './blockDecorations';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';

/** Class the decoration paints; styled by MilkdownEditor.svelte. */
export const TAG_DECORATION_CLASS = 'futo-tag';

export const tagDecorationsKey = new PluginKey<DecorationSet>('FUTO_TAG_DECORATIONS');

/**
 * A textblock's text with every position preserved, and every position the tag
 * rule must not see blanked out.
 *
 * Inline nodes that are not text (an image, a hard break) contribute their
 * `nodeSize` in spaces, and so does text carrying the `code` mark. Both
 * substitutions keep `result[i]` at the same offset the character occupies in
 * the block, so a match at offset `i` is at ProseMirror position `pos + 1 + i`
 * — and a space is a tag boundary, so blanking can only ever destroy a match,
 * never invent one.
 */
export function scannableBlockText(node: ProseNode): string {
  let text = '';
  node.forEach((child) => {
    // `code: true` is how a mark declares "this is code" in a ProseMirror
    // schema, so this stays right if the mark is ever renamed (Milkdown's is
    // `inlineCode`).
    const isCode = child.marks.some((mark) => mark.type.spec.code === true);
    if (child.isText && !isCode) text += child.text ?? '';
    else text += ' '.repeat(child.nodeSize);
  });
  return text;
}

/** Tag decorations for one textblock at `pos` (the position BEFORE the node). */
export function blockTagDecorations(node: ProseNode, pos: number): Decoration[] {
  return scanTags(scannableBlockText(node)).map((match) =>
    Decoration.inline(pos + 1 + match.start, pos + 1 + match.end, {
      class: TAG_DECORATION_CLASS,
    }),
  );
}

/**
 * Every textblock in `doc` that a tag can live in, with its position.
 * `code_block` is skipped whole — a fenced block's contents are never tags —
 * and so is anything nested inside one.
 */
export function scannableBlocks(doc: ProseNode, from: number, to: number): PositionedBlock[] {
  const out: PositionedBlock[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.spec.code) return false;
    if (node.isTextblock) {
      out.push({ node, pos });
      return false;
    }
    return true;
  });
  return out;
}

export function docTagDecorations(doc: ProseNode): DecorationSet {
  return DecorationSet.create(
    doc,
    scannableBlocks(doc, 0, doc.content.size).flatMap(({ node, pos }) =>
      blockTagDecorations(node, pos),
    ),
  );
}

export function createTagDecorationPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: tagDecorationsKey,
    state: {
      init: (_config, state) => docTagDecorations(state.doc),
      apply: (tr, set) =>
        tr.docChanged
          ? repaintBlocks(
              set.map(tr.mapping, tr.doc),
              tr.doc,
              changedRanges(tr),
              scannableBlocks,
              blockTagDecorations,
            )
          : set,
    },
    props: {
      decorations(state) {
        return tagDecorationsKey.getState(state);
      },
    },
  });
}

/** The Milkdown plugin: `.use(tagDecorations)`. */
export const tagDecorations = $prose(() => createTagDecorationPlugin());
