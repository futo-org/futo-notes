/* An outside change the host's save offered (attachedNote.ts), adopted into the note the
 * view shows as one edit the user did not make. */
import type { Applied } from '@futo-notes/editor/wasm-payloads';
import type { AdoptionRefusal, Engine } from './engine';
import type { EditorView } from './view';

export interface Offer {
  view: Pick<EditorView, 'currentEngine' | 'showOutsideEdit'>;
  engine: Pick<Engine, 'adoptOutsideSource'>;
  source: string;
}

/** The adoption to send to the host, or why there is none. A view showing another
 *  engine (a switch under way) adopts nothing yet. */
export function takeOffer({ view, engine, source }: Offer): Applied | AdoptionRefusal {
  if (view.currentEngine() !== engine) return 'later';
  const adopted = engine.adoptOutsideSource(source);
  if (typeof adopted !== 'string') view.showOutsideEdit(adopted);
  return adopted;
}
