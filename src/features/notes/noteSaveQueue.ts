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
      void runQueuedSave();
    }, delayMilliseconds);
  }

  async function flush(): Promise<void> {
    const hadPendingTimer = saveTimer !== null;
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = null;

    try {
      if (hadPendingTimer) await runQueuedSave();
      else if (saveInFlight) await saveInFlight;
      else if (options.hasUnseenChanges()) await runQueuedSave();
    } catch (error) {
      console.warn('Failed to flush note save:', error);
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
    flush,
    cancelPending,
  };
}
