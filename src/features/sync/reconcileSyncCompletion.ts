import {
  getNoteById,
  noteExists,
  readNote,
  refreshNotesFromStorage,
} from '$features/notes/notes.svelte';
import type { NoteSession } from '$features/notes/noteSession.svelte';
import { getLocalNoteStore } from '$lib/localNoteStore';
import { updateAppState } from '$shared/state/appState';

import type { SyncTrigger } from './autoSyncV2';
import type { createExternalChangeCoordinator } from './createExternalChangeCoordinator';
import type { SyncSummary } from './syncServiceE2ee';
import type { WriteSuppressor } from '$lib/platform/writeSuppression';

type ExternalChangeCoordinator = Pick<
  ReturnType<typeof createExternalChangeCoordinator>,
  'deferAdopt' | 'runRescan'
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
  getSyncStartEditVersion: () => number;
  raiseSyncError: (message: string) => void;
  setCompletionStatus: (message: string, durationMs: number) => void;
  setSyncStatusMessage: (message: string) => void;
  writeSuppressor: WriteSuppressor;
}

function isCollisionVariantId(sourceId: string, candidateId: string): boolean {
  return candidateId.startsWith(`${sourceId} (`) && /\(\d+\)$/.test(candidateId);
}

export function findActiveSyncRename(
  summary: Pick<SyncSummary, 'updatedIds' | 'deletedIds' | 'renamed'>,
  originalId: string,
  recentRenameTarget?: string | null,
): { fromId: string; toId: string } | null {
  const explicitRename = summary.renamed.find((rename) => rename.fromId === originalId);
  if (explicitRename) return explicitRename;
  if (recentRenameTarget && recentRenameTarget !== originalId) {
    return { fromId: originalId, toId: recentRenameTarget };
  }
  if (!summary.deletedIds.includes(originalId)) return null;

  const collisionRenameTarget = summary.updatedIds.find((id) =>
    isCollisionVariantId(originalId, id),
  );
  return collisionRenameTarget ? { fromId: originalId, toId: collisionRenameTarget } : null;
}

export function createSyncCompletionReconciler(options: SyncCompletionOptions) {
  const { dependencies, externalChanges, writeSuppressor } = options;

  function applyRename(fromId: string, toId: string): void {
    const slash = toId.lastIndexOf('/');
    const newTitle = getNoteById(toId)?.title ?? (slash === -1 ? toId : toId.slice(slash + 1));
    dependencies.onRename(fromId, toId, newTitle);
    if (dependencies.session.originalId === fromId) {
      dependencies.session.applyRemoteRename(toId, newTitle);
    }
  }

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

  function reconcileRenames(summary: SyncSummary): void {
    const activeBeforeRenames = dependencies.session.originalId;
    const activeRename = activeBeforeRenames
      ? findActiveSyncRename(summary, activeBeforeRenames)
      : null;
    const applied = new Set<string>();
    for (const rename of summary.renamed) {
      applyRename(rename.fromId, rename.toId);
      applied.add(`${rename.fromId}\n${rename.toId}`);
    }
    if (activeRename && !applied.has(`${activeRename.fromId}\n${activeRename.toId}`)) {
      writeSuppressor.recordRemoteRename(activeRename.fromId, activeRename.toId);
      applyRename(activeRename.fromId, activeRename.toId);
    }
  }

  async function reconcileOpenNote(summary: SyncSummary): Promise<string | null> {
    const openId = dependencies.session.originalId;
    const openDeleted = !!openId && summary.deletedIds.includes(openId);
    const openUpdated = !!openId && summary.updatedIds.includes(openId);
    if (!openId || !(openDeleted || openUpdated)) return null;

    let keptDraftId: string | null = null;
    const closeOrKeepDeletedOpenNote = async (): Promise<void> => {
      if (dependencies.session.dirty) {
        keptDraftId = openId;
        dependencies.showToast('Open note was deleted during sync; keeping local draft');
        await refreshNotesFromStorage();
      } else {
        dependencies.session.cancelAndClear();
        dependencies.showToast('Note was deleted during sync');
      }
    };

    let openNoteGone = false;
    if (openDeleted) {
      try {
        openNoteGone = !(await noteExists(openId));
      } catch {
        openNoteGone = true;
      }
    }
    if (dependencies.session.originalId !== openId) return keptDraftId;
    if (openNoteGone) {
      await closeOrKeepDeletedOpenNote();
      return keptDraftId;
    }

    try {
      const freshContent = await readNote(openId);
      let vanished = false;
      if (openDeleted && freshContent === '') {
        try {
          vanished = !(await noteExists(openId));
        } catch {
          vanished = true;
        }
      }
      if (dependencies.session.originalId !== openId) return keptDraftId;
      if (vanished) {
        await closeOrKeepDeletedOpenNote();
        return keptDraftId;
      }
      if (freshContent !== dependencies.session.editorContent) {
        const editedDuringSync =
          dependencies.session.editVersion !== options.getSyncStartEditVersion();
        if (!editedDuringSync && !dependencies.session.dirty) {
          if (dependencies.session.editorFocused) {
            externalChanges.deferAdopt(openId, freshContent);
          } else {
            dependencies.session.applyExternalContent(freshContent);
          }
        }
      }
      const meta = getNoteById(openId);
      if (meta) dependencies.session.applyRemoteRename(openId, meta.title);
    } catch {
      if (dependencies.session.originalId !== openId) return keptDraftId;
      dependencies.showToast('Open note changed during sync; keeping local draft');
    }
    return keptDraftId;
  }

  return async function reconcileSyncCompletion(
    summary: SyncSummary,
    trigger?: SyncTrigger,
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
    reconcileRenames(summary);
    const keptDeletedDraftId = await reconcileOpenNote(summary);

    const pruneCandidates = summary.deletedIds.filter((id) => id !== keptDeletedDraftId);
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
  };
}
