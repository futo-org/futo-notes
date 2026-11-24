// One timeline for each interaction the app has to keep snappy; today that is
// the note switch (noteSwitchTimeline.ts). Each kind has at most one
// interaction in flight; begin/mark/end record its phases on one clock.
//
// Always on. A mark costs one performance.now() and one array write, and each
// kind keeps only its last HISTORY records, so this never grows without bound.
// Reading (`getInteractions`) allocates; marking does not.
//
// It lives here, at the nearest common owner, because the owners of these
// interactions span app/ and features/, and features/ cannot import from app/.

export type InteractionKind = 'note-switch';

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

const KINDS: readonly InteractionKind[] = ['note-switch'];

const records: Record<InteractionKind, InteractionRecord[]> = {
  'note-switch': [],
};
const current: Record<InteractionKind, InteractionRecord | null> = {
  'note-switch': null,
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
}
