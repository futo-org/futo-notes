// JSON payloads exchanged with `WasmSession` (crates/futo-notes-editor/src/wasm*.rs).
// Hand-written; `scripts/test-editor-wasm.mjs` runs tests/wasm-payload-shapes.mjs, which
// compares real WASM output against these declarations so field drift fails CI.
//
// Every method returns a JSON string except `draft_text`/`copy_markdown` (plain strings) and `image_claim` (bigint).
// u64 parameters (token, revision, claim) are `bigint` at the call boundary but plain JSON numbers here.
// Revisions, sequences and tokens are JS-safe integers (< 2^53). Offsets are UTF-8 bytes
// in display or source text unless a `_utf16` method takes UTF-16 code units.
// Failures throw a string: the Rust `Debug` text of the error (for example
// `Paused`, `Editor(StaleRevision { expected: Revision(0), actual: Revision(1) })`).
// Match on it only for logging; hosts branch on `HostError.kind` instead.

export type WasmError = string;

export interface Range {
  start: number;
  end: number;
}
/** Display byte range (or UTF-16 range from `display_to_utf16`). */
export type DisplayRange = Range;
export type SourceRange = Range;

export type Affinity = 'Backward' | 'Forward';
export type InlineFormat = 'Bold' | 'Italic' | 'Strike' | 'Code';
export type InputAction = 'Typing' | 'Isolated' | 'CompositionCommit';
export type ParagraphKey = 'Enter' | 'ShiftEnter' | 'Backspace' | 'Delete' | 'Tab' | 'ShiftTab';
export type BlockCommand =
  | { Heading: number }
  | 'Quote'
  | 'Indent'
  | 'Outdent'
  | 'Divider'
  | 'ToggleTask'
  | 'BulletList'
  | 'OrderedList'
  | 'TaskList'
  | 'CodeBlock';
export type TableKey = 'Tab' | 'ShiftTab' | 'Enter' | 'ModEnter' | 'ShiftEnter';
export type TableCommand =
  | 'InsertRowAbove'
  | 'InsertRowBelow'
  | 'DeleteRow'
  | 'InsertColumnLeft'
  | 'InsertColumnRight'
  | 'DeleteColumn';

// ---- Host protocol -------------------------------------------------------

export interface SourceEdit {
  previous_revision: number;
  revision: number;
  range: SourceRange;
  removed: string;
  inserted: string;
}

export type HostOperation = { Append: SourceEdit } | 'Resume';

/**
 * Page to host. Send to the store worker, in sequence order; deliver its `HostAck` to
 * `acknowledge`. Any number may be outstanding.
 */
export interface HostRequest {
  token: number;
  sequence: number;
  operation: HostOperation;
}

export type HostErrorKind = 'Deleted' | 'StaleToken' | 'Rejected';

export interface HostError {
  kind: HostErrorKind;
  /** For logs only. */
  message: string;
}

export interface RelinkOffer {
  revision: number;
  source: string;
}

/** Host to page; also accepted by `acknowledge`. */
export interface HostAck {
  token: number;
  sequence: number;
  accepted: number;
  paused: boolean;
  error?: HostError | null;
  relink?: RelinkOffer;
}

/** Input to `WasmSession.restore`. */
export interface HostSnapshot {
  token: number;
  source: string;
  revision: number;
  paused: boolean;
}

export interface PortableStatus {
  /** The page's current revision. */
  local: number;
  /** The newest revision the worker has acknowledged. */
  accepted: number;
  paused: boolean;
  /** Edit requests sent but not yet acknowledged. */
  outstanding: number;
}

// ---- Projection ----------------------------------------------------------

export interface SemanticRun {
  range: DisplayRange;
  formats: InlineFormat[];
}

export type CorrespondenceKind = 'Literal' | 'Hidden' | 'Replaced';

export interface Correspondence {
  source: SourceRange;
  display: DisplayRange;
  kind: CorrespondenceKind;
}

/** A list line, or an indented plain line (empty `marker`, not `ordered`). */
export interface ListDescription {
  /** Columns of the line's own leading whitespace (space 1, tab 4). */
  indent: number;
  /** The list marker as typed (`-`, `3)`, `10.`); empty on a plain line. */
  marker: string;
  ordered: boolean;
  checked: boolean | null;
  first: boolean;
}

export interface BlockDescription {
  range: DisplayRange;
  /** 0 when not a heading, else 1..=6. */
  heading: number;
  quote_depth: number;
  divider: boolean;
  list: ListDescription | null;
  code: boolean;
  language: string | null;
  /** Leading front matter: inert, verbatim. */
  metadata: boolean;
}

export interface LinkDescription {
  range: DisplayRange;
  destination: string;
  title: string | null;
}

export interface WikilinkDescription {
  range: DisplayRange;
  target: string;
  label: string;
  note_id: string | null;
}

export interface ImageDescription {
  alt: string;
  destination: string;
  title: string | null;
  reference: string | null;
  vault: boolean;
}

export type AtomKind = 'Image' | 'Divider';

export interface AtomDescription {
  kind: AtomKind;
  range: DisplayRange;
  before: number;
  after: number;
  image: ImageDescription | null;
}

/** `project`, and the `projection` of a `ViewChange`. */
export interface ProjectionSlice {
  revision: number;
  range: DisplayRange;
  text: string;
  runs: SemanticRun[];
  correspondence: Correspondence[];
  blocks: BlockDescription[];
  links: LinkDescription[];
  wikilinks: WikilinkDescription[];
  atoms: AtomDescription[];
  /** Each `#tag`'s display range, `#` included: coloured, still plain text. */
  tags: DisplayRange[];
}

export interface EditWork {
  materialized_source_bytes: number;
  inserted_bytes: number;
  parsed_source_bytes: number;
  link_metadata_items: number;
  link_copied_bytes: number;
}

/** Returned at once by every edit; the view applies it immediately. */
export interface ViewChange {
  previous_revision: number;
  revision: number;
  range: DisplayRange;
  inserted: string;
  selection: DisplayRange;
  work: EditWork;
  affinity: Affinity;
  projection: ProjectionSlice;
}

/** `select_with_affinity`. */
export interface SelectionChange {
  revision: number;
  selection: DisplayRange;
  affinity: Affinity;
}

export interface NoteIdWork {
  catalog_items: number;
  rows_visited: number;
  links_examined: number;
}

/** `update_note_ids`. */
export interface NoteIdChange {
  revision: number;
  projections: ProjectionSlice[];
  work: NoteIdWork;
}

// ---- Feature payloads ----------------------------------------------------

export interface Composition {
  revision: number;
  range: DisplayRange;
  text: string;
  /** The formats the marked text will have once committed; uncovered characters are plain. */
  runs: MarkedRun[];
}

/** A formatted stretch of marked text, in UTF-8 byte offsets into `Composition.text`. */
export interface MarkedRun {
  start: number;
  end: number;
  formats: InlineFormat[];
}

export interface WikilinkCandidate {
  note_id: string;
  label: string;
  detail: string | null;
}

export interface WikilinkCompletion {
  revision: number;
  range: DisplayRange;
  query: string;
  candidates: WikilinkCandidate[];
}

export interface FindReport {
  revision: number;
  open: boolean;
  query: string;
  total: number;
  current: number;
  current_range: DisplayRange | null;
  current_source: SourceRange | null;
  reveal: DisplayRange | null;
  stale: boolean;
}

/** `find_scan_request` (or `null`); pass it, unchanged, to the static `find_scan`. */
export interface FindScanRequest {
  incarnation: number;
  generation: number;
  revision: number;
  query: string;
  text: string;
  soft_breaks: DisplayRange[];
  barriers: DisplayRange[];
}

/** `find_scan` output; deliver to `find_apply_scan`, which returns a `FindReport` or `null` if stale. */
export interface FindScanResult {
  incarnation: number;
  generation: number;
  revision: number;
  matches: DisplayRange[];
  scanned_bytes: number;
}

export type TableAlignment = 'None' | 'Left' | 'Center' | 'Right';

export interface TableCell {
  row: number;
  column: number;
  source: SourceRange;
  content: DisplayRange;
}

export interface TableFocus {
  row: number;
  column: number;
}

export interface TableControls {
  insert_row_above: boolean;
  insert_row_below: boolean;
  delete_row: boolean;
  insert_column_left: boolean;
  insert_column_right: boolean;
  delete_column: boolean;
}

export interface TableDescription {
  source: SourceRange;
  display: DisplayRange;
  columns: number;
  alignments: TableAlignment[];
  rows: TableCell[][];
  focus: TableFocus | null;
  controls: TableControls | null;
}

/** `table_key`: `null` when the key is not a table key. */
export type TableOutcome = { selected: SelectionChange } | { edited: Applied };

// ---- Per-method results --------------------------------------------------
// Edit methods (`replace*`, `toggle_format`, `block_command_utf16`, `paragraph_key_utf16`,
// `undo`, `redo`, `set_link`, `insert_image`, `add_header_tag`, `remove_header_tag`,
// `paste_markdown`, `commit_composition_utf16`, `replace_os_utf16`, `apply_relink_offer`,
// `table_command*`) apply the edit to the page's engine and return `Applied | null`
// (`null` = nothing to do), except `replace*`/`accept_wikilink_completion`, which always
// return `Applied`. Show `change` now and send `request` to the worker. `resume` returns a
// `HostRequest`. `acknowledge` returns `HostRequest[]`: empty, except the reply to `resume`,
// which returns the outstanding requests (renumbered) the worker lacks. `compose_utf16` and
// `composition` return `Composition` / `Composition | null`.

/** One applied input: the view change to show now and the request to send. */
export interface Applied {
  change: ViewChange;
  request: HostRequest;
}
export type EditResult = Applied | null;
/** `cut_markdown`: `[markdown, applied]`. */
export type CutResult = [string, Applied | null];
/** `acknowledge`. */
export type AcknowledgeResult = HostRequest[];
/** `find_matches*`. */
export type FindMatches = DisplayRange[];
/** `tags`, `header_tags`. */
export type TagList = string[];
