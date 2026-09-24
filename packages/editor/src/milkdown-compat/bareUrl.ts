/*
 * A link that IS a bare URL is written back bare.
 *
 * GFM reads `https://example.com` and `www.example.com` in prose as links
 * (autolink literals), and the editor shows them as links. mdast-util-to-markdown
 * has no bare-URL output, though: its `link` handler writes a link whose text is
 * its URL as `<https://example.com>`, and a `www.` literal — whose URL gained an
 * `http://` its text never had — as `[www.example.com](http://www.example.com)`.
 * So the first save after ANY edit rewrote every bare URL in the note, and a URL
 * that turned into a link as it was typed (src/features/editor/milkdown/
 * autolink.ts) would have been saved in a form the user never typed.
 *
 * The bare form is written only when it provably reads back as the same link:
 * the URL is re-parsed together with the characters on either side of it,
 * through the editor's own parser, so the question "is this still that link?"
 * is answered by the thing that will answer it on the next open. Anything else
 * — neighbours that would lengthen or cut the literal, a titled link, an email,
 * a `|` inside a table cell — keeps the stock output.
 */
import { defaultHandlers } from 'mdast-util-to-markdown';

type LinkHandler = typeof defaultHandlers.link;
type LinkNode = Parameters<LinkHandler>[0];
type LinkParent = Parameters<LinkHandler>[1];
type LinkState = Parameters<LinkHandler>[2];
type LinkInfo = Parameters<LinkHandler>[3];

/** The slice of an mdast tree the round-trip check reads. */
export interface ParsedNode {
  type: string;
  url?: string;
  value?: string;
  children?: ParsedNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/** Markdown in, mdast out — the editor's own remark processor's `parse`. */
export type ParseMarkdown = (markdown: string) => ParsedNode;

/** What follows a URL and still leaves GFM's literal ending where it did:
 * trailing punctuation it trims, and a closing paren it does not balance. */
const TRIMMED_TAIL = /^[.,:;!?)]*$/;

/** The text a bare URL would be written as, or null for "not a bare URL". */
function literalText(node: LinkNode): string | null {
  if (node.title) return null;
  const [only, ...rest] = node.children;
  if (!only || rest.length > 0 || only.type !== 'text') return null;
  const text = only.value;
  if (/[\s<>]/.test(text)) return null;
  if (/^https?:\/\//i.test(text) && node.url === text) return text;
  if (/^www\./i.test(text) && node.url === `http://${text}`) return text;
  return null;
}

/** What comes straight after the link, up to the whitespace that ends a
 * literal — or null when that is something this check cannot vouch for. */
function followingText(node: LinkNode, parent: LinkParent, info: LinkInfo): string | null {
  const siblings = parent?.children as readonly unknown[] | undefined;
  const next = siblings?.[siblings.indexOf(node) + 1] as ParsedNode | undefined;
  if (next?.type === 'text') {
    const word = /^\S*/.exec(next.value ?? '')?.[0] ?? '';
    return TRIMMED_TAIL.test(word) ? word : null;
  }
  // Another construct, or the end of the parent: only an ending the literal
  // cannot run into.
  return info.after === '' || /\s/.test(info.after) ? '' : null;
}

function firstLink(node: ParsedNode): ParsedNode | null {
  if (node.type === 'link') return node;
  for (const child of node.children ?? []) {
    const found = firstLink(child);
    if (found) return found;
  }
  return null;
}

function bareForm(
  node: LinkNode,
  parent: LinkParent,
  state: LinkState,
  info: LinkInfo,
  parse: ParseMarkdown,
): string | null {
  const text = literalText(node);
  if (text === null) return null;
  if (text.includes('|') && state.stack.includes('tableCell')) return null;
  const after = followingText(node, parent, info);
  if (after === null) return null;
  const before = info.before === '\n' ? '' : info.before;
  const link = firstLink(parse(before + text + after));
  const start = link?.position?.start.offset;
  const end = link?.position?.end.offset;
  if (link?.url !== node.url || start !== before.length || end !== before.length + text.length) {
    return null;
  }
  return text;
}

/**
 * The `link` handler, writing a bare URL bare. `parse` is the editor's own
 * remark processor (`ctx.get(remarkCtx).parse`), read at serialize time.
 */
export function bareUrlLinkHandler(parse: ParseMarkdown): LinkHandler {
  const handler: LinkHandler = (node, parent, state, info) =>
    bareForm(node, parent, state, info, parse) ?? defaultHandlers.link(node, parent, state, info);
  // What the PREVIOUS sibling is told comes after it. Without `info` the
  // decision above cannot be re-made here, so this answers for the shape: a
  // bare URL starts with a letter, and no stock escape keys on a following
  // letter, so a URL that falls back to `<…>` is not under-escaped by it.
  handler.peek = (node, parent, state) =>
    literalText(node)?.charAt(0) ?? defaultHandlers.link.peek?.(node, parent, state) ?? '';
  return handler;
}
