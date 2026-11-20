import type { TableOutcome } from '@futo-notes/editor/wasm-payloads';
import type { Engine } from './engine';
import type { EditorView } from './view';

/** Run a table input (`input`) against the engine and show what it did: its edit, or the
 *  selection it moved; false, with nothing done, when the engine answered null. */
export function applyTableOutcome(
  view: EditorView,
  input: (engine: Engine) => TableOutcome | null,
): boolean {
  let answered = false;
  view.run((engine) => {
    const outcome = input(engine);
    answered = outcome !== null;
    return outcome && 'edited' in outcome ? outcome.edited : null;
  });
  return answered;
}
