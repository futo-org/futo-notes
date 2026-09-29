interface NoteSaveQueueOptions {
  save: () => Promise<boolean>;
  hasUnseenChanges: () => boolean;
  /** The editor now holds something other than what the last save read. */
  editedSinceSaveRead: () => boolean;
  notifySaved: () => void;
}

export function createNoteSaveQueue(options: NoteSaveQueueOptions) {
  let saveTimer: number | null = null;
  let saveInFlight: Promise<void> | null = null;
  let saveQueued = false;
  let lastEditTime = 0;
  let editVersion = 0;
  /* When the armed timer's run of edits began: the max-wait's anchor. */
  let pendingSince: number | null = null;

  /**
   * Arms the save `delayMilliseconds` after this edit — a trailing debounce,
   * so a burst costs one save. With `maxWaitMilliseconds`, a burst that never
   * pauses is still saved that long after it began (RC-26: a steady typist was
   * saved only when they stopped, and a crash lost the whole burst). Nothing
   * extra runs per edit: the one timer is simply armed no later than the
   * deadline, and the save it fires is the ordinary one.
   */
  function schedule(delayMilliseconds: number, maxWaitMilliseconds = Infinity): void {
    const now = Date.now();
    lastEditTime = now;
    editVersion++;
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    pendingSince ??= now;
    const delay = Math.max(
      0,
      Math.min(delayMilliseconds, pendingSince + maxWaitMilliseconds - now),
    );
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      pendingSince = null;
      void runQueuedSave().catch(() => {});
    }, delay);
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
  //
  // A save already in flight read the editor when it STARTED. An edit made
  // since then may still be inside the editor's own change debounce, so no
  // timer says it exists: after awaiting that save, look again rather than
  // returning (RC-10 — a note switch then replaced the document the edit
  // lived in). Only an edit that save did not read counts: a first save of a
  // new note that lands after the user moved on is deliberately not rebound
  // (noteSession `onSaved`), and saving that note again would make a second.
  async function flush(): Promise<void> {
    for (;;) {
      const hadPendingTimer = saveTimer !== null;
      if (saveTimer !== null) window.clearTimeout(saveTimer);
      saveTimer = null;
      pendingSince = null;

      if (hadPendingTimer) await runQueuedSave();
      else if (saveInFlight) {
        await saveInFlight;
        if (options.editedSinceSaveRead()) continue;
      } else if (options.hasUnseenChanges()) await runQueuedSave();
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
    pendingSince = null;
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
