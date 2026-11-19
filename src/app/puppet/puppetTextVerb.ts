/* A verb on the desktop editor and its receipt: what it answered (`selected`, `wrote`) and the
 * editor's `state` once the page has drawn the next frame, where the editor paints what an
 * input changed (the caret, the selection's highlight, the selection toolbar). */
import type { EditorView } from '$features/editor/desktop/view';
import { afterNextFrame } from './puppetScroll';
import {
  isPuppetOutcome,
  ok,
  puppetVerb,
  type Args,
  type PuppetOutcome,
  type PuppetParams,
  type PuppetVerb,
} from './puppetRegistry';
import { mountedTextEditor, textEditorState } from './puppetTextEditorReads';

type TextAct = (
  view: EditorView,
  args: Args,
) => PuppetOutcome | Record<string, unknown> | void | Promise<PuppetOutcome | void>;

interface TextVerbOptions extends Pick<PuppetVerb, 'controlsMatching'> {
  convenience?: true;
  /** The verb is a key or a press in the note, which takes focus as a click does. */
  focuses?: boolean;
}

export type TextVerb = (
  name: string,
  params: PuppetParams,
  act: TextAct,
  options?: TextVerbOptions,
) => PuppetVerb;

export const textVerb: TextVerb = (name, params, act, options = {}) =>
  puppetVerb(
    name,
    params,
    async (args) => {
      const view = mountedTextEditor();
      if (isPuppetOutcome(view)) return view;
      if (options.focuses !== false && !view.hasFocus()) view.focus();
      const answer = await act(view, args);
      if (isPuppetOutcome(answer)) return answer;
      await afterNextFrame();
      return ok({
        ok: true,
        verb: name,
        ...(answer ?? {}),
        editor: textEditorState({ checked: false }),
      });
    },
    {
      ...(options.convenience && { convenience: true }),
      ...(options.controlsMatching && { controlsMatching: options.controlsMatching }),
    },
  );
