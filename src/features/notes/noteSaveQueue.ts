interface NoteSaveQueueOptions {
  save: () => Promise<boolean>;
  hasUnseenChanges: () => boolean;
  notifySaved: () => void;
}

export function createNoteSaveQueue(options: NoteSaveQueueOptions) {
  let saveTimer: number | null = null;
  let saveInFlight: Promise<void> | null = null;
  let saveQueued = false;
  let lastEditTime = 0;
  let editVersion = 0;

  function schedule(delayMilliseconds: number): void {
    lastEditTime = Date.now();
    editVersion++;
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

  // An edit can land while this function is awaiting a save it already knew
  // about (schedule() arms a plain setTimeout, independent of saveInFlight),
  // and that edit's fresh debounce timer survives a single pass untouched —
  // flush() would return with it still ticking down. A caller that awaits
  // flush() (a note-switch load, a rename, a move) then proceeds on the
  // assumption nothing is left pending, so that survivor can fire later
  // against a session whose identity has already moved on and write one
  // note's content under another note's id. Re-check for exactly that after
  // each await — a timer armed while we were awaiting — and flush it too
  // before returning.
  async function flush(): Promise<void> {
    for (;;) {
      const hadPendingTimer = saveTimer !== null;
      if (saveTimer !== null) window.clearTimeout(saveTimer);
      saveTimer = null;

      if (hadPendingTimer) await runQueuedSave();
      else if (saveInFlight) await saveInFlight;
      else if (options.hasUnseenChanges()) await runQueuedSave();
      else return;

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
        if (await options.save()) options.notifySaved();
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
    get editVersion() {
      return editVersion;
    },
    get lastEditTime() {
      return lastEditTime;
    },
    isPending: () => saveTimer !== null || saveInFlight !== null || saveQueued,
    schedule,
    resume,
    flush,
    cancelPending,
  };
}
