/* An input method's composition: the browser draws the marked text itself while the engine
 * is told what it holds, and the composed text is committed through the engine when the
 * composition ends, its lines then drawn back from the model. */
import type { DisplayRange } from '@futo-notes/editor/wasm-payloads';
import type { Engine } from './engine';
import { chunked, drawLine, holds } from './lineElements';
import type { EditorView } from './view';

export class EditorComposition {
  /** The text a composition replaces: the selection it began on, or what its first input names. */
  private composing: { range: DisplayRange; targeted: boolean } | null = null;

  constructor(
    private readonly view: EditorView,
    private readonly engine: () => Engine | null,
  ) {}

  active(): boolean {
    return this.composing !== null;
  }

  /** Forget a composition (another note opened). */
  reset(): void {
    this.composing = null;
  }

  start(): void {
    const selection = this.view.selection.sync();
    if (selection) this.composing = { range: selection, targeted: false };
  }

  /** The first composition input names the text it replaces (an accent picker replaces the
   *  character before the caret); later ones address the marked text itself. */
  target(event: InputEvent): void {
    if (!this.composing || this.composing.targeted) return;
    this.composing.targeted = true;
    const range = this.view.targetRange(event);
    if (range) this.composing.range = range;
  }

  update(text: string): void {
    const engine = this.engine();
    if (!this.composing || !engine) return;
    try {
      engine.compose(this.composing.range, text);
    } catch (error) {
      console.warn('composition refused:', error);
    }
  }

  /** Commit the composed text; false when no composition was going on. */
  end(text: string): boolean {
    const composing = this.composing;
    this.composing = null;
    if (!composing) return false;
    const view = this.view;
    const first = view.lineAt(composing.range.start);
    const last = view.lineAt(composing.range.end);
    view.run(
      (engine) =>
        engine.commitComposition(text) ??
        (text ? engine.replace(composing.range, text, 'Isolated') : null),
    );
    // The browser drew the marked text itself, merging lines when it replaced a selection
    // across them: draw the model's lines back over what it left.
    const lines = view.displayLines();
    const elements = view.lineElements();
    for (let index = first; index <= last && index < lines.length; index++) {
      drawLine(elements[index], lines[index]);
    }
    if (!holds(view.dom, elements)) view.dom.replaceChildren(...chunked(elements));
    return true;
  }
}
