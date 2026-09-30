/**
 * Drains the open note's pending save before the process goes away.
 *
 * Every way the desktop app ends has to call this first: the window close
 * handler (startNativeShell.ts), and the two restarts, the updater's install
 * and the vault-location change, which used to `relaunch()` straight away and
 * dropped an edit typed in the last ~0.5 s (RC-87).
 *
 * Bounded on purpose: a hung or failed save must never trap the exit.
 */

export interface ExitFlushSource {
  flushSave: () => Promise<void>;
  /** A save is pending or in flight. Optional: a source without it gets the plain race. */
  isSavePending?: () => boolean;
}

const FLUSH_RACE_MS = 3000;
/**
 * The longest an exit waits for a write that is still running after the race. An
 * exit mid-write abandons it, and on a slow disk (a >3 s fsync) that lost the edit
 * and left a hidden `.sf-tmp-*` behind.
 */
const FLUSH_CAP_MS = 15_000;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let source: ExitFlushSource | null = null;

/** The notes shell registers its session here; returns the unregister. */
export function registerExitFlushSource(next: ExitFlushSource): () => void {
  source = next;
  return () => {
    if (source === next) source = null;
  };
}

export async function flushPendingSaveBeforeExit(): Promise<void> {
  const current = source;
  if (!current) return;
  const flushed = current.flushSave().catch(() => {});
  await Promise.race([flushed, delay(FLUSH_RACE_MS)]);
  if (current.isSavePending?.()) await Promise.race([flushed, delay(FLUSH_CAP_MS - FLUSH_RACE_MS)]);
}
