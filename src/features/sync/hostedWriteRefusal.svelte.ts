import type { WriteRefusalOutput } from './syncContract.generated';

/**
 * Whether the server refused the LAST cycle's writes, and which way.
 *
 * Module state rather than a field on the settings model, because the settings
 * model does not exist until somebody opens Settings, and the whole point of
 * this is that a refusal arrives while they are somewhere else entirely. The
 * native shells keep the same fact on their long-lived `SyncManager`; here the
 * sync feature is the only thing that outlives a screen.
 *
 * Never a latch. Every completed cycle records its own answer — `null`
 * included — so a cycle that was not refused clears the banner without
 * anything having to remember to reset it. Rust decides the value
 * (`futo_notes_sync::WriteRefusal`); this only remembers the newest one.
 */
let lastWriteRefusal = $state<WriteRefusalOutput | null>(null);

/** Called once per completed cycle, with that cycle's own answer. */
export function recordWriteRefusal(refusal: WriteRefusalOutput | null): void {
  lastWriteRefusal = refusal;
}

export function currentWriteRefusal(): WriteRefusalOutput | null {
  return lastWriteRefusal;
}
