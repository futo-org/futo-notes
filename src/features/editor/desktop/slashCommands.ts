/* What picking a `/` menu item does. A block item (Text, a heading, a list, Quote, Code block,
 * Divider, Table) is one engine command that removes the typed `/query` and runs the block
 * command at the caret left, one Undo step. For Link and Image the engine removes the query, then
 * the Link prompt opens there, or the host's image picker does and the picked file is written as
 * a paste is (imageInput.ts); a cancelled prompt or picker leaves the query removed. The items
 * and their labels are the Milkdown menu's manifest (milkdown/slash/items.ts). */
import type { BlockCommand, DisplayRange } from '@futo-notes/editor/wasm-payloads';
import { SLASH_ITEMS, type SlashItem } from '../milkdown/slash/items';
import type { EditorView } from './view';

/** A picked item: its id, and for Image the files that answer its picker (Puppet). */
export interface SlashPick {
  id: string;
  imagePaths?: readonly string[];
}

const SLASH_BLOCK_COMMANDS: Record<string, BlockCommand> = {
  paragraph: { Heading: 0 },
  'heading-1': { Heading: 1 },
  'heading-2': { Heading: 2 },
  'heading-3': { Heading: 3 },
  'bullet-list': 'BulletList',
  'ordered-list': 'OrderedList',
  'task-list': 'TaskList',
  quote: 'Quote',
  'code-block': 'CodeBlock',
  divider: 'Divider',
  // A header row and two body rows of three columns, as the Milkdown menu's.
  table: { Table: { rows: 3, columns: 3 } },
};

const LINK_ITEM = 'link';
export const IMAGE_SLASH_ITEM = 'image';

/** The manifest's items this editor offers, in its order. */
export const DESKTOP_SLASH_ITEMS: SlashItem[] = SLASH_ITEMS.filter(
  (item) =>
    item.id in SLASH_BLOCK_COMMANDS || item.id === LINK_ITEM || item.id === IMAGE_SLASH_ITEM,
);

/** Do the picked item in place of the typed run `typed` (UTF-16 display range). */
export function runSlashItem(view: EditorView, typed: DisplayRange, pick: SlashPick): void {
  const command = SLASH_BLOCK_COMMANDS[pick.id];
  if (command) {
    view.run((engine) => engine.blockCommandRemoving(typed, command));
    return;
  }
  const revision = view.revision();
  view.run((engine) => engine.replace(typed, '', 'Isolated'));
  if (view.revision() === revision) return;
  if (pick.id === LINK_ITEM) view.linkPrompt.open();
  if (pick.id === IMAGE_SLASH_ITEM) view.imageInput.pick(pick.imagePaths);
}
