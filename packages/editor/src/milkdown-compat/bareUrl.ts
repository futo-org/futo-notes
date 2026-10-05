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
 *
 * "The characters after it" means what the FILE will hold there, up to the
 * whitespace that ends a literal — escapes included, since a `\` is not
 * punctuation GFM trims (`_x (https://a.com)_*** y` reads `https://a.com`, but
 * its save `…)_\*\*\* y` would read `https://a.com)_\*\*\`). So the text after
 * the URL is written by the real `text` handler before it is re-parsed, and it
 * must reach whitespace inside this parent — or end a paragraph, heading or
 * cell, where the line or the cell ends with it. A URL that a mark closes
 * right after, or that a mark opens or closes right before (whose edge
 * character the attention encoding may turn into `&#x…;`), keeps the stock form.
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

/** Containers whose phrasing nothing follows on the same line (or in the
 * same cell): a literal that reaches their end ends there. */
const LINE_ENDING_PARENTS = new Set(['paragraph', 'heading', 'tableCell']);

/** The marks whose handlers encode a neighbouring character (attentionEncoding.ts). */
const ATTENTION = new Set(['emphasis', 'strong', 'delete']);

/** Whether a mark's opener or closer sits straight before `node`: its handler
 * may write the character after it as a reference (`**Note:**&#x68;ttps://…`
 * still reads back linked, through remark-gfm's text pass, but nobody typed
 * that), so a URL there keeps the stock form. Empty text writes nothing — the
 * transformer leaves it where it moved a mark's edge space out. */
function afterAttention(node: LinkNode, parent: LinkParent): boolean {
  const siblings = (parent?.children ?? []) as readonly ParsedNode[];
  const written = siblings
    .slice(0, siblings.indexOf(node as ParsedNode))
    .filter((sibling) => sibling.type !== 'text' || sibling.value !== '');
  const previous = written.length > 0 ? written[written.length - 1] : parent;
  return previous !== undefined && ATTENTION.has(previous.type);
}

/** The first character `node` will write — `containerPhrasing`'s own peek. */
function peek(node: ParsedNode, parent: LinkParent, state: LinkState, info: LinkInfo): string {
  type Handle = LinkState['handle'] & { peek?: LinkState['handle'] };
  const handle = (state.handlers as Partial<Record<string, Handle>>)[node.type];
  const look = handle?.peek ?? handle;
  return look ? look(node, parent, state, { ...info, before: '', after: '' }).charAt(0) : '';
}

/** What the file will hold straight after the bare URL `text`, up to the
 * whitespace that ends a literal — or null when that is not provably all
 * trailing punctuation GFM trims. */
function followingText(
  node: LinkNode,
  text: string,
  parent: LinkParent,
  state: LinkState,
  info: LinkInfo,
): string | null {
  const siblings = (parent?.children ?? []) as readonly unknown[];
  const index = siblings.indexOf(node);
  const next = siblings[index + 1] as ParsedNode | undefined;
  if (next?.type !== 'text') {
    // Another construct, or the end of the parent: only an ending the literal
    // cannot run into.
    return info.after === '' || /\s/.test(info.after) ? '' : null;
  }
  const isLast = index + 2 >= siblings.length;
  // Written exactly as `containerPhrasing` will write it next: after the bare
  // URL, before the next sibling's first character. Past the parent's end
  // `\n` stands in for whatever follows a line — no escape of the trailing
  // punctuation accepted below keys on it.
  const after = isLast ? '\n' : peek(siblings[index + 2] as ParsedNode, parent, state, info);
  const written = state.handle(next, parent, state, { ...info, before: text.slice(-1), after });
  const word = /^\S*/.exec(written)?.[0] ?? '';
  if (!TRIMMED_TAIL.test(word)) return null;
  if (word.length < written.length) return word;
  // The word runs to the end of this text: whatever follows it — a mark's
  // closer, the next sibling — is part of the literal too, unless the line or
  // cell ends here.
  return isLast && parent && LINE_ENDING_PARENTS.has(parent.type) ? word : null;
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
  if (afterAttention(node, parent)) return null;
  const after = followingText(node, text, parent, state, info);
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
  // After a mark it always falls back, so the mark is told `<`, as stock.
  handler.peek = (node, parent, state) =>
    (afterAttention(node, parent) ? null : literalText(node)?.charAt(0)) ??
    defaultHandlers.link.peek?.(node, parent, state) ??
    '';
  return handler;
}
