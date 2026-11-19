import type { DisplayRange, ProjectionSlice, ViewChange } from '@futo-notes/editor/wasm-payloads';
import type { Line, LineModel, LineSplice } from './lineModel';
import { drawLine, redraw } from './lineElements';

/** The engine's answer to one input, in order, and what the page shows it in. */
export interface ViewChanges {
  /** One element per line of `model`, spliced in place. */
  elements: HTMLElement[];
  model: LineModel;
  changes: readonly ViewChange[];
  /** The engine's reading of display bytes, at its current revision. */
  project: (range: DisplayRange) => ProjectionSlice;
  /** Each splice, after `model` took it and before its lines are drawn. */
  onSpliced?: (splice: LineSplice) => void;
}

/** Show `changes` in `model` and `elements`: no line keeps a guessed description. The lines a
 *  change's projection missed are read from the engine once all are applied, as `project`
 *  reads only the engine's current revision. */
export function applyViewChanges({
  elements,
  model,
  changes,
  project,
  onSpliced,
}: ViewChanges): void {
  const guessed: Line[] = [];
  for (const change of changes) {
    const splice = model.splice(change);
    onSpliced?.(splice);
    redraw(elements, model, splice);
    guessed.push(...splice.guessed);
  }
  if (guessed.length === 0) return;
  const described = model.describeLines(guessed, project);
  if (!described) return;
  for (let index = described[0]; index < described[1]; index++) {
    drawLine(elements[index], model.lines[index]);
  }
}
