interface NoteSaveQueueOptions {
  save: () => Promise<void>;
  hasUnseenChanges: () => boolean;
}

/* The session's own save: a debounced title rename, else a checkpoint of the editor
 * (no I/O when nothing changed). Body edits are saved by the editor's host on its own
 * timer; a flush also asks it to write them now. */
export function createNoteSaveQueue(options: NoteSaveQueueOptions) {
  let saveTimer: number | null = null;
  let saveInFlight: Promise<void> | null = null;
  let saveQueued = false;

  /** Arms the save `delayMilliseconds` after this edit — a trailing debounce. */
  function schedule(delayMilliseconds: number): void {
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      void runQueuedSave().catch(() => {});
    }, delayMilliseconds);
  }

  function resume(): void {
    if (!options.hasUnseenChanges() || saveTimer !== null) return;
    if (saveInFlight) {
      saveQueued = true;
      return;
    }
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      void runQueuedSave().catch(() => {});
    }, 0);
  }

  // Saves once now, after any save in flight. A title edit can land while this
  // function is awaiting, and that edit's fresh debounce timer survives a single
  // pass untouched — flush() would return with it still ticking down. A caller
  // that awaits flush() (a note switch, a move) then proceeds on the assumption
  // nothing is left pending, so that survivor could fire later against a session
  // whose identity has already moved on. Re-check for exactly that after each
  // await — a timer armed while we were awaiting — and flush it too.
  async function flush(): Promise<void> {
    for (;;) {
      if (saveTimer !== null) window.clearTimeout(saveTimer);
      saveTimer = null;
      await runQueuedSave();
      if (saveTimer === null) return;
    }
  }

  async function runQueuedSave(): Promise<void> {
    if (saveInFlight) {
      saveQueued = true;
      await saveInFlight;
      return;
    }

    const run = (async () => {
      do {
        saveQueued = false;
        await options.save();
      } while (saveQueued);
    })();
    saveInFlight = run;
    try {
      await run;
    } finally {
      if (saveInFlight === run) saveInFlight = null;
    }
  }

  function cancelPending(): void {
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = null;
  }

  return {
    isPending: () => saveTimer !== null || saveInFlight !== null || saveQueued,
    schedule,
    resume,
    flush,
    cancelPending,
  };
}
