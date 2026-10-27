// The editor's verbs: everything an agent does to the open document, each the action a person
// takes, aimed only at what is on screen. Their receipts carry the editor's `state`, and the
// reads (`doc`, `show {"text"}`, `clipboard`) are puppetEditorReads.ts.
import { redo, undo } from '@milkdown/kit/prose/history';
import { NodeSelection, TextSelection, type Selection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { moveBlock, type BlockMoveRange } from '../../features/editor/milkdown/blockMove';
import { isTaskItem } from '../../features/editor/milkdown/caretContext';
import { findScroller, getFindState } from '../../features/editor/milkdown/find/findPlugin';
import { toggleTaskItem } from '../../features/editor/milkdown/taskCheckbox';
import { TOOLBAR_ITEMS } from '@futo-notes/editor';

import { clipboardAccess, editorState, requireView } from './puppetEditorReads';
import { fastWriteVerbs } from './puppetFastWrites';
import { afterNextFrame, scrollLanded, scrollTo } from './puppetScroll';
import { copySelection, parseChord, paste, pressKey, typeText } from './puppetInput';
import { type ModelLine } from './puppetLines';
import { linesOnScreen, noteLines, visibleBand } from './puppetNoteLines';
import {
  puppetProviders,
  puppetRefusal as refuse,
  editorOnScreen,
  isPuppetOutcome,
  ok,
  puppetVerb,
  type Args,
  type PuppetEditorProvider,
  type PuppetOutcome,
  type PuppetParams,
  type PuppetVerb,
} from './puppetRegistry';
import {
  type EditorAct,
  documentLineOrRefusal,
  lineOrRefusal,
  rangeFrom,
  rangeRefusal,
  showsLine,
  shownTextBetween,
  TEXT_PARAMS,
  whatShows,
} from './puppetText';

/** The floating selection toolbar's mark buttons, labelled outside the manifest. */
const SELECTION_TOOLBAR_MARKS = new Set(['bold', 'italic', 'strikethrough', 'code']);

/** The catalog keys of the buttons a toolbar command stands for, so their rows read `→ Verb`. */
function toolbarControls(commandId: string): string[] {
  const item = TOOLBAR_ITEMS.find((candidate) => candidate.id === commandId);
  return [
    ...(item ? [item.localizationPath] : []),
    ...(SELECTION_TOOLBAR_MARKS.has(commandId) ? [`editor.selectionToolbar.${commandId}`] : []),
  ];
}

function pascalCase(commandId: string): string {
  return commandId.replace(/(^|-)([a-z0-9])/g, (_, __, letter: string) => letter.toUpperCase());
}

/** Extra receipt fields a verb wants beside `{ok, verb, editor}` — what it wrote, where. */
type VerbReceipt = Record<string, unknown>;

export function editorVerb(
  name: string,
  params: PuppetParams,
  act: EditorAct,
  options: Pick<PuppetVerb, 'controls' | 'convenience'> = {},
): PuppetVerb {
  return puppetVerb(
    name,
    params,
    (args) => {
      const required = requireView();
      if (isPuppetOutcome(required)) return required;
      const outcome = act(required.view, required.editor, args);
      if (isPuppetOutcome(outcome)) return outcome;
      return ok({ ok: true, verb: name, ...(outcome ?? {}), editor: editorState() });
    },
    options,
  );
}

/**
 * The selection a click or a drag from `from` to `to` makes: a text range when both ends are
 * in a line, the node itself when the range is exactly one (a divider, an image), and
 * otherwise the nearest text range ProseMirror can hold.
 */
function selectionFor(view: EditorView, from: number, to: number): Selection {
  const { doc } = view.state;
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);
  if ($from.parent.inlineContent && $to.parent.inlineContent) {
    return TextSelection.create(doc, from, to);
  }
  const node = doc.nodeAt(from);
  if (node && from + node.nodeSize === to && NodeSelection.isSelectable(node)) {
    return NodeSelection.create(doc, from);
  }
  return TextSelection.between($from, $to);
}

/**
 * Selection is the argument every formatting verb reads, so it gets one verb of its own.
 * Positions are ProseMirror's own, as `doc` prints them; `expect` and `docVersion` let the
 * agent prove they still mean what it thinks, and `find` skips the arithmetic altogether.
 * Selecting is a click or a drag, so it focuses the editor as one does.
 */
function selectAt(
  view: EditorView,
  _editor: PuppetEditorProvider,
  args: Args,
): PuppetOutcome | VerbReceipt {
  const range = rangeFrom(view, args, 'Select');
  if (isPuppetOutcome(range)) return range;
  if (range.from === range.to && !view.state.doc.resolve(range.from).parent.inlineContent) {
    return refuse(
      400,
      `position ${range.from} is between blocks, where no caret goes: a line's caret positions run from its "at" to its "end" in \`doc\``,
    );
  }
  const selection = selectionFor(view, range.from, range.to);
  view.dispatch(view.state.tr.setSelection(selection).scrollIntoView());
  view.focus();
  const note = noteLines(view.state.doc);
  return {
    selected: {
      from: selection.from,
      to: selection.to,
      text: shownTextBetween(note, linesOnScreen(view, note), selection.from, selection.to),
    },
  };
}

/**
 * What the drag handle picks up for a line: the top-level block it is in, so a whole list
 * for any of its items (editor.md, block drag).
 */
function topLevelBlock(view: EditorView, entry: ModelLine): BlockMoveRange {
  const at = view.state.doc.resolve(entry.at);
  if (at.depth > 0) return { from: at.before(1), to: at.after(1) };
  return { from: entry.at, to: entry.at + (view.state.doc.nodeAt(entry.at)?.nodeSize ?? 0) };
}

/**
 * The rendered checkbox is a control a finger lands on: what its click does, through the same
 * handler (taskCheckbox.ts `toggleTaskItem`). The box rides its item's first line, so a line
 * below it in the item, or in a list nested in it, has none.
 */
function toggleTask(
  view: EditorView,
  _editor: PuppetEditorProvider,
  args: Args,
): PuppetOutcome | void {
  const entry = lineOrRefusal(view, args.line as number);
  if (isPuppetOutcome(entry)) return entry;
  const $line = view.state.doc.resolve(entry.at);
  const boxed =
    entry.segment === 0 && $line.depth > 1 && $line.index(-1) === 0 && isTaskItem($line.node(-1));
  if (!boxed || !toggleTaskItem(view, entry.at)) {
    return refuse(409, `line ${entry.line} is not a task (${entry.kind}): ${entry.text}`);
  }
}

/**
 * Scrolling the note until a line shows, in one call: the way to a line an off-screen refusal
 * names, as ScrollToRow is to a row. The line's own place is centred in the band a person
 * sees, the coordinates `onScreen` is judged by, so a line deep in a code block or under a
 * Find bar arrives too. Not input a person produces, so a convenience.
 */
function scrollToLineVerb(): PuppetVerb {
  return puppetVerb(
    'ScrollToLine',
    { line: 'integer' },
    (args) => {
      const required = requireView();
      if (isPuppetOutcome(required)) return required;
      const { view } = required;
      const entry = documentLineOrRefusal(view, args.line as number);
      if (isPuppetOutcome(entry)) return entry;
      const band = visibleBand(view);
      const scroller = findScroller(view);
      if (!band || !scroller) return refuse(409, 'no part of the note is on screen to scroll');
      const before = scroller.scrollTop;
      const { top, bottom } = view.coordsAtPos(entry.at);
      scrollTo(scroller, 0, before + (top + bottom - band.top - band.bottom) / 2);
      return settledShowing(view, entry.line, scroller.scrollTop !== before ? scroller : null);
    },
    { convenience: true },
  );
}

/**
 * Refused unless `line` shows once the scroll has landed and the page has drawn a frame: by
 * then a resize's caret reveal (editor-embed/main.ts) has run, and on iOS the offset WebKit
 * keeps for the scroller has caught up. Checked at once, the line showed and the view moved on.
 */
async function settledShowing(
  view: EditorView,
  line: number,
  scrolled: Element | null,
): Promise<PuppetOutcome | undefined> {
  if (scrolled) await scrollLanded(scrolled);
  await afterNextFrame();
  const onScreen = linesOnScreen(view, noteLines(view.state.doc));
  return showsLine(onScreen, line)
    ? undefined
    : refuse(409, `line ${line} does not come on screen (${whatShows(onScreen)})`);
}

export function editorVerbs(): PuppetVerb[] {
  const editor = puppetProviders.editor;
  // The editor stays mounted behind the home screen, so a live view is not a visible one:
  // on `home` the menu offered Bold, Insert and Paste for a document nobody was looking at.
  // `actions` is what a user could do now, so the editor's verbs need the editor on screen.
  if (!editor || !editorOnScreen()) return [];
  return [
    editorVerb(
      'Select',
      {
        from: 'integer?',
        to: 'integer?',
        find: 'string?',
        expect: 'string?',
        docVersion: 'integer?',
      },
      selectAt,
    ),
    editorVerb('PlaceCaret', { at: 'integer', docVersion: 'integer?' }, (view, provider, args) =>
      selectAt(view, provider, { from: args.at, to: args.at, docVersion: args.docVersion }),
    ),
    // Copy, Cut and Paste are the browser's clipboard events, so the editor's own copy
    // serializer and paste pipeline decide what is taken and what lands. The clipboard is
    // the agent's own, never the OS one, which belongs to the person at this machine.
    ...(['Copy', 'Cut'] as const).map((name) =>
      editorVerb(name, {}, (view) => {
        const content = copySelection(view, name === 'Cut');
        if (!content) return refuse(409, 'nothing is selected: Select a range first');
        clipboardAccess.copied(content);
        return undefined;
      }),
    ),
    editorVerb('Paste', {}, (view) => {
      const content = clipboardAccess.content();
      if (content === null) return refuse(409, 'the clipboard is empty: Copy first');
      paste(view, content);
      return undefined;
    }),
    // Typing, as the person at the keyboard does it: each character a key press, offered to
    // the keymaps and then to the input rules (`# ` makes a heading, `[[` opens the link
    // suggestions); a newline is the Enter key, so a list item continues and a paragraph
    // splits. What the editor makes of the keystrokes is the document — read it back.
    editorVerb('Type', TEXT_PARAMS, (view, _editor, args) => {
      typeText(view, args.text as string, clipboardAccess);
      return undefined;
    }),
    // `count` times, as `press` on a phone takes it: a run of Backspaces is one call.
    editorVerb('Press', { key: 'string', count: 'integer?' }, (view, _editor, args) => {
      const chord = parseChord(args.key as string);
      if (typeof chord === 'string') return refuse(400, `Press: ${chord}`);
      const count = (args.count as number | undefined) ?? 1;
      if (count < 1) return refuse(400, `Press: "count" is how many times, from 1, not ${count}`);
      for (let pressed = 0; pressed < count; pressed++) pressKey(view, chord, clipboardAccess);
      return undefined;
    }),
    editorVerb('ToggleTask', { line: 'integer' }, toggleTask),
    // Dragging a block by its handle (desktop) or a long press (phones): both drop through
    // the one move (blockMove.ts), so this drops through it too. The hand picks up a block on
    // screen; the drag's autoscroll takes it to a target anywhere in the note.
    editorVerb(
      'MoveBlock',
      { line: 'integer', before: 'integer?', after: 'integer?' },
      (view, _editor, args) => {
        const entry = lineOrRefusal(view, args.line as number);
        if (isPuppetOutcome(entry)) return entry;
        const before = args.before as number | undefined;
        const after = args.after as number | undefined;
        if ((before === undefined) === (after === undefined)) {
          return refuse(400, 'MoveBlock needs one of {"before":<line>} or {"after":<line>}');
        }
        const target = documentLineOrRefusal(view, (before ?? after) as number);
        if (isPuppetOutcome(target)) return target;
        const beside = topLevelBlock(view, target);
        if (
          !moveBlock(
            view,
            topLevelBlock(view, entry),
            before !== undefined ? beside.from : beside.to,
          )
        ) {
          return refuse(
            409,
            `line ${entry.line}'s block cannot be dropped ${before !== undefined ? 'before' : 'after'} line ${target.line}: it is already there (a list moves whole, so its own lines are no target), or it cannot go there`,
          );
        }
        return undefined;
      },
    ),
    // A click on a link or a wikilink chip: the editor's own link activation, which opens
    // the note (a new tab with `newTab`, as a middle or Cmd click does) or the URL.
    editorVerb(
      'OpenLink',
      { at: 'integer?', find: 'string?', newTab: 'boolean?' },
      (view, provider, args) => {
        let at = args.at as number | undefined;
        if (typeof args.find === 'string') {
          const range = rangeFrom(view, { find: args.find }, 'OpenLink');
          if (isPuppetOutcome(range)) return range;
          at = range.from;
        } else if (at === undefined) {
          return refuse(
            400,
            'OpenLink needs {"at":<position of the link>} or {"find":"<its text>"}',
          );
        } else {
          const refusal = rangeRefusal(view, at, at, {});
          if (refusal) return refusal;
        }
        if (!provider.openLinkAt(at, args.newTab === true)) {
          return refuse(
            409,
            `no link or wikilink at position ${at}: \`doc {"line":N}\` lists each run's position`,
          );
        }
        return undefined;
      },
    ),
    ...(editor.insertImage
      ? [
          // The `/` menu's Image item opens the file picker; this is that picker returning
          // `path`. Saving the file into the vault takes a moment, so the receipt waits for it.
          puppetVerb('InsertImage', { path: 'string' }, async (args) => {
            await editor.insertImage?.(args.path as string);
            return ok({ ok: true, verb: 'InsertImage', editor: editorState() });
          }),
        ]
      : []),
    ...fastWriteVerbs(editorVerb),
    scrollToLineVerb(),
    editorVerb(
      'Undo',
      {},
      (view) => (undo(view.state, view.dispatch) ? undefined : refuse(409, 'nothing to undo')),
      { controls: toolbarControls('undo') },
    ),
    editorVerb(
      'Redo',
      {},
      (view) => (redo(view.state, view.dispatch) ? undefined : refuse(409, 'nothing to redo')),
      { controls: toolbarControls('redo') },
    ),
    ...editor.execIds().map((commandId) =>
      editorVerb(
        pascalCase(commandId),
        {},
        (_view, provider) => {
          provider.exec(commandId);
        },
        { controls: toolbarControls(commandId) },
      ),
    ),
    // Find's bar is the shell's on desktop (FindPanel.svelte registers its own verbs while it
    // is open); the phones' bars are native and register these names themselves.
    ...(puppetProviders.shell !== null && !getFindState(editor.getView()!.state).open
      ? [editorVerb('OpenFind', {}, (_view, provider) => provider.openFind())]
      : []),
  ];
}
