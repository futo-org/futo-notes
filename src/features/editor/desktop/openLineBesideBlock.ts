/* A line opened after or before the code block whose code holds UTF-16 `at`, the caret on it
 * (portable-core/fenced-code.md `OpenLineAfterCodeBlock`, `OpenLineBeforeCodeBlock`): from a
 * press below a block, Down off it and Mod+Enter on it. */
import type { EditorView } from './view';

export function openLineBesideBlock(view: EditorView, at: number, before = false): void {
  const command = before ? 'OpenLineBeforeCodeBlock' : 'OpenLineAfterCodeBlock';
  view.run((engine) => engine.blockCommand({ start: at, end: at }, command));
}
