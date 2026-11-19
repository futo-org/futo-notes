import type { BlockCommand, InlineFormat } from '@futo-notes/editor/wasm-payloads';
import { isTabKey } from '$shared/dom/tabKey';

import type { Hit } from './hitTest';
import { arrowFromSelectedBlock, downOffNoteEndBlock } from './codeBlockKeys';
import { openLineBesideBlock } from './openLineBesideBlock';
import { selectImageBesideCaret } from './imageDeletion';
import { leaveTable } from './leaveTable';
import type { EditorView } from './view';

/** A format shortcut: an inline format to toggle, or a block command (a heading level, 0 for
 *  body text; a list; a quote). */
export type FormatShortcut = { format: InlineFormat } | { block: BlockCommand };

const ALT_BLOCKS: Record<string, BlockCommand> = { '7': 'OrderedList', '8': 'BulletList' };

/** The format shortcut `event` is: Mod+B, Mod+I, Mod+E, Mod+Alt+X, Mod+Alt+0…6 (body text and
 *  headings), Mod+Alt+7 (ordered list), Mod+Alt+8 (bullet list) and Mod+Shift+B (quote), Mod
 *  being Cmd on Apple and Ctrl elsewhere. Any other chord held with Shift is none, whatever
 *  Caps Lock does to its key, and so is an AltGr chord, which types a character. Option and
 *  Alt change the key's character (Option+X types ≈), so then the key's place names it. */
export function formatShortcut(event: KeyboardEvent, apple: boolean): FormatShortcut | null {
  const mod = apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!mod || event.isComposing || event.getModifierState('AltGraph')) return null;
  const key = /^[a-z0-9]$/i.test(event.key)
    ? event.key.toLowerCase()
    : /^(?:Key|Digit)([A-Z0-9])$/.exec(event.code)?.[1].toLowerCase();
  if (event.shiftKey) return !event.altKey && key === 'b' ? { block: 'Quote' } : null;
  if (!event.altKey) {
    const format = ({ b: 'Bold', i: 'Italic', e: 'Code' } as const)[key as 'b' | 'i' | 'e'];
    return format ? { format } : null;
  }
  if (key === 'x') return { format: 'Strike' };
  if (key !== undefined && /^[0-6]$/.test(key)) return { block: { Heading: Number(key) } };
  return key !== undefined && ALT_BLOCKS[key] ? { block: ALT_BLOCKS[key] } : null;
}

/** Undo (Mod+Z) or Redo (Shift+Mod+Z, and Ctrl+Y off Apple) that `event` is, or null. */
export function historyKey(event: KeyboardEvent, apple: boolean): 'undo' | 'redo' | null {
  const mod = apple ? event.metaKey : event.ctrlKey;
  const key = event.key.toLowerCase();
  if (!mod || event.altKey || (key !== 'z' && (key !== 'y' || event.metaKey))) return null;
  return key === 'y' || event.shiftKey ? 'redo' : 'undo';
}

/* The keys the editor answers itself, before the browser turns them into input: the format
 * and block shortcuts (`formatShortcut`), Undo and Redo, Left and Right between the two sides
 * of inline code's edge (caretSide.ts `step`), Up and Down (and Ctrl+P and Ctrl+N
 * on Apple), the row's start and end (Cmd+Left and Cmd+Right on Apple, Home and End
 * elsewhere) and on Apple deleting to them (Cmd+Backspace, Cmd+Delete), word motion (the
 * engine's words), Tab (Shift+Tab at a block's code start to its language field,
 * codeBlockHeader.ts), Mod+Enter, the arrows on a code block selected as one object
 * (codeBlockKeys.ts), Backspace at the note's start, Backspace and Delete (alone or a word's)
 * beside an image (imageDeletion.ts), and on Apple Ctrl+K,
 * Ctrl+T and Ctrl+Y. The moves that depend on the caret's row go through the pointer's
 * hit-test, which knows which row of a soft wrap the caret is on; the browser, whose
 * selection the editor writes, always takes the lower one. AppKit's kill and yank go through
 * WebKit's kill ring, which stays empty here: the edit WebKit would make goes to the engine
 * instead. So the editor keeps what Ctrl+K took, as AppKit does, consecutive kills added
 * together. */
export class EditorKeys {
  private killed = '';
  /** The x a run of Up and Down keeps, and where the last one left the caret. Any other
   *  key, a press or another note ends the run; so does a move that puts the caret
   *  elsewhere, and the next Up or Down starts from the caret's own x. */
  private goal: { x: number; at: number } | null = null;
  private killing = false;

  constructor(private readonly view: EditorView) {}

  keyDown(event: KeyboardEvent): void {
    // The `[[` list's and the `/` menu's keys come first: Enter and Tab accept before a list or
    // table takes them.
    if (this.view.completion.keyDown(event) || this.view.slashMenu.keyDown(event)) return;
    const apple = navigator.platform.startsWith('Mac');
    const mod = apple ? event.metaKey : event.ctrlKey;
    const key = event.key.toLowerCase();
    const killing = this.killing;
    this.killing = false;
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
    const appleCtrl = apple && event.ctrlKey && !event.metaKey && !event.altKey;
    // Up and Down, and AppKit's Ctrl+P and Ctrl+N: true for down.
    const vertical =
      plain && (event.key === 'ArrowUp' || event.key === 'ArrowDown')
        ? event.key === 'ArrowDown'
        : appleCtrl && !event.shiftKey && (key === 'p' || key === 'n')
          ? key === 'n'
          : null;
    const rowEdgeModifiers = apple
      ? event.metaKey && !event.altKey && !event.ctrlKey
      : !event.metaKey && !event.altKey && !event.ctrlKey;
    const [rowStartKey, rowEndKey] = apple ? ['ArrowLeft', 'ArrowRight'] : ['Home', 'End'];
    // Option on Apple, Ctrl elsewhere: a word's motion and deletion.
    const wordModifiers = apple
      ? event.altKey && !event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.altKey;
    const deletesForward =
      (plain || wordModifiers) &&
      !event.shiftKey &&
      !event.isComposing &&
      (event.key === 'Backspace' || event.key === 'Delete')
        ? event.key === 'Delete'
        : null;
    if (vertical === null) this.forgetColumn();
    const shortcut = formatShortcut(event, apple);
    const history = historyKey(event, apple);
    if (shortcut) {
      event.preventDefault();
      if ('format' in shortcut) this.view.formatting.toggle(shortcut.format);
      else this.view.formatting.block(shortcut.block);
    } else if (history) {
      event.preventDefault();
      this.view.run((engine) => (history === 'redo' ? engine.redo() : engine.undo()));
    } else if (mod && key === 'k' && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      this.view.linkPrompt.open();
    } else if (event.key === 'Enter' && mod && !event.altKey) {
      event.preventDefault();
      this.openLine(event.shiftKey);
    } else if (plain && !event.shiftKey && arrowFromSelectedBlock(this.view, event.key)) {
      event.preventDefault();
    } else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && wordModifiers) {
      event.preventDefault();
      this.wordMotion(event.key === 'ArrowRight', event.shiftKey);
    } else if (
      plain &&
      !event.shiftKey &&
      (event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
      this.view.caretSide.step(event.key === 'ArrowRight')
    ) {
      event.preventDefault();
    } else if (
      plain &&
      (event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
      this.besideAtom(event.key === 'ArrowRight', event.shiftKey)
    ) {
      event.preventDefault();
      const forward = event.key === 'ArrowRight';
      this.motion(forward, event.shiftKey, (from) => ({
        offset: this.atomStep(from, forward) ?? from,
        rowEnd: false,
      }));
    } else if (vertical !== null) {
      event.preventDefault();
      this.vertical(vertical, event.shiftKey);
    } else if (rowEdgeModifiers && (event.key === rowStartKey || event.key === rowEndKey)) {
      event.preventDefault();
      const toEnd = event.key === rowEndKey;
      this.motion(toEnd, event.shiftKey, (from, rowEnd) =>
        this.view.hitTest.rowEdge(from, rowEnd, toEnd),
      );
    } else if (apple && rowEdgeModifiers && (event.key === 'Backspace' || event.key === 'Delete')) {
      event.preventDefault();
      this.deleteToRowEdge(event.key === 'Delete');
    } else if (isTabKey(event) && !mod && !event.altKey) {
      event.preventDefault();
      if (event.shiftKey && this.view.codeHeader.focusLanguageFromCode()) return;
      const selection = this.view.selection.range();
      if (selection) {
        this.view.run((engine) =>
          engine.paragraphKey(selection, event.shiftKey ? 'ShiftTab' : 'Tab'),
        );
      }
    } else if (deletesForward !== null) {
      const selection = this.view.selection.sync();
      if (selection && selectImageBesideCaret(this.view, selection, deletesForward)) {
        event.preventDefault();
      } else if (plain && !deletesForward && selection?.end === 0) {
        // At the note's start the browser has nothing to delete and sends no input, but the
        // engine's Backspace can still take a list's marker or demote an empty heading.
        event.preventDefault();
        this.view.run((engine) => engine.paragraphKey(selection, 'PairedBackspace'));
      }
    } else if (appleCtrl && !event.shiftKey) {
      if (key === 'k') {
        event.preventDefault();
        this.kill(killing);
      } else if (key === 't') {
        // WebKit's own transpose selects the two characters first, so Undo would select them.
        event.preventDefault();
        const selection = this.view.selection.sync();
        if (selection) this.view.run((engine) => engine.paragraphKey(selection, 'Transpose'));
      } else if (key === 'y') {
        event.preventDefault();
        // Paste drops a copied text's last line ending (portable-core/clipboard.md); a kill
        // that took a line break keeps it.
        const killed = this.killed.endsWith('\n') ? `${this.killed}\n` : this.killed;
        if (killed) this.view.insert(killed);
      }
    }
  }

  /** Whether Left or Right (with `extend`, Shift) would step over an atom, which the editor
   *  steps itself: WebKit's own step from an item's text start does not reach the stop before
   *  its marker, and would go into an image's or a wikilink's spelling. */
  private besideAtom(forward: boolean, extend: boolean): boolean {
    const ends = this.view.selection.ends();
    if (!ends || (!extend && ends.anchor !== ends.focus)) return false;
    return this.atomStep(ends.focus, forward) !== null;
  }

  /** The other stop (UTF-16) of the atom a step from `from` goes over; null beside none. */
  private atomStep(from: number, forward: boolean): number | null {
    const line = this.view.displayLines()[this.view.lineAt(from)];
    const at = from - line.start;
    const atom = line.atoms.find((atom) => (forward ? atom.start : atom.end) === at);
    return atom ? line.start + (forward ? atom.end : atom.start) : null;
  }

  /** Option+Arrow (Ctrl+Arrow off Apple): to the engine's next word end or previous word
   *  start. */
  private wordMotion(forward: boolean, extend: boolean): void {
    this.motion(forward, extend, (from) => ({
      offset: this.view.wordStop(from, forward),
      rowEnd: false,
    }));
  }

  /** Move the caret to `stopAt` from it; with `extend` the selection's focus goes there from
   *  the focus and its anchor stays, and without it a selection collapses there from its
   *  edge on that side. `stopAt` is told whether the place it starts from is a row end. */
  private motion(
    forward: boolean,
    extend: boolean,
    stopAt: (from: number, rowEnd: boolean) => Hit,
  ): void {
    const view = this.view;
    view.selection.sync();
    const ends = view.selection.ends();
    if (!ends) return;
    const edge = forward ? Math.max(ends.anchor, ends.focus) : Math.min(ends.anchor, ends.focus);
    const from = extend ? ends.focus : edge;
    const stop = stopAt(from, view.selection.rowEnd() && from === ends.focus);
    view.selection.select(extend ? ends.anchor : stop.offset, stop.offset, stop);
  }

  forgetColumn(): void {
    this.goal = null;
  }

  /** Up and Down go a row by the pointer's hit-test, keeping the column through a run; Down
   *  off a code block that ends the note opens a line after it (codeBlockKeys.ts). */
  private vertical(down: boolean, extend: boolean): void {
    if (down && !extend && downOffNoteEndBlock(this.view)) return;
    this.motion(down, extend, (from, rowEnd) => {
      const goalX = this.goal?.at === from ? this.goal.x : null;
      const stop = this.view.hitTest.verticalStop(from, rowEnd, down, goalX);
      this.goal = { x: stop.x, at: stop.offset };
      return stop;
    });
  }

  /** Cmd+Backspace and Cmd+Delete: the selection, else to the caret's row start or end; at
   *  that edge already, one character, as AppKit does. */
  private deleteToRowEdge(forward: boolean): void {
    const view = this.view;
    const selection = view.selection.sync();
    if (!selection) return;
    if (selection.start !== selection.end) {
      return view.run((engine) => engine.replace(selection, '', 'Isolated'));
    }
    const stop = view.hitTest.rowEdge(selection.start, view.selection.rowEnd(), forward).offset;
    if (stop === selection.start) {
      return view.run((engine) =>
        engine.paragraphKey(selection, forward ? 'Delete' : 'PairedBackspace'),
      );
    }
    const range = forward
      ? { start: selection.start, end: stop }
      : { start: stop, end: selection.start };
    view.run((engine) => engine.replace(range, '', 'Isolated'));
  }

  /** Mod+Enter: Enter at the end of the caret's line, so the new line below takes the
   *  engine's Enter rules (a list item continues, a heading opens a paragraph). Shift+Mod+Enter:
   *  Enter at its start, then the caret onto the line that opened above. On a code block
   *  selected as one object, the engine opens the line after or before the block; in a table's
   *  cell, Mod+Enter leaves the table (leaveTable.ts). */
  private openLine(above: boolean): void {
    const view = this.view;
    const selection = view.selection.sync();
    if (!selection) return;
    const block = view.selection.selectedBlock();
    if (block) return openLineBesideBlock(view, block.start, above);
    if (!above && leaveTable(view)) return;
    const index = view.lineAt(above ? selection.start : selection.end);
    const line = view.displayLines()[index];
    const at = above ? line.start : line.start + line.text.length;
    const revision = view.revision();
    view.run((engine) => engine.paragraphKey({ start: at, end: at }, 'Enter'));
    if (!above || view.revision() === revision) return;
    const opened = view.displayLines()[index];
    view.selection.selectRange(
      opened.start + opened.text.length,
      opened.start + opened.text.length,
    );
  }

  /** Ctrl+K: the selection, else the rest of the line, else at its end the line break, which
   *  the engine's Delete takes as it joins the next line. */
  private kill(append: boolean): void {
    const view = this.view;
    const selection = view.selection.sync();
    if (!selection) return;
    const line = view.displayLines()[view.lineAt(selection.end)];
    const end = line.start + line.text.length;
    let taken = '\n';
    if (selection.start !== selection.end || selection.end < end) {
      const range = { start: selection.start, end: Math.max(selection.end, end) };
      view.run((engine) => {
        const [markdown, applied] = engine.cut(view.bytes(range));
        taken = markdown;
        return applied;
      });
    } else {
      const revision = view.revision();
      view.run((engine) => engine.paragraphKey(selection, 'Delete'));
      if (view.revision() === revision) return;
    }
    this.killed = append ? this.killed + taken : taken;
    this.killing = true;
  }
}
