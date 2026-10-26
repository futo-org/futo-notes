/*
 * The keyboard's return key pressed while a word is still composing, on
 * Android's WebView (#277: "Enter after a lone composing word does nothing").
 *
 * On Chrome-Android ProseMirror never acts on an Enter keydown: it leaves the
 * key to the paragraph the browser makes and reads that back as an Enter
 * (prosemirror-view `readDOMChange`). Milkdown's input-rules plugin claims the
 * keydown instead, but only while nothing is composing. So with a composition
 * open, Enter depends entirely on the browser splitting the line — and when the
 * keydown carries no character, it does not: a keydown with keyCode 13, no
 * `beforeinput`, no DOM change, then the keyboard commits the word. The Enter
 * was simply lost.
 *
 * This keeps the pressed Enter on the books until the browser either splits the
 * line (an `insertParagraph`/`insertLineBreak` follows, and ProseMirror's own
 * path delivers it) or lets the key go by without one (its keyup). In the
 * second case the Enter is owed, and it is delivered as soon as the composition
 * has ended — never inside one, where a transaction can corrupt what the
 * keyboard is composing — through the same handler chain a typed Enter runs
 * (`replayAsEnter`), so a paragraph gets a newline, a list a new item, a heading
 * a paragraph after it (docs/spec/editor/paragraphs-and-lines.md).
 *
 * Android only: everywhere else a return key inside a composition confirms the
 * composition (a CJK candidate) and is not a newline. Never claims an event.
 */
import { browser } from '@milkdown/kit/prose';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';

import { replayAsEnter } from './keyboardParity';

/** An owed Enter older than this is dropped rather than landing somewhere unexpected. */
const OWED_ENTER_TTL_MS = 1000;

interface PendingEnter {
  /** `pressed` until the key's keyup; `owed` once the browser let it go by. */
  stage: 'pressed' | 'owed';
  at: number;
}

const pending = new WeakMap<EditorView, PendingEnter>();

const isReturnKey = (event: KeyboardEvent): boolean =>
  event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey;

/** Delivers an owed Enter once the composition is over (next task: after ProseMirror reads it). */
function deliverWhenComposed(view: EditorView): void {
  setTimeout(() => {
    const owed = pending.get(view);
    if (!owed || owed.stage !== 'owed' || view.isDestroyed || view.composing) return;
    pending.delete(view);
    if (Date.now() - owed.at > OWED_ENTER_TTL_MS || !view.editable) return;
    replayAsEnter(view);
  }, 0);
}

export const androidComposingEnter = $prose(
  () =>
    new Plugin({
      key: new PluginKey('FUTO_ANDROID_COMPOSING_ENTER'),
      props: {
        handleDOMEvents:
          browser.android && browser.chrome
            ? {
                keydown: (view, event) => {
                  if (!isReturnKey(event)) return false;
                  if (view.composing) pending.set(view, { stage: 'pressed', at: Date.now() });
                  else pending.delete(view);
                  return false;
                },
                beforeinput: (view, event) => {
                  const { inputType } = event as InputEvent;
                  if (inputType === 'insertParagraph' || inputType === 'insertLineBreak') {
                    pending.delete(view);
                  }
                  return false;
                },
                keyup: (view, event) => {
                  const pressed = pending.get(view);
                  if (!pressed || pressed.stage !== 'pressed' || !isReturnKey(event)) return false;
                  pressed.stage = 'owed';
                  if (!view.composing) deliverWhenComposed(view);
                  return false;
                },
                compositionend: (view) => {
                  if (pending.get(view)?.stage === 'owed') deliverWhenComposed(view);
                  return false;
                },
              }
            : {},
      },
    }),
);
