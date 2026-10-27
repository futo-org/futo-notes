// One timeline for every interaction the editor has to keep snappy: a note
// switch, a note open, a block drag, a keystroke. Each kind has at most one
// interaction in flight; begin/mark/end record its phases on one clock.
//
// Always on. A mark costs one performance.now() and one array write, and each
// kind keeps only its last HISTORY records, so this never grows without bound —
// and a burst of one kind (a typing run) never evicts another's (the note
// switch the tab-switch probe is about to read). Reading (`getInteractions`)
// allocates; marking does not.
//
// The per-keystroke recorder is the exception to "always on": it is OFF unless
// a test harness enables it, because typing is sacred (AGENTS M5) — a shipped
// build pays one boolean read per edit and nothing else. See `noteKeystroke`.
//
// It lives here, at the nearest common owner, because the owners of these
// interactions span app/, features/ and the native embed, and features/
// cannot import from app/.

export type InteractionKind = 'note-switch' | 'note-open' | 'block-drag' | 'keystroke';

export interface InteractionRecord {
  kind: InteractionKind;
  /** What the interaction was about: the note id — or null. */
  subject: string | null;
  /** performance.now() when the interaction started. */
  startedAt: number;
  /** Milliseconds from startedAt to each phase that ran, in the order they ran. */
  phases: Array<{ phase: string; atMs: number }>;
}

/** Records retained PER KIND. */
const HISTORY = 100;

const KINDS: readonly InteractionKind[] = ['note-switch', 'note-open', 'block-drag', 'keystroke'];

const records: Record<InteractionKind, InteractionRecord[]> = {
  'note-switch': [],
  'note-open': [],
  'block-drag': [],
  keystroke: [],
};
const current: Record<InteractionKind, InteractionRecord | null> = {
  'note-switch': null,
  'note-open': null,
  'block-drag': null,
  keystroke: null,
};

export function beginInteraction(kind: InteractionKind, subject: string | null = null): void {
  const record: InteractionRecord = { kind, subject, startedAt: performance.now(), phases: [] };
  current[kind] = record;
  const history = records[kind];
  history.push(record);
  if (history.length > HISTORY) history.shift();
}

export function markInteraction(kind: InteractionKind, phase: string): void {
  const record = current[kind];
  if (!record) return;
  record.phases.push({ phase, atMs: performance.now() - record.startedAt });
}

/**
 * Ends the current interaction of `kind`. A superseded one (the user pressed
 * Ctrl+Tab again mid-load) simply stops receiving marks; its record stays as
 * recorded so a dropped phase is visible rather than silently attributed to
 * the next interaction.
 */
export function endInteraction(kind: InteractionKind): void {
  current[kind] = null;
}

/** One kind's retained records, oldest first; with no kind, every kind's, by start time. */
export function getInteractions(kind?: InteractionKind): readonly InteractionRecord[] {
  if (kind) return records[kind];
  return KINDS.flatMap((k) => records[k]).sort((a, b) => a.startedAt - b.startedAt);
}

export function clearInteractions(kind?: InteractionKind): void {
  for (const k of kind ? [kind] : KINDS) {
    records[k].length = 0;
    current[k] = null;
  }
  if (!kind || kind === 'keystroke') keystrokeFramePending = false;
}

/* ---- the keystroke tripwire ------------------------------------------------
 *
 * Sampled: the FIRST reportable transaction of each frame opens a `keystroke`
 * record, and the next animation frame closes it with a single phase, `frame`
 * — dispatch → next frame, the number the device perf runners call "settled".
 * Further transactions that land before that frame (an IME composition burst,
 * a paste's follow-ups) share it and record nothing; the first one waited the
 * longest, so the sample is that frame's worst case.
 *
 * Off by default. A harness enables it: `__perfCourse` in a dev/test desktop
 * build (installPerfCourse.ts, behind TEST_HOOKS_ENABLED), or the native embed's
 * `?test` URL, which only a debug Android build loads. Until then
 * `noteKeystroke` is one boolean read. Enabled, it costs one record and ONE
 * requestAnimationFrame per frame, however many transactions land in it.
 */
let keystrokeTripwire = false;
let keystrokeFramePending = false;

export function setKeystrokeTripwire(enabled: boolean): void {
  keystrokeTripwire = enabled;
}

function closeKeystrokeFrame(): void {
  keystrokeFramePending = false;
  markInteraction('keystroke', 'frame');
  endInteraction('keystroke');
}

/** Called by the editor at a reportable transaction's dispatch (documentChanges.ts). */
export function noteKeystroke(): void {
  if (!keystrokeTripwire || keystrokeFramePending) return;
  keystrokeFramePending = true;
  beginInteraction('keystroke');
  requestAnimationFrame(closeKeystrokeFrame);
}

/** The `frame` phases of the retained keystroke records, in ms — the tripwire's readout. */
export function keystrokeFrameSamplesMs(): number[] {
  const samples: number[] = [];
  for (const record of records.keystroke) {
    const frame = record.phases.find((p) => p.phase === 'frame');
    if (frame) samples.push(frame.atMs);
  }
  return samples;
}
