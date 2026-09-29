import { $remark } from '@milkdown/kit/utils';

import type { MdastNode } from './mdast';
import { walk } from './mdast';

/**
 * Link reference definitions: inline the ones a reference uses, keep the rest.
 *
 * The schema has no definition node, so `@milkdown/preset-commonmark` runs
 * `remark-inline-links` (`remarkInlineLinkPlugin`), which rewrites every
 * `[text][label]` into an inline link and then deletes EVERY definition. For a
 * used one that is an accepted re-spelling — the URL and title move into the
 * link. For one nothing uses — kept for later, or referenced only from inside
 * code or a `[[wikilink]]` — it deleted the URL and the title outright on the
 * note's first edit, and a note of nothing but definitions saved as `''`
 * (RC-41; Q17 option 17B).
 *
 * This fork inlines exactly as upstream does, deletes only the definitions a
 * reference resolved to (the FIRST one per label, as CommonMark reads them),
 * and keeps every other definition as its own source text: a paragraph holding
 * one inline `html` node, the inert atom the schema already renders as literal
 * text and serializes verbatim. The next load reads it back as the same unused
 * definition, so it is a fixed point. Consecutive definitions stay one block,
 * one per line, rather than gaining a blank line between them.
 *
 * It runs AFTER the blank-line restore (`./emptyLine`), which counts gaps by
 * source line: upstream deleted the definition first, so its lines were counted
 * as blank and the first save grew empty paragraphs where it had been.
 *
 * A definition's source is its own text, except that one spanning lines inside
 * a container (a blockquote, a list item) would carry the container's prefix
 * on its continuation lines; those lines are joined onto one line with the
 * prefix dropped, which CommonMark reads as the same label, URL and title.
 */
export function inlineUsedLinkDefinitions(tree: MdastNode, source: string): void {
  const first = new Map<string, MdastNode>();
  walk(tree, (node) => {
    if (node.type === 'definition' && node.identifier && !first.has(node.identifier)) {
      first.set(node.identifier, node);
    }
  });
  const used = new Set<MdastNode>();
  walk(tree, (node, parent) => {
    if (node.type !== 'linkReference' && node.type !== 'imageReference') return;
    const definition = node.identifier ? first.get(node.identifier) : undefined;
    if (!definition || !parent?.children) return;
    used.add(definition);
    const index = parent.children.indexOf(node);
    parent.children[index] =
      node.type === 'imageReference'
        ? { type: 'image', url: definition.url, title: definition.title, alt: node.alt }
        : {
            type: 'link',
            url: definition.url,
            title: definition.title,
            children: node.children ?? [],
          };
  });
  walk(tree, (node) => {
    const children = node.children;
    if (!children?.some((child) => child.type === 'definition')) return;
    const kept: MdastNode[] = [];
    let run: { html: MdastNode; endLine: number } | null = null;
    for (const child of children) {
      if (child.type !== 'definition') {
        kept.push(child);
        run = null;
        continue;
      }
      const endLine = child.position?.end.line ?? -1;
      const adjacent = run !== null && child.position?.start.line === run.endLine + 1;
      if (!adjacent) run = null;
      if (!used.has(child)) {
        const text = definitionSource(child, source, node.type === 'root');
        if (run) {
          run.html.value = `${run.html.value ?? ''}\n${text}`;
        } else {
          const html: MdastNode = { type: 'html', value: text };
          kept.push({ type: 'paragraph', children: [html], position: child.position });
          run = { html, endLine };
          continue;
        }
      }
      if (run) run.endLine = endLine;
    }
    node.children = kept;
  });
}

/** The definition as the author wrote it (see {@link inlineUsedLinkDefinitions}). */
function definitionSource(definition: MdastNode, source: string, atRoot: boolean): string {
  const start = definition.position?.start.offset;
  const end = definition.position?.end.offset;
  if (start === undefined || end === undefined) return '';
  const text = source.slice(start, end);
  if (atRoot) return text;
  return text
    .split(/\r\n|\r|\n/)
    .map((line, index) => (index === 0 ? line : line.replace(/^[ \t>]*/, '')))
    .join(' ');
}

/**
 * The fork as a remark transformer, in place of the preset's
 * `remarkInlineLinkPlugin` (see `commonmarkWithCompat()` for the ordering).
 */
export const remarkInlineUsedLinkDefinitionsPlugin = $remark(
  'futo-inline-used-link-definitions',
  () => () => (tree: MdastNode, file: { value?: unknown }) => {
    inlineUsedLinkDefinitions(tree, String(file.value ?? ''));
  },
);
