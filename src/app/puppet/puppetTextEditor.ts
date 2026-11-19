/* Puppet's verbs on the desktop editor (features/editor/desktop): the same names as the other
 * editors' verbs, addressed in engine display offsets (UTF-16) or by text (puppetTextAnchors.ts).
 * Text and keys arrive as the browser delivers them, `beforeinput` and `keydown`, and a press
 * on a control (a task's box, a link) as the mouse's events on it, so each takes the editor's
 * own path; caret moves are the editor's own or the browser's, which the editor hands the
 * engine. Reads are puppetTextEditorReads.ts. */
import { TASK_BOX_CLASS } from '$features/editor/desktop/atomElements';
import { LINK_CLASS } from '$features/editor/desktop/lineLinks';
import { scrollerOf } from '$features/editor/desktop/paneScroll';
import type { EditorView } from '$features/editor/desktop/view';
import { WIKILINK_CLASS } from '$features/editor/desktop/wikilinkElements';
import { clipboardAccess } from './puppetClipboard';
import { dropFilesVerb } from './puppetFileDrop';
import { copySelection, paste, parseChord } from './puppetInput';
import {
  editorOnScreen,
  isPuppetOutcome,
  puppetProviders,
  puppetRefusal as refuse,
  puppetVerb,
  type PuppetOutcome,
  type PuppetVerb,
} from './puppetRegistry';
import { afterNextFrame, scrollLanded, scrollTo } from './puppetScroll';
import { showsLine, TEXT_PARAMS, whatShows } from './puppetText';
import {
  textLineInNote,
  textLineOnScreen,
  textRangeFrom,
  textRangeRefusal,
} from './puppetTextAnchors';
import { mountedTextEditor, displayTextBetween } from './puppetTextEditorReads';
import { textFastWriteVerbs } from './puppetTextFastWrites';
import { pressTextKey, textInput } from './puppetTextKeys';
import { textLinesOnScreen } from './puppetTextLines';
import { textVerb } from './puppetTextVerb';

/** The mouse's press, release and click on `element`, as a click on it delivers them. */
function clickOn(element: Element, button: 0 | 1): void {
  const box = element.getBoundingClientRect();
  const init = {
    bubbles: true,
    cancelable: true,
    button,
    detail: 1,
    clientX: box.left + box.width / 2,
    clientY: box.top + box.height / 2,
  };
  element.dispatchEvent(new MouseEvent('mousedown', init));
  element.dispatchEvent(new MouseEvent('mouseup', init));
  if (button === 0) element.dispatchEvent(new MouseEvent('click', init));
}

/** The checkbox drawn on line `number`, a task's first line, on screen. */
function taskBoxOf(view: EditorView, number: number): Element | PuppetOutcome {
  const line = textLineOnScreen(view, number);
  if (isPuppetOutcome(line)) return line;
  const box = view.lineElements()[number - 1].querySelector(`.${TASK_BOX_CLASS}`);
  if (!box || !line.list?.first || line.list.checked === null) {
    return refuse(409, `line ${number} is not a task's first line: ${line.text}`);
  }
  return box;
}

/** The link or wikilink drawn over display offset `at`. */
function linkElementAt(view: EditorView, at: number): Element | null {
  const element = view.lineElements()[view.lineAt(at)];
  for (const link of element?.querySelectorAll(`.${LINK_CLASS}, .${WIKILINK_CLASS}`) ?? []) {
    const start = view.offsetOf(link, 0);
    const end = view.offsetOf(link, link.childNodes.length);
    if (start <= at && (at < end || at === start)) return link;
  }
  return null;
}

/** Scroll the note until line `number` is in the middle of the pane, as a wheel would. */
async function scrollToLine(view: EditorView, number: number): Promise<PuppetOutcome | void> {
  const line = textLineInNote(view, number);
  if (isPuppetOutcome(line)) return line;
  const scroller = scrollerOf(view.dom);
  const pane = scroller.getBoundingClientRect();
  const band = { top: Math.max(pane.top, 0), bottom: Math.min(pane.bottom, innerHeight) };
  const box = view.lineElements()[number - 1].getBoundingClientRect();
  const before = scroller.scrollTop;
  scrollTo(
    scroller,
    scroller.scrollLeft,
    before + (box.top + box.bottom - band.top - band.bottom) / 2,
  );
  if (scroller.scrollTop !== before) await scrollLanded(scroller);
  await afterNextFrame();
  const onScreen = textLinesOnScreen(view);
  if (!showsLine(onScreen, number)) {
    return refuse(409, `line ${number} does not come on screen (${whatShows(onScreen)})`);
  }
}

/** Undo or Redo through the browser's history input. With nothing to undo it does nothing, as
 *  the key does, and the receipt says so (no `doc` change). */
function historyVerb(name: 'Undo' | 'Redo'): PuppetVerb {
  return textVerb(name, {}, (view) => {
    textInput(view, name === 'Undo' ? 'historyUndo' : 'historyRedo');
    return undefined;
  });
}

export function textEditorVerbs(): PuppetVerb[] {
  if (!puppetProviders.textEditor || !editorOnScreen()) return [];
  return [
    // Each character a keystroke; a newline is Enter.
    textVerb('Type', TEXT_PARAMS, (view, args) => {
      for (const character of args.text as string) {
        if (character === '\n') textInput(view, 'insertParagraph');
        else textInput(view, 'insertText', character);
      }
    }),
    textVerb('Press', { key: 'string', count: 'integer?' }, (view, args) => {
      const chord = parseChord(args.key as string);
      if (typeof chord === 'string') return refuse(400, `Press: ${chord}`);
      const count = (args.count as number | undefined) ?? 1;
      if (count < 1) return refuse(400, `Press: "count" is how many times, from 1, not ${count}`);
      for (let pressed = 0; pressed < count; pressed++) pressTextKey(view, chord);
      return undefined;
    }),
    // A click or a drag from `from` to `to`: the engine's selection, the editor focused.
    textVerb(
      'Select',
      {
        from: 'integer?',
        to: 'integer?',
        find: 'string?',
        expect: 'string?',
        docVersion: 'integer?',
      },
      (view, args) => {
        const range = textRangeFrom(view, args, 'Select');
        if (isPuppetOutcome(range)) return range;
        view.selection.selectRange(range.from, range.to);
        const selected = view.selection.range();
        return {
          selected: selected && {
            from: selected.start,
            to: selected.end,
            text: displayTextBetween(view, selected.start, selected.end),
          },
        };
      },
    ),
    textVerb('PlaceCaret', { at: 'integer', docVersion: 'integer?' }, (view, args) => {
      const at = args.at as number;
      const refusal = textRangeRefusal(view, { from: at, to: at }, args);
      if (refusal) return refusal;
      view.selection.selectRange(at, at);
      return undefined;
    }),
    // The agent's clipboard (`clipboard {"text","html"?}`), never the OS one, pasted as the
    // browser pastes: Edit > Paste carries every form, Paste and Match Style (⇧⌘V) only the
    // plain text, as WebKit's `pasteAsPlainText:` does.
    ...(['Paste', 'PasteAndMatchStyle'] as const).map((name) =>
      textVerb(name, {}, (view) => {
        const content = clipboardAccess.content();
        if (content === null)
          return refuse(409, 'the clipboard is empty: fill it with `clipboard`');
        paste(view, name === 'Paste' ? content : { text: content.text, html: '' });
        return undefined;
      }),
    ),
    dropFilesVerb(),
    // The browser's copy and cut events, so the editor's own copy decides what is taken.
    ...(['Copy', 'Cut'] as const).map((name) =>
      textVerb(name, {}, (view) => {
        const content = copySelection(view, name === 'Cut');
        if (!content) return refuse(409, 'nothing is selected: Select a range first');
        clipboardAccess.copied(content);
        return undefined;
      }),
    ),
    historyVerb('Undo'),
    historyVerb('Redo'),
    // A click on a task's checkbox.
    textVerb(
      'ToggleTask',
      { line: 'integer' },
      (view, args) => {
        const box = taskBoxOf(view, args.line as number);
        if (isPuppetOutcome(box)) return box;
        clickOn(box, 0);
        return undefined;
      },
      { focuses: false, controlsMatching: `.${TASK_BOX_CLASS}` },
    ),
    // A click on a link or a wikilink: opens the note or the page; `newTab` is a middle click.
    textVerb(
      'OpenLink',
      { at: 'integer?', find: 'string?', newTab: 'boolean?' },
      (view, args) => {
        if (typeof args.at !== 'number' && typeof args.find !== 'string') {
          return refuse(400, 'OpenLink needs {"at":<offset of the link>} or {"find":"<its text>"}');
        }
        const range =
          typeof args.at === 'number'
            ? (textRangeRefusal(view, { from: args.at, to: args.at }, {}) ?? {
                from: args.at,
                to: args.at,
              })
            : textRangeFrom(view, { find: args.find }, 'OpenLink');
        if (isPuppetOutcome(range)) return range;
        const link = linkElementAt(view, range.from);
        if (!link) {
          return refuse(
            409,
            `no link or wikilink at ${range.from}: \`doc {"line":N}\` lists each link's position`,
          );
        }
        clickOn(link, args.newTab === true ? 1 : 0);
        return undefined;
      },
      { focuses: false },
    ),
    ...textFastWriteVerbs(textVerb),
    // A scroll wheel's work in one call: the way to a line an off-screen refusal names.
    textVerb(
      'ScrollToLine',
      { line: 'integer' },
      (view, args) => scrollToLine(view, args.line as number),
      { convenience: true, focuses: false },
    ),
    // Ctrl/Cmd+F; the shell's find bar registers its own verbs once open (FindPanel.svelte).
    ...(puppetProviders.textEditor.view()?.find.isOpen()
      ? []
      : [
          puppetVerb('OpenFind', {}, () => {
            const view = mountedTextEditor();
            if (isPuppetOutcome(view)) return view;
            view.find.open();
            return undefined;
          }),
        ]),
  ];
}
