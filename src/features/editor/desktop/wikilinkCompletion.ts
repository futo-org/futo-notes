/* Wikilink completion (portable-core/wikilinks.md "Completion"): after `[[` the notes whose id
 * holds what is typed since, the engine's run and candidates, in a list under the caret
 * (caretList.ts, dressed in desktopLinks.css). Up and Down
 * move, Enter or Tab accept before any list or table rule gets the key, Escape closes it and
 * keeps what was typed, until the caret leaves that run. Accepting is the engine's: `[[full/id]]` in place of the run (an `]]` after the caret included), the
 * caret after it, one Undo step. Read after every change the caret's frame draws, only on a line
 * with `[[` before the caret: one engine read of at most 512 bytes of that line, which a
 * wikilink being typed reads too (typedWikilink.ts). */
import type { WikilinkCompletion as Run } from '@futo-notes/editor/wasm-payloads';
import { puppetRefusal, puppetVerb, registerPuppetVerbs } from '$app/puppet/puppetRegistry';
import type { Engine } from './engine';
import type { EditorView } from './view';
import { CaretList } from './caretList';
import { atomElementsOf } from './atomElements';
import { wikilinkAround } from './lineLinks';

export class WikilinkCompletion {
  /** The run shown and the row highlighted; null with no list up. */
  private shown: { run: Run; selected: number } | null = null;
  /** The last run read and what it was read for, so a frame that changed nothing reads
   *  nothing. */
  private readFor: {
    engine: Engine;
    revision: number;
    start: number;
    end: number;
    run: Run | null;
  } | null = null;
  /** The run the list was last updated for. */
  private listedFor: Run | null | undefined;
  /** The run Escape closed, by where it starts: it stays closed while typed on. */
  private dismissed: { engine: Engine; start: number } | null = null;
  private readonly list = new CaretList({
    className: 'futo-wikilink-suggest',
    onPick: (index) => this.accept(index),
  });
  private readonly unregister: () => void;

  constructor(private readonly view: EditorView) {
    this.unregister = registerPuppetVerbs(() => {
      const shown = this.shown;
      if (!shown) return [];
      return [
        puppetVerb('PickLinkSuggestion', { noteId: 'string' }, (args) => {
          const index = this.shown?.run.candidates.findIndex((one) => one.note_id === args.noteId);
          if (index === undefined || index < 0) {
            const offered = shown.run.candidates.map((one) => one.note_id).join(', ');
            return puppetRefusal(409, `the list does not offer ${String(args.noteId)}: ${offered}`);
          }
          this.accept(index);
          return undefined;
        }),
      ];
    });
  }

  destroy(): void {
    this.unregister();
    this.close();
  }

  /** The open `[[` run at a caret (the engine's), read again only when the revision or the
   *  selection changed, and only on a line with `[[` before the caret; null for none. */
  run(): Run | null {
    const view = this.view;
    const engine = view.currentEngine();
    const model = view.lineModel();
    const range = view.selection.range();
    if (!engine || !model || !range || range.start !== range.end || view.isComposing()) {
      return null;
    }
    const bytes = view.selection.bytes();
    const known = this.readFor;
    if (
      known?.engine === engine &&
      known.revision === engine.revision &&
      known.start === bytes.start &&
      known.end === bytes.end
    ) {
      return known.run;
    }
    const line = model.lines[model.lineAt(range.start)];
    const at = range.start - line.start;
    const run =
      at >= 2 && line.text.lastIndexOf('[[', at - 2) >= 0 ? engine.wikilinkCompletion() : null;
    this.readFor = { engine, revision: engine.revision, ...bytes, run };
    return run;
  }

  /** Read the run at the caret again and show its list, or hide it. */
  update(): void {
    const view = this.view;
    const run = this.run();
    const engine = view.currentEngine();
    if (!run || !engine || document.activeElement !== view.dom) {
      this.dismissed = null;
      this.listedFor = undefined;
      return this.hide();
    }
    if (run === this.listedFor) return;
    this.listedFor = run;
    const dismissed = this.dismissed;
    if (dismissed?.engine !== engine || dismissed.start !== run.range.start) this.dismissed = null;
    if (this.dismissed || run.candidates.length === 0) return this.hide();
    const previous = this.shown?.run;
    const same = previous?.range.start === run.range.start && previous.query === run.query;
    const selected = same ? Math.min(this.shown!.selected, run.candidates.length - 1) : 0;
    this.show(run, selected);
  }

  /** The list's keys while it is up: true when `event` was one. */
  keyDown(event: KeyboardEvent): boolean {
    if (!this.shown || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) {
      return false;
    }
    this.update();
    const shown = this.shown;
    if (!shown) return false;
    const count = shown.run.candidates.length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const step = event.key === 'ArrowDown' ? 1 : -1;
      this.show(shown.run, (shown.selected + step + count) % count);
    } else if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
      this.accept(shown.selected);
    } else if (event.key === 'Escape') {
      this.dismissed = { engine: this.view.currentEngine()!, start: shown.run.range.start };
      this.hide();
    } else {
      return false;
    }
    event.preventDefault();
    return true;
  }

  /** Close the list, forgetting the run (another note opened). */
  close(): void {
    this.readFor = null;
    this.listedFor = undefined;
    this.dismissed = null;
    this.hide();
  }

  private accept(index: number): void {
    const shown = this.shown;
    const candidate = shown?.run.candidates[index];
    this.hide();
    if (!shown || !candidate) return;
    this.view.run((engine) => engine.acceptWikilinkCompletion(shown.run, candidate.note_id));
  }

  private show(run: Run, selected: number): void {
    const caret = this.caretBox();
    if (!caret) return this.hide();
    this.shown = { run, selected };
    this.list.show(run.candidates, selected, caret);
  }

  /** Where the caret draws, viewport px; inside a wikilink (an `]]` after the caret), where
   *  its text draws at no size, the wikilink's box. */
  private caretBox(): DOMRect | null {
    const view = this.view;
    const model = view.lineModel()!;
    const at = view.selection.range()!.start;
    const index = model.lineAt(at);
    const line = model.lines[index];
    const inside = wikilinkAround(line, at - line.start);
    if (!inside) return view.caretSide.clientRect(at);
    const atoms = atomElementsOf(view.lineElements()[index]);
    return atoms[line.atoms.indexOf(inside)]?.getBoundingClientRect() ?? null;
  }

  private hide(): void {
    this.shown = null;
    this.list.hide();
  }
}
