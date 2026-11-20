/* The desktop page's editor engine: the `WasmSession` from crates/futo-notes-editor,
 * built into the gitignored ./wasm/ by scripts/build-editor-wasm.mjs. The JSON
 * payloads are typed by @futo-notes/editor/wasm-payloads; this file declares the
 * methods the desktop editor calls and parses their results. */
import type {
  Affinity,
  Applied,
  BlockCommand,
  CodeBlockHeader,
  Composition,
  DisplayRange,
  HostAck,
  HostRequest,
  HostSnapshot,
  InlineFormat,
  InputAction,
  LinkDescription,
  NoteIdChange,
  ParagraphKey,
  ProjectionSlice,
  SelectionChange,
  ToolbarState,
  WikilinkCompletion,
  TableCommand,
  TableDescription,
  TableKey,
  TableOutcome,
} from '@futo-notes/editor/wasm-payloads';
import { EngineFind, type RawFind } from './engineFind';

interface RawSession extends RawFind {
  display_len(): number;
  selection(): string;
  affinity(): string;
  project(revision: bigint, start: number, end: number): string;
  place_selection(revision: bigint, start: number, end: number, affinity: string): string;
  select_code_block(revision: bigint, at: number): string;
  selected_block(): string;
  writes_language(): boolean;
  writes_delimiter_row(): boolean;
  set_code_block_header(revision: bigint, header: string): string;
  word_at(revision: bigint, offset: number): string;
  word_stop(revision: bigint, offset: number, forward: boolean): number;
  replace_utf16_action(
    revision: bigint,
    start: number,
    end: number,
    inserted: Uint16Array,
    action: string,
  ): string;
  paragraph_key_utf16(revision: bigint, start: number, end: number, key: string): string;
  block_command_utf16(revision: bigint, start: number, end: number, command: string): string;
  block_command_removing_utf16(
    revision: bigint,
    start: number,
    end: number,
    command: string,
  ): string;
  table_command_utf16(revision: bigint, start: number, end: number, command: string): string;
  inspect_table_utf16(revision: bigint, start: number, end: number): string;
  table_key(revision: bigint, key: string): string;
  enter_table_cell_utf16(revision: bigint, at: number, column: number): string;
  active_formats(): string;
  toolbar_state(): string;
  toggle_format(revision: bigint, format: string): string;
  paste_markdown(revision: bigint, start: number, end: number, text: string): string;
  copy_markdown(revision: bigint, start: number, end: number): string;
  cut_markdown(revision: bigint, start: number, end: number): string;
  move_markdown(revision: bigint, start: number, end: number, to: number): string;
  image_claim(): bigint;
  insert_image(revision: bigint, claim: bigint, reference: string, alt: string): string;
  compose_utf16(revision: bigint, start: number, end: number, text: Uint16Array): string;
  commit_composition_utf16(revision: bigint, text: Uint16Array | undefined): string;
  adopt_merged_source(revision: bigint, source: string): string;
  undo(revision: bigint): string;
  redo(revision: bigint): string;
  draft_text(): string;
  header_tags(): string;
  add_header_tag(revision: bigint, tag: string): string;
  remove_header_tag(revision: bigint, tag: string): string;
  acknowledge(ack: string): string;
  resume(): string;
  update_note_ids(noteIds: string): string;
  inspect_link(revision: bigint, start: number, end: number): string;
  set_link(revision: bigint, start: number, end: number, destination: string): string;
  wikilink_completion(revision: bigint): string;
  accept_wikilink_completion(
    revision: bigint,
    start: number,
    end: number,
    query: string,
    noteId: string,
  ): string;
  resolve_note_link(currentId: string, destination: string): string | undefined;
  normalize_link_destination(currentId: string, typed: string): string;
  free(): void;
}

interface EngineModule {
  default: () => Promise<unknown>;
  WasmSession: { restore(snapshot: string): RawSession; find_scan(request: string): string };
  external_link_url(destination: string): string | undefined;
  typed_code_block_language(typed: string): string;
  typed_code_block_name(typed: string): string;
}

const builds = import.meta.glob<EngineModule>('./wasm/futo_notes_editor.js');
let module: Promise<EngineModule> | undefined;

function loadModule(): Promise<EngineModule> {
  module ??= (async () => {
    const load = builds['./wasm/futo_notes_editor.js'];
    if (!load) throw new Error('editor engine not built: run node scripts/build-editor-wasm.mjs');
    const loaded = await load();
    await loaded.default();
    return loaded;
  })();
  return module;
}

/** Why an outside source was not adopted: `later` once marked text is committed, `refused`
 *  for good (front matter, history bounds, an ambiguous step). */
export type AdoptionRefusal = 'later' | 'refused';

const units = (text: string): Uint16Array => {
  const out = new Uint16Array(text.length);
  for (let index = 0; index < text.length; index++) out[index] = text.charCodeAt(index);
  return out;
};

/** One note's engine. Every edit returns the view change to show now and the
 *  request that mirrors it to the host, or null when the input changed no text (it may still
 *  have moved the selection). */
export class Engine {
  private constructor(
    private readonly raw: RawSession,
    private current: number,
    private readonly module: EngineModule,
  ) {}

  static async restore(snapshot: HostSnapshot): Promise<Engine> {
    const loaded = await loadModule();
    return new Engine(
      loaded.WasmSession.restore(JSON.stringify(snapshot)),
      snapshot.revision,
      loaded,
    );
  }

  get revision(): number {
    return this.current;
  }

  private get rev(): bigint {
    return BigInt(this.current);
  }

  private edit(json: string): Applied | null {
    const applied = JSON.parse(json) as Applied | null;
    if (applied) this.current = applied.change.revision;
    return applied;
  }

  private tableOutcome(json: string): TableOutcome | null {
    const outcome = JSON.parse(json) as TableOutcome | null;
    if (outcome && 'edited' in outcome) this.current = outcome.edited.change.revision;
    return outcome;
  }

  /** Find in the note, at the revision shown (engineFind.ts). */
  find(): EngineFind {
    return new EngineFind(this.raw, this.rev, this.module.WasmSession.find_scan);
  }

  /** The engine's reading of display bytes `range`: its text, blocks and runs. */
  project(range: DisplayRange): ProjectionSlice {
    return JSON.parse(this.raw.project(this.rev, range.start, range.end)) as ProjectionSlice;
  }

  projectAll(): ProjectionSlice {
    return this.project({ start: 0, end: this.raw.display_len() });
  }

  /** In display bytes. */
  selection(): DisplayRange {
    return JSON.parse(this.raw.selection()) as DisplayRange;
  }

  /** The caret's side: an input that only moves the caret returns no change to read it from. */
  affinity(): Affinity {
    return JSON.parse(this.raw.affinity()) as Affinity;
  }

  /** A selection the user placed, `range` in display bytes: the same range as the engine's
   *  still ends a selected block and a language caret. */
  placeSelection(range: DisplayRange, affinity: Affinity): SelectionChange {
    return JSON.parse(
      this.raw.place_selection(this.rev, range.start, range.end, JSON.stringify(affinity)),
    ) as SelectionChange;
  }

  /** Whether the caret is at a code block's hidden opening fence end, where letters write its
   *  language: an input that returns no change has none to read it from. */
  writesLanguage(): boolean {
    return this.raw.writes_language();
  }

  /** Whether the caret is writing a table's delimiter row: the one time it stands on that row
   *  (portable-core/tables.md). */
  writesDelimiterRow(): boolean {
    return this.raw.writes_delimiter_row();
  }

  /** Write the language and `name:` of the block whose code shows at display byte `header.at`
   *  (one Undo step; null when it already has them). Throws when the fence would not read back
   *  with them. */
  setCodeBlockHeader(header: CodeBlockHeader): Applied | null {
    return this.edit(this.raw.set_code_block_header(this.rev, JSON.stringify(header)));
  }

  /** The code block selected as one object, in display bytes: an input that only selects it
   *  returns no change to read it from. */
  selectedBlock(): DisplayRange | null {
    return JSON.parse(this.raw.selected_block()) as DisplayRange | null;
  }

  /** Select, as one object, the code block whose code shows at display byte `at`. */
  selectCodeBlock(at: number): SelectionChange {
    return JSON.parse(this.raw.select_code_block(this.rev, at)) as SelectionChange;
  }

  /** The word a double click at display byte `offset` selects (display bytes). */
  wordAt(offset: number): DisplayRange {
    return JSON.parse(this.raw.word_at(this.rev, offset)) as DisplayRange;
  }

  /** Where Option+Arrow from display byte `offset` stops. */
  wordStop(offset: number, forward: boolean): number {
    return this.raw.word_stop(this.rev, offset, forward);
  }

  /** The `_utf16` and composition methods take UTF-16 display ranges. */
  replace(range: DisplayRange, text: string, action: InputAction): Applied | null {
    return this.edit(
      this.raw.replace_utf16_action(
        this.rev,
        range.start,
        range.end,
        units(text),
        JSON.stringify(action),
      ),
    );
  }

  paragraphKey(range: DisplayRange, key: ParagraphKey): Applied | null {
    return this.edit(
      this.raw.paragraph_key_utf16(this.rev, range.start, range.end, JSON.stringify(key)),
    );
  }

  /** A block command (a heading level, a list, a quote, a task's toggle) on the lines of
   *  UTF-16 `range`. */
  blockCommand(range: DisplayRange, command: BlockCommand): Applied | null {
    return this.edit(
      this.raw.block_command_utf16(this.rev, range.start, range.end, JSON.stringify(command)),
    );
  }

  /** A block command at the caret left once the typed text of UTF-16 `removed` (on one line) is
   *  removed, as one Undo step; null, with nothing removed, where the engine refuses the range. */
  blockCommandRemoving(removed: DisplayRange, command: BlockCommand): Applied | null {
    return this.edit(
      this.raw.block_command_removing_utf16(
        this.rev,
        removed.start,
        removed.end,
        JSON.stringify(command),
      ),
    );
  }

  /** A row or column command on the cell UTF-16 `range` is in. */
  tableCommand(range: DisplayRange, command: TableCommand): Applied | null {
    return this.edit(this.raw.table_command_utf16(this.rev, range.start, range.end, command));
  }

  /** The table UTF-16 `range` is in, with what the row and column commands may do on the cell
   *  it lies inside; null outside every table. Reads the whole table. */
  inspectTable(range: DisplayRange): TableDescription | null {
    const table = this.raw.inspect_table_utf16(this.rev, range.start, range.end);
    return JSON.parse(table) as TableDescription | null;
  }

  /** A table key at the engine's selection: null when the key is not the table's there. */
  tableKey(key: TableKey): TableOutcome | null {
    return this.tableOutcome(this.raw.table_key(this.rev, key));
  }

  /** The cell in 0-based `column` of the table row on the line UTF-16 `at` is on, the caret
   *  in it: the row given empty cells up to it (one edit) when it lacks it; null off a header
   *  or body row, or for a column past the table's. */
  enterTableCell(at: number, column: number): TableOutcome | null {
    return this.tableOutcome(this.raw.enter_table_cell_utf16(this.rev, at, column));
  }

  /** The formats the next typed character takes at the selection's start: the carried ones
   *  a toggle at the caret set, else those of the side its affinity names. */
  activeFormats(): InlineFormat[] {
    return JSON.parse(this.raw.active_formats()) as InlineFormat[];
  }

  /** What the toolbar shows for the selection's lines (the heading level they share, whether
   *  Quote takes a level off, whether a heading can apply): the engine's rule, touched lines
   *  only. */
  toolbarState(): ToolbarState {
    return JSON.parse(this.raw.toolbar_state()) as ToolbarState;
  }

  /** Toggle `format` on the selection (one edit), or at a caret on what is typed next (no
   *  edit: null). */
  toggleFormat(format: InlineFormat): Applied | null {
    return this.edit(this.raw.toggle_format(this.rev, JSON.stringify(format)));
  }

  /** `range` in display bytes; `text` is read as Markdown. */
  paste(range: DisplayRange, text: string): Applied | null {
    return this.edit(this.raw.paste_markdown(this.rev, range.start, range.end, text));
  }

  /** The exact source of a display range (in bytes), as the clipboard should carry it. */
  copy(range: DisplayRange): string {
    return this.raw.copy_markdown(this.rev, range.start, range.end);
  }

  /** `copy`, then delete the range as one edit. */
  cut(range: DisplayRange): [string, Applied | null] {
    const [markdown, applied] = JSON.parse(
      this.raw.cut_markdown(this.rev, range.start, range.end),
    ) as [string, Applied | null];
    if (applied) this.current = applied.change.revision;
    return [markdown, applied];
  }

  /** Drag-to-move, in display bytes: the cut, then the paste (one Undo step). */
  move(range: DisplayRange, to: number): Applied[] {
    const applied = JSON.parse(
      this.raw.move_markdown(this.rev, range.start, range.end, to),
    ) as Applied[];
    if (applied.length > 0) this.current = applied[applied.length - 1].change.revision;
    return applied;
  }

  /** A claim for an image insertion that finishes later: it names this session alone. */
  imageClaim(): bigint {
    return this.raw.image_claim();
  }

  /** `![](reference)` at the selection, one Undo step; null inside code. Throws for a claim
   *  of another session (`StaleClaim`) or a reference the note cannot hold. */
  insertImage(claim: bigint, reference: string): Applied | null {
    return this.edit(this.raw.insert_image(this.rev, claim, reference, ''));
  }

  compose(range: DisplayRange, text: string): Composition {
    return JSON.parse(
      this.raw.compose_utf16(this.rev, range.start, range.end, units(text)),
    ) as Composition;
  }

  commitComposition(text?: string): Applied | null {
    return this.edit(
      this.raw.commit_composition_utf16(this.rev, text === undefined ? undefined : units(text)),
    );
  }

  /** Adopt the source an outside change left the note holding, as one edit that is not
   *  an Undo step: the caret maps through it and the history rebases onto it. */
  adoptOutsideSource(source: string): Applied | AdoptionRefusal {
    try {
      return this.edit(this.raw.adopt_merged_source(this.rev, source))!;
    } catch (error) {
      return String(error).includes('CompositionActive') ? 'later' : 'refused';
    }
  }

  undo(): Applied | null {
    return this.edit(this.raw.undo(this.rev));
  }

  redo(): Applied | null {
    return this.edit(this.raw.redo(this.rev));
  }

  /** The whole source; for reads off the keystroke path. */
  draftText(): string {
    return this.raw.draft_text();
  }

  /** The tags of the note's leading header block (`#name`), read from that block alone. */
  headerTags(): string[] {
    return JSON.parse(this.raw.header_tags()) as string[];
  }

  /** Add `tag` to the header block, creating it (one Undo step; null when the note has it). */
  addHeaderTag(tag: string): Applied | null {
    return this.edit(this.raw.add_header_tag(this.rev, tag));
  }

  /** Remove every spelling of `tag` from the header block (one Undo step). */
  removeHeaderTag(tag: string): Applied | null {
    return this.edit(this.raw.remove_header_tag(this.rev, tag));
  }

  /** The requests to send again; non-empty only for a successful reply to `resume`. */
  acknowledge(ack: HostAck): HostRequest[] {
    return JSON.parse(this.raw.acknowledge(JSON.stringify(ack))) as HostRequest[];
  }

  resume(): HostRequest {
    return JSON.parse(this.raw.resume()) as HostRequest;
  }

  updateNoteIds(noteIds: readonly string[]): NoteIdChange {
    return JSON.parse(this.raw.update_note_ids(JSON.stringify(noteIds))) as NoteIdChange;
  }

  /** The link or web address display bytes `range` lies in (a caret at its edge on the side
   *  its affinity names); null when it reaches outside one or touches none. */
  inspectLink(range: DisplayRange): LinkDescription | null {
    return JSON.parse(
      this.raw.inspect_link(this.rev, range.start, range.end),
    ) as LinkDescription | null;
  }

  /** Link display bytes `range` to `destination` (on a link, change its destination; empty
   *  removes it; at a caret, insert it as its own label). One Undo step. */
  setLink(range: DisplayRange, destination: string): Applied | null {
    return this.edit(this.raw.set_link(this.rev, range.start, range.end, destination));
  }

  /** The unfinished `[[` run before the caret and the notes it could name; null for none. */
  wikilinkCompletion(): WikilinkCompletion | null {
    return JSON.parse(this.raw.wikilink_completion(this.rev)) as WikilinkCompletion | null;
  }

  /** Replace the run `completion` described with `[[noteId]]`, the caret after it. */
  acceptWikilinkCompletion(completion: WikilinkCompletion, noteId: string): Applied {
    const { range, query } = completion;
    const json = this.raw.accept_wikilink_completion(
      BigInt(completion.revision),
      range.start,
      range.end,
      query,
      noteId,
    );
    return this.edit(json)!;
  }

  /** The note id a pressed link's schemeless `destination` names from the note `currentId`'s
   *  folder; null when it names none. */
  resolveNoteLink(currentId: string, destination: string): string | null {
    return this.raw.resolve_note_link(currentId, destination) ?? null;
  }

  /** What a code block's language or name field keeps of text typed or pasted into it
   *  (portable-core/fenced-code.md). */
  typedCodeBlockField(field: 'language' | 'name', typed: string): string {
    return field === 'language'
      ? this.module.typed_code_block_language(typed)
      : this.module.typed_code_block_name(typed);
  }

  /** The address a pressed link's `destination` opens outside the app; null when it opens
   *  none. */
  externalLinkUrl(destination: string): string | null {
    return this.module.external_link_url(destination) ?? null;
  }

  /** What the Link prompt of the note `currentId` saves for the `typed` destination. */
  normalizeLinkDestination(currentId: string, typed: string): string {
    return this.raw.normalize_link_destination(currentId, typed);
  }

  free(): void {
    this.raw.free();
  }
}
