/* A wikilink being typed draws as typed (desktop/paired-typing.md): from when the engine's `[[`
 * completion run is open in it (`[[` pairs to `[[|]]`, and `[[R|]]` already reads as a wikilink)
 * until neither end of the selection is inside it, it is its source, brackets shown and no
 * label, and the caret stops at every character; then it is one unit again (wikilinkUnit.ts).
 * It is left out of its line's atoms, which everything that keeps the caret out of a wikilink
 * reads. Between the two `]` that step out of it no run is open, so it stays as typed while the
 * caret is inside it. */
import { drawLine } from './lineElements';
import type { WikilinkAtom } from './lineLinks';
import type { Line, LineModel } from './lineModel';
import type { EditorView } from './view';

interface Typed {
  line: Line;
  atom: WikilinkAtom;
}

export class TypedWikilink {
  private typed: Typed | null = null;

  constructor(private readonly view: EditorView) {}

  /** Another note opened: its lines are new. */
  forget(): void {
    this.typed = null;
  }

  /** Leave the wikilink being typed out of `lines`, a fresh reading of the note, as the page
   *  draws them: for checks that the page draws the engine's reading. */
  leaveOutOf(lines: readonly Line[]): void {
    const typed = this.typed;
    if (!typed) return;
    const start = typed.line.start + typed.atom.start;
    const line = [...lines].reverse().find((one) => one.start <= start);
    if (!line) return;
    line.atoms = line.atoms.filter(
      (atom) => atom.kind !== 'Wikilink' || line.start + atom.start !== start,
    );
  }

  /** After the selection or the text changed: draw the wikilink a run is open in as typed, and
   *  one the selection left as a unit again; true when a line was drawn again. */
  follow(): boolean {
    const view = this.view;
    const model = view.lineModel();
    const range = view.selection.range();
    if (!model || !range || view.isComposing()) return false;
    const run = view.completion.run();
    let next = run ? this.wikilinkAt(model, model.toUtf16(run.range.start)) : null;
    if (!run && this.typed) {
      const kept = this.wikilinkAt(model, this.typed.line.start + this.typed.atom.start);
      const inside = (offset: number): boolean =>
        !!kept &&
        kept.line.start + kept.atom.start < offset &&
        offset < kept.line.start + kept.atom.end;
      next = kept && (inside(range.start) || inside(range.end)) ? kept : null;
    }
    const before = this.typed;
    if (before?.atom === next?.atom) return false;
    this.typed = null;
    const restored = before ? this.restore(model, before.line) : false;
    // Read again: the line restored may be the one it is on.
    if (next) this.typed = this.wikilinkAt(model, next.line.start + next.atom.start);
    return (this.typed ? this.leaveOut(model, this.typed) : false) || restored;
  }

  /** The wikilink starting at UTF-16 display `start`: on its line, or the one left out of it. */
  private wikilinkAt(model: LineModel, start: number): Typed | null {
    const line = model.lines[model.lineAt(start)];
    const at = start - line.start;
    const atom = line.atoms.find((one) => one.kind === 'Wikilink' && one.start === at);
    if (atom?.kind === 'Wikilink') return { line, atom };
    const typed = this.typed;
    return typed?.line === line && typed.atom.start === at ? typed : null;
  }

  private leaveOut(model: LineModel, { line, atom }: Typed): boolean {
    if (!line.atoms.includes(atom)) return false;
    line.atoms = line.atoms.filter((one) => one !== atom);
    drawLine(this.view.lineElements()[model.lineAt(line.start)], line);
    return true;
  }

  /** Read `line` again from the engine, its wikilinks among its atoms, if no edit replaced it. */
  private restore(model: LineModel, line: Line): boolean {
    const engine = this.view.currentEngine();
    if (!engine || model.lines[model.lineAt(line.start)] !== line) return false;
    const restyled = model.describeLines([line], (range) => engine.project(range));
    if (!restyled) return false;
    const elements = this.view.lineElements();
    for (let index = restyled[0]; index < restyled[1]; index++) {
      drawLine(elements[index], model.lines[index]);
    }
    return true;
  }
}
