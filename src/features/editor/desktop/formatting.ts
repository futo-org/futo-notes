/* The format commands, from the shortcuts (keys.ts) and the selection toolbar: an inline
 * format toggled on the selection or, at a caret, on what is typed next (the engine's carried
 * formats, which writes nothing and which a caret move drops), and a block command (a heading
 * level, a list, a quote) on the caret's or the selection's lines. And what the commands and the caret's flag read, all from
 * the engine: its active formats, at a caret and over a selection, and the commands that would
 * act there (its toolbar state's `allowed`), which gate the toggles and the Link prompt. */
import type { BlockCommand, InlineFormat, ToolbarCommand } from '@futo-notes/editor/wasm-payloads';
import { flagMarks, selectsText, type SelectedFormats } from './formats';
import type { EditorView } from './view';
import type { BlockFormats } from './blockButtons';
import type { Engine } from './engine';

/** The engine's formats over one selection of one revision. */
interface SelectionFormats {
  engine: Engine;
  revision: number;
  start: number;
  end: number;
  formats: readonly InlineFormat[];
  blocks: BlockFormats;
  allowed: readonly ToolbarCommand[];
}

/** The engine's formats and its one `toolbar_state` read at the selection. */
function formatsOf(engine: Engine): Omit<SelectedFormats, 'text'> {
  const { heading, heading_allowed, quote, quote_allowed, allowed } = engine.toolbarState();
  return {
    formats: engine.activeFormats(),
    blocks: { heading, headingAllowed: heading_allowed, quote, quoteAllowed: quote_allowed },
    allowed,
  };
}

export class EditorFormatting {
  /** The last selection's formats: the toolbar reads them on every frame it draws (a scroll
   *  included), and the engine walks the whole selection for them. */
  private selected: SelectionFormats | null = null;

  constructor(private readonly view: EditorView) {}

  /** What a format command acts on: at a caret the formats its next character takes, else
   *  the formats the selection has (a toggle turns those off). Null with no note open. */
  formats(): SelectedFormats | null {
    const view = this.view;
    const range = view.selection.range();
    const model = view.lineModel();
    const engine = view.currentEngine();
    if (!range || !model || !engine) return null;
    if (range.start === range.end) return { ...formatsOf(engine), text: false };
    const known = this.selected;
    const read =
      known?.engine === engine &&
      known.revision === engine.revision &&
      known.start === range.start &&
      known.end === range.end
        ? known
        : formatsOf(engine);
    const { formats, blocks, allowed } = read;
    this.selected = { engine, revision: engine.revision, ...range, formats, blocks, allowed };
    const text = selectsText(model.lines, model.lineAt(range.start), range.start, range.end);
    return { formats, text, blocks, allowed };
  }

  /** Toggle `format` where the selection is; nothing where the engine says it would change
   *  nothing (`allowed`). */
  toggle(format: InlineFormat): void {
    this.view.selection.sync();
    if (!this.allows(format)) return;
    this.view.run((engine) => engine.toggleFormat(format));
  }

  /** Whether `command` would act at the selection now (the engine's `allowed`). */
  allows(command: ToolbarCommand): boolean {
    return this.formats()?.allowed.includes(command) ?? false;
  }

  /** Run a block command (`{ Heading: 0 }` is body text) on the caret's or the selection's
   *  lines. */
  block(command: BlockCommand): void {
    const selection = this.view.selection.sync();
    if (selection) this.view.run((engine) => engine.blockCommand(selection, command));
  }

  /** The caret flag's marks: the caret's heading level and the formats its next character
   *  takes; none for a selection. */
  flag(): string[] {
    const range = this.view.selection.range();
    const model = this.view.lineModel();
    const engine = this.view.currentEngine();
    if (!range || !model || !engine || range.start !== range.end) return [];
    return flagMarks(engine.activeFormats(), model.lines[model.lineAt(range.start)].heading);
  }
}
