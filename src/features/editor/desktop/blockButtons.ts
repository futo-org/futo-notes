/* The selection toolbar's block buttons: Heading 1, 2 and 3 and Quote, taken from the shared
 * toolbar manifest (packages/editor/src/toolbar.ts) without its Text item (the owner's call),
 * each the engine's toggle: a lit heading level makes the lines text, a lit Quote takes a quote
 * level off (portable-core/block-commands.md). */
import { TOOLBAR_GROUPS, type ToolbarItem } from '@futo-notes/editor';
import type { BlockCommand } from '@futo-notes/editor/wasm-payloads';

/** What the selection's lines share, by the engine's rule (its `toolbar_state`): the heading
 *  level every touched line with text has (0 for text, null when they differ), whether a
 *  heading can apply to any of them, whether Quote takes a level off, and whether Quote can
 *  change any of them. */
export interface BlockFormats {
  heading: number | null;
  headingAllowed: boolean;
  quote: boolean;
  quoteAllowed: boolean;
}

export interface BlockButton {
  /** The manifest item's id (`heading-2`, `quote`). */
  id: string;
  command: BlockCommand;
  /** The selection's lines have it: pressing turns it off. */
  lit: boolean;
  /** It cannot apply to any of the selection's lines (a heading or Quote over only table
   *  lines). */
  disabled: boolean;
}

interface BlockItemRule {
  command: BlockCommand;
  isLit: (formats: BlockFormats) => boolean;
  isDisabled: (formats: BlockFormats) => boolean;
}

function headingRule(level: number): BlockItemRule {
  return {
    command: { ToggleHeading: level },
    isLit: (formats) => formats.heading === level,
    isDisabled: (formats) => !formats.headingAllowed,
  };
}

const BLOCK_COMMANDS: Record<string, BlockItemRule> = {
  'heading-1': headingRule(1),
  'heading-2': headingRule(2),
  'heading-3': headingRule(3),
  quote: {
    command: 'Quote',
    isLit: (formats) => formats.quote,
    isDisabled: (formats) => !formats.quoteAllowed,
  },
};

/** The toolbar's block items, in the manifest's order. */
export const BLOCK_ITEMS: readonly ToolbarItem[] = TOOLBAR_GROUPS.flat().filter(
  (item) => item.id in BLOCK_COMMANDS,
);

export function blockButtons(formats: BlockFormats): BlockButton[] {
  return BLOCK_ITEMS.map((item) => {
    const { command, isLit, isDisabled } = BLOCK_COMMANDS[item.id];
    return { id: item.id, command, lit: isLit(formats), disabled: isDisabled(formats) };
  });
}
