/**
 * The editor document as the serializer reads it: ProseMirror's `toJSON()`
 * shape, typed structurally so this package never imports `prosemirror-*` or
 * `@milkdown/*` (#266 story 33).
 *
 * The node and mark names are the shipping schema's: the commonmark and gfm
 * presets as `commonmarkWithCompat()`/`gfmWithCompat()` register them, the
 * front matter node (`../milkdown-compat/frontmatter.ts`) and the app's
 * wikilink node (`src/features/editor/milkdown/wikilink/node.ts`).
 */

export interface MarkJson {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
}

export interface NodeJson {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly content?: readonly NodeJson[];
  readonly marks?: readonly MarkJson[];
  readonly text?: string;
}

/** Markdown in, the editor's document (`doc.toJSON()`) out — the app's own parser. */
export type ParseMarkdown = (markdown: string) => NodeJson;

export const NODE = {
  doc: 'doc',
  paragraph: 'paragraph',
  heading: 'heading',
  text: 'text',
  hardbreak: 'hardbreak',
  blockquote: 'blockquote',
  codeBlock: 'code_block',
  hr: 'hr',
  image: 'image',
  html: 'html',
  bulletList: 'bullet_list',
  orderedList: 'ordered_list',
  listItem: 'list_item',
  table: 'table',
  tableHeaderRow: 'table_header_row',
  tableRow: 'table_row',
  tableHeader: 'table_header',
  tableCell: 'table_cell',
  frontmatter: 'frontmatter',
  footnoteDefinition: 'footnote_definition',
  footnoteReference: 'footnote_reference',
  wikilink: 'wikilink',
} as const;

export const MARK = {
  emphasis: 'emphasis',
  strong: 'strong',
  strike: 'strike_through',
  code: 'inlineCode',
  link: 'link',
} as const;

export function attr<T>(
  node: { readonly attrs?: Readonly<Record<string, unknown>> },
  name: string,
): T {
  return node.attrs?.[name] as T;
}

export function textOf(node: NodeJson): string {
  if (node.text !== undefined) return node.text;
  return (node.content ?? []).map(textOf).join('');
}

export function isEmptyParagraph(node: NodeJson): boolean {
  return node.type === NODE.paragraph && (node.content?.length ?? 0) === 0;
}

/** A node the serializer does not know. Thrown rather than skipped: skipping is content loss. */
export class UnknownNodeError extends Error {
  constructor(readonly nodeType: string) {
    super(`markdown serializer: no spelling for a '${nodeType}' node`);
    this.name = 'UnknownNodeError';
  }
}
