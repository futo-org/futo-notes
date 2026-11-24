/* The `/` menu (docs/spec/editor/desktop/slash-menu.md): a `/` at a line's start (slashRun.ts)
 * lists the items its query matches (slashItems.ts's ranking, `filterSlashItems`) in a list
 * at the caret (caretList.ts); none matching hides it. Up and Down move, Enter or Tab pick
 * before any list or table rule gets the key, a press picks, Escape closes it and keeps what was
 * typed while that `/` stays. Read on the caret's frame: the caret's line up to the caret, no
 * layout, unless the run or its query changed; one caret box to place the list. */
import { localizedText } from '$shared/localization';
import { puppetRefusal, puppetVerb, registerPuppetVerbs } from '$app/puppet/puppetRegistry';
import { filterSlashItems, type SlashItem } from './slashItems';
import { CaretList } from './caretList';
import type { Engine } from './engine';
import { DESKTOP_SLASH_ITEMS, IMAGE_SLASH_ITEM, runSlashItem } from './slashCommands';
import { slashRunAt } from './slashRun';
import type { EditorView } from './view';

/** An open run in UTF-16 display offsets: its `/`, the caret, and the items its query matches. */
interface OpenSlashRun {
  slash: number;
  caret: number;
  query: string;
  items: SlashItem[];
}

export class SlashMenu {
  private shown: { run: OpenSlashRun; selected: number } | null = null;
  /** The last run read and what for, so a frame that changed nothing reads nothing. */
  private readFor: {
    engine: Engine;
    revision: number;
    caret: number;
    run: OpenSlashRun | null;
  } | null = null;
  private listedFor: OpenSlashRun | null | undefined;
  /** The run Escape closed, by its `/`: it stays closed while typed on. */
  private dismissed: { engine: Engine; slash: number } | null = null;
  private readonly list = new CaretList({
    className: 'desktop-slash-menu',
    name: localizedText('editor.slashMenu.heading'),
    onPick: (index) => this.pick(index),
  });
  private readonly unregister: () => void;

  constructor(private readonly view: EditorView) {
    this.unregister = registerPuppetVerbs(() => {
      const shown = this.shown;
      if (!shown) return [];
      const ids = shown.run.items.map((item) => item.id);
      const item = ids.length > 1 ? (ids.join('|') as `${string}|${string}`) : 'string';
      return [
        // Image's picker is the OS's, so the verb takes the file it would return.
        puppetVerb('PickSlashItem', { item, path: 'string?' }, (args) => {
          const index = this.shown?.run.items.findIndex((one) => one.id === args.item);
          if (index === undefined || index < 0) {
            return puppetRefusal(
              409,
              `the menu does not offer ${String(args.item)}: ${ids.join(', ')}`,
            );
          }
          const path = args.path as string | undefined;
          if (args.item === IMAGE_SLASH_ITEM && path === undefined) {
            return puppetRefusal(400, 'PickSlashItem image needs {"path":"<the picked file>"}');
          }
          this.pick(index, path === undefined ? undefined : [path]);
          return undefined;
        }),
      ];
    });
  }

  destroy(): void {
    this.unregister();
    this.close();
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
    if (dismissed?.engine !== engine || dismissed.slash !== run.slash) this.dismissed = null;
    if (this.dismissed || run.items.length === 0) return this.hide();
    const previous = this.shown?.run;
    const same = previous?.slash === run.slash && previous.query === run.query;
    this.show(run, same ? Math.min(this.shown!.selected, run.items.length - 1) : 0);
  }

  /** The menu's keys while it is up: true when `event` was one. */
  keyDown(event: KeyboardEvent): boolean {
    if (!this.shown || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) {
      return false;
    }
    this.update();
    const shown = this.shown;
    if (!shown) return false;
    const count = shown.run.items.length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const step = event.key === 'ArrowDown' ? 1 : -1;
      this.show(shown.run, (shown.selected + step + count) % count);
    } else if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
      this.pick(shown.selected);
    } else if (event.key === 'Escape') {
      this.dismissed = { engine: this.view.currentEngine()!, slash: shown.run.slash };
      this.hide();
    } else {
      return false;
    }
    event.preventDefault();
    return true;
  }

  /** Close the menu, forgetting the run (another note opened). */
  close(): void {
    this.readFor = null;
    this.listedFor = undefined;
    this.dismissed = null;
    this.hide();
  }

  /** The open run at a caret, read again only when the revision or the caret changed. */
  private run(): OpenSlashRun | null {
    const view = this.view;
    const engine = view.currentEngine();
    const model = view.lineModel();
    const range = view.selection.range();
    if (!engine || !model || !range || range.start !== range.end || view.isComposing()) {
      return null;
    }
    const known = this.readFor;
    if (
      known?.engine === engine &&
      known.revision === engine.revision &&
      known.caret === range.start
    ) {
      return known.run;
    }
    const line = model.lines[model.lineAt(range.start)];
    const found = slashRunAt(line, range.start - line.start);
    const run = found && {
      slash: line.start + found.slash,
      caret: range.start,
      query: found.query,
      items: filterSlashItems(found.query, DESKTOP_SLASH_ITEMS),
    };
    this.readFor = { engine, revision: engine.revision, caret: range.start, run };
    return run;
  }

  private pick(index: number, imagePaths?: readonly string[]): void {
    const shown = this.shown;
    const item = shown?.run.items[index];
    this.hide();
    if (!shown || !item) return;
    const typed = { start: shown.run.slash, end: shown.run.caret };
    runSlashItem(this.view, typed, { id: item.id, imagePaths });
  }

  private show(run: OpenSlashRun, selected: number): void {
    const caret = this.view.caretSide.clientRect(run.caret);
    if (!caret) return this.hide();
    this.shown = { run, selected };
    const rows = run.items.map((item) => ({
      label: localizedText(item.labelPath),
      detail: localizedText(item.hintPath),
    }));
    this.list.show(rows, selected, caret);
  }

  private hide(): void {
    this.shown = null;
    this.list.hide();
  }
}
