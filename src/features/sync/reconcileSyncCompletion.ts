import { getNoteById, noteExists, refreshNotesAfterSync } from '$features/notes/notes.svelte';
import type { NoteSession } from '$features/notes/noteSession.svelte';
import { updateAppState } from '$shared/state/appState';

import type { SyncTrigger } from './autoSyncV2';
import type { createExternalChangeCoordinator } from './createExternalChangeCoordinator';
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
  /** Applies one engine-reported rename completely — tab/route AND the open
   * session while it is still bound to `fromId` (syncManager
   * `applyReportedRename`). Retargeting only the route is what left the URL on
   * the new title with the old one still in the title input. */
  onRename: (fromId: string, toId: string, title: string) => void;
  pruneTabsForDeletedIds: (goneIds: string[]) => void;
}

interface SyncCompletionOptions {
  clearSyncError: () => void;
  dependencies: SyncCompletionDependencies;
  externalChanges: ExternalChangeCoordinator;
  getSyncStartEditVersion: (trigger?: SyncTrigger) => number;
  raiseSyncError: (message: string) => void;
  setCompletionStatus: (message: LocalizedMessage, durationMilliseconds: number) => void;
  setSyncStatusMessage: (message: LocalizedMessage | null) => void;
  writeSuppressor: WriteSuppressor;
}

interface OpenNoteSyncResult {
  followedRenameFromIds: Set<string>;
  keptDraftId: string | null;
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

  // Every reported rename the open-note executor did not already follow —
  // renames of other notes, and the open note's own rename when its
  // classification never produced an applicable verdict (it failed, or the
  // engine could not be asked at all). Applying them completely is what keeps
  // route and title agreeing on which note is open.
  function projectReportedRenames(summary: SyncSummary, followedRenameFromIds: Set<string>): void {
    for (const rename of summary.renamed) {
      if (followedRenameFromIds.has(rename.fromId)) continue;
      const slash = rename.toId.lastIndexOf('/');
      const title =
        getNoteById(rename.toId)?.title ??
        (slash === -1 ? rename.toId : rename.toId.slice(slash + 1));
      dependencies.onRename(rename.fromId, rename.toId, title);
    }
  }

  async function reconcileOpenNote(
    summary: SyncSummary,
    syncStartEditVersion: number,
  ): Promise<OpenNoteSyncResult> {
    const openId = dependencies.session.originalId;
    const syncResult: OpenNoteSyncResult = {
      followedRenameFromIds: new Set(),
      keptDraftId: null,
    };
    if (!openId) return syncResult;
    const rename = summary.renamed.find((pair) => pair.fromId === openId);
    const isAffected =
      rename !== undefined ||
      summary.deletedIds.includes(openId) ||
      summary.updatedIds.includes(openId);
    if (!isAffected) return syncResult;

    // A flush can park and synchronously ask the external-change coordinator
    // to adopt the peer version. Settle it before entering that coordinator's
    // own serial queue, or the nested post-park reconciliation deadlocks
    // behind the operation that is awaiting the flush.
    if (dependencies.session.savePending) {
      await dependencies.session.flushSave();
      if (dependencies.session.originalId !== openId) return syncResult;
    }

    let currentId = openId;
    const seenIds = new Set<string>();
    // A cycle can contribute at most one fresh source per reported rename,
    // followed by one final target classification.
    const maxPasses = summary.renamed.length + 1;
    for (let pass = 0; pass < maxPasses && !seenIds.has(currentId); pass += 1) {
      seenIds.add(currentId);
      const currentRename = summary.renamed.find((pair) => pair.fromId === currentId);
      const result = await externalChanges.reconcileOpenNote(currentId, {
        editedDuringCycle: dependencies.session.editVersion !== syncStartEditVersion,
        renamedTo: currentRename?.toId ?? null,
      });
      syncResult.keptDraftId = result.keptDraftId;
      if (!result.followedRenameTo) return syncResult;
      syncResult.followedRenameFromIds.add(currentId);
      currentId = result.followedRenameTo;
    }
    return syncResult;
  }

  async function reconcileSyncCompletion(
    summary: SyncSummary,
    trigger: SyncTrigger | undefined,
    syncStartEditVersion: number,
  ): Promise<void> {
    if (summary.failureMessage) {
      options.raiseSyncError(summary.failureMessage);
    } else {
      options.clearSyncError();
      if (trigger === 'manual') dependencies.showToast({ path: 'sync.status.complete' });
    }
    void updateAppState({ lastSyncedAt: Date.now() }).catch((error) => {
      console.warn('Failed to persist lastSyncedAt:', error);
    });

    recordSyncedFiles(summary);
    await projectSyncChanges(summary);
    const openNoteResult = await reconcileOpenNote(summary, syncStartEditVersion);
    projectReportedRenames(summary, openNoteResult.followedRenameFromIds);

    // What happens to the OPEN note is the engine's verdict, never a background
    // prune: a note the executor was told to leave open (Leave/KeepDraft, or a
    // rename it followed) whose file then vanished before this existence probe
    // ran would otherwise have its live tab pruned, which clears the session and
    // routes home behind the verdict's back. A `close` verdict has already
    // unbound the session, so the id is still pruned then.
    const stillOpenId = dependencies.session.originalId;
    const pruneCandidates = summary.deletedIds.filter(
      (id) => id !== openNoteResult.keptDraftId && id !== stillOpenId,
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
