import { getNoteById, noteExists } from '$features/notes/notes.svelte';
import type { NoteSession } from '$features/notes/noteSession.svelte';
import { getLocalNoteStore } from '$lib/localNoteStore';
import { updateAppState } from '$shared/state/appState';

import type { SyncTrigger } from './autoSyncV2';
import type { createExternalChangeCoordinator } from './createExternalChangeCoordinator';
import type { SyncSummary } from './syncServiceE2ee';
import type { WriteSuppressor } from '$lib/platform/writeSuppression';

type ExternalChangeCoordinator = Pick<
  ReturnType<typeof createExternalChangeCoordinator>,
  'reconcileOpenNote' | 'runRescan'
>;

interface SyncCompletionDependencies {
  session: NoteSession;
  showToast: (message: string) => void;
  onRename: (fromId: string, toId: string, title: string) => void;
  pruneTabsForDeletedIds: (goneIds: string[]) => void;
}

interface SyncCompletionOptions {
  clearSyncError: () => void;
  dependencies: SyncCompletionDependencies;
  externalChanges: ExternalChangeCoordinator;
  getSyncStartEditVersion: (trigger?: SyncTrigger) => number;
  raiseSyncError: (message: string) => void;
  setCompletionStatus: (message: string, durationMs: number) => void;
  setSyncStatusMessage: (message: string) => void;
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

  function reindexPeerChanges(summary: SyncSummary): void {
    const hasPeerNoteChanges =
      summary.peerUpdatedIds.length > 0 ||
      summary.peerDeletedIds.length > 0 ||
      summary.renamed.length > 0;
    if (!hasPeerNoteChanges) return;

    // Sync writes bypass LocalNoteStore mutation methods, so reconcile its
    // Rust-owned index once for the complete peer batch.
    void getLocalNoteStore().then((store) => store.rescan());
    setTimeout(() => void externalChanges.runRescan(), 50);
  }

  function projectBackgroundRenames(
    summary: SyncSummary,
    followedRenameFromIds: Set<string>,
  ): void {
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
      if (trigger === 'manual') dependencies.showToast('Sync complete');
    }
    void updateAppState({ lastSyncedAt: Date.now() }).catch((error) => {
      console.warn('Failed to persist lastSyncedAt:', error);
    });

    recordSyncedFiles(summary);
    reindexPeerChanges(summary);
    const openNoteResult = await reconcileOpenNote(summary, syncStartEditVersion);
    projectBackgroundRenames(summary, openNoteResult.followedRenameFromIds);

    const pruneCandidates = summary.deletedIds.filter((id) => id !== openNoteResult.keptDraftId);
    const pruneExistence = await Promise.all(
      pruneCandidates.map((id) => noteExists(id).catch(() => true)),
    );
    const goneIds = pruneCandidates.filter((_, index) => !pruneExistence[index]);
    if (goneIds.length > 0) dependencies.pruneTabsForDeletedIds(goneIds);

    const totalChanges =
      summary.updatedIds.length + summary.deletedIds.length + summary.renamed.length;
    if (totalChanges > 20 && !summary.failureMessage) {
      options.setCompletionStatus('Sync complete', 3000);
    } else {
      options.setSyncStatusMessage('');
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
