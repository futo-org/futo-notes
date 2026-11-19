import { noteExists, refreshNotesAfterSync } from '$features/notes/notes.svelte';
import type { NoteSession } from '$features/notes/noteSession.svelte';
import { updateAppState } from '$shared/state/appState';

import type { SyncTrigger } from './autoSync';
import type { createExternalChangeCoordinator } from './createExternalChangeCoordinator';
import type { WriteRefusalOutput } from './syncContract.generated';
import type { SyncSummary } from './syncServiceE2ee';
import type { WriteSuppressor } from '$lib/platform/writeSuppression';
import type { LocalizedMessage } from '$shared/localization';
import type { ToastMessage } from '$shared/notifications/toastBus.svelte';

type ExternalChangeCoordinator = Pick<
  ReturnType<typeof createExternalChangeCoordinator>,
  'reconcileOpenNote'
>;

interface SyncCompletionDependencies {
  session: NoteSession;
  showToast: (message: ToastMessage) => void;
  /** One engine-reported rename: the tabs showing the note follow. The open note's
   * session follows its editor, never this, so route and title cannot disagree. */
  onRename: (fromId: string, toId: string) => void;
  pruneTabsForDeletedIds: (goneIds: string[]) => void;
}

interface SyncCompletionOptions {
  clearSyncError: () => void;
  dependencies: SyncCompletionDependencies;
  externalChanges: ExternalChangeCoordinator;
  getSyncStartEditVersion: (trigger?: SyncTrigger) => number;
  /** The engine's failure sentence, plus this cycle's refusal when the server
   *  would not take the writes at all — a 402 or 507 says "Sync paused" /
   *  "Vault is full" rather than "Sync completed with errors". */
  raiseSyncError: (
    message: string,
    writeRefusal: WriteRefusalOutput | null,
    summary: SyncSummary,
  ) => void;
  setCompletionStatus: (message: LocalizedMessage, durationMilliseconds: number) => void;
  setSyncStatusMessage: (message: LocalizedMessage | null) => void;
  writeSuppressor: WriteSuppressor;
}

export function createSyncCompletionReconciler(options: SyncCompletionOptions) {
  const { dependencies, externalChanges, writeSuppressor } = options;
  let completionTail: Promise<void> = Promise.resolve();

  function recordSyncedFiles(summary: SyncSummary): void {
    for (const id of summary.updatedIds) writeSuppressor.recordSyncWrite(`${id}.md`);
    for (const id of summary.deletedIds) writeSuppressor.recordSyncWrite(`${id}.md`);
    for (const rename of summary.renamed) {
      writeSuppressor.recordSyncWrite(`${rename.fromId}.md`);
      writeSuppressor.recordSyncWrite(`${rename.toId}.md`);
      writeSuppressor.recordRemoteRename(rename.fromId, rename.toId);
    }
  }

  async function projectSyncChanges(summary: SyncSummary): Promise<void> {
    const wroteLocalChanges =
      summary.localWritesApplied > 0 ||
      summary.updatedIds.length > 0 ||
      summary.deletedIds.length > 0 ||
      summary.renamed.length > 0;
    if (!wroteLocalChanges) return;
    await refreshNotesAfterSync(summary.updatedIds, summary.deletedIds, summary.renamed);
  }

  /** Classifies the open note against the cycle; the id of a draft it kept open. */
  async function reconcileOpenNote(
    summary: SyncSummary,
    syncStartEditVersion: number,
  ): Promise<string | null> {
    // The store moved the editor's attachment with every relocation the cycle made (each
    // reports its source deleted, a rename pair or not), and a checkpoint's reply brings
    // the session where it went before it is classified.
    const session = dependencies.session;
    const left = (id: string | null) =>
      id !== null &&
      (summary.deletedIds.includes(id) || summary.renamed.some((pair) => pair.fromId === id));
    if (left(session.originalId)) await session.checkpointEditor().catch(() => {});
    const openId = session.originalId;
    if (!openId) return null;
    const rename = summary.renamed.find((pair) => pair.fromId === openId);
    const isAffected =
      rename !== undefined ||
      summary.deletedIds.includes(openId) ||
      summary.updatedIds.includes(openId);
    if (!isAffected) return null;

    let currentId = openId;
    const seenIds = new Set<string>();
    // A cycle can contribute at most one fresh source per reported rename,
    // followed by one final target classification.
    const maxPasses = summary.renamed.length + 1;
    let keptDraftId: string | null = null;
    for (let pass = 0; pass < maxPasses && !seenIds.has(currentId); pass += 1) {
      seenIds.add(currentId);
      const currentRename = summary.renamed.find((pair) => pair.fromId === currentId);
      const result = await externalChanges.reconcileOpenNote(currentId, {
        editedDuringCycle: dependencies.session.editVersion !== syncStartEditVersion,
        renamedTo: currentRename?.toId ?? null,
      });
      keptDraftId = result.keptDraftId;
      if (!result.followedRenameTo) return keptDraftId;
      currentId = result.followedRenameTo;
    }
    return keptDraftId;
  }

  async function reconcileSyncCompletion(
    summary: SyncSummary,
    trigger: SyncTrigger | undefined,
    syncStartEditVersion: number,
  ): Promise<void> {
    if (summary.failureMessage) {
      options.raiseSyncError(summary.failureMessage, summary.writeRefusal, summary);
    } else {
      options.clearSyncError();
      if (trigger === 'manual') dependencies.showToast({ path: 'sync.status.complete' });
    }
    void updateAppState({ lastSyncedAt: Date.now() }).catch((error) => {
      console.warn('Failed to persist lastSyncedAt:', error);
    });

    recordSyncedFiles(summary);
    await projectSyncChanges(summary);
    const keptDraftId = await reconcileOpenNote(summary, syncStartEditVersion);
    // The tabs showing a relocated note follow; the open note's follow its editor.
    for (const rename of summary.renamed) dependencies.onRename(rename.fromId, rename.toId);

    // What happens to the OPEN note is the engine's verdict, never a background
    // prune: a note the executor was told to leave open (Leave/KeepDraft, or a
    // rename it followed) whose file then vanished before this existence probe
    // ran would otherwise have its live tab pruned, which clears the session and
    // routes home behind the verdict's back. A `close` verdict has already
    // unbound the session, so the id is still pruned then.
    const stillOpenId = dependencies.session.originalId;
    const pruneCandidates = summary.deletedIds.filter(
      (id) => id !== keptDraftId && id !== stillOpenId,
    );
    const pruneExistence = await Promise.all(
      pruneCandidates.map((id) => noteExists(id).catch(() => true)),
    );
    const goneIds = pruneCandidates.filter((_, index) => !pruneExistence[index]);
    if (goneIds.length > 0) dependencies.pruneTabsForDeletedIds(goneIds);

    const totalChanges =
      summary.updatedIds.length + summary.deletedIds.length + summary.renamed.length;
    if (totalChanges > 20 && !summary.failureMessage) {
      options.setCompletionStatus({ path: 'sync.status.complete' }, 3000);
    } else {
      options.setSyncStatusMessage(null);
    }
  }

  return function serializeSyncCompletion(
    summary: SyncSummary,
    trigger?: SyncTrigger,
  ): Promise<void> {
    const syncStartEditVersion = options.getSyncStartEditVersion(trigger);
    const operation = () => reconcileSyncCompletion(summary, trigger, syncStartEditVersion);
    const run = completionTail.then(operation, operation);
    completionTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
