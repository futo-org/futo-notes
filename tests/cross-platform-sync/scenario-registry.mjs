/**
 * The registry of every scenario, with the matrices and server options each needs.
 */

import {
  ANDROID_MATRIX,
  androidDefersFocusedPeerEditUntilBlur,
  androidKeepsADraftTypedWhileAPeerEditIsDeferred,
  androidReceivesDesktopNoteLive,
  desktopReceivesAndroidEditorEdit,
} from './android-leg-scenarios.mjs';
import {
  androidConflictsWithDesktopEdit,
  androidFollowsPeerRenameWhileOpen,
  androidKeepsAnUnreportedEditOverAPeerDelete,
  androidKeepsAnUnreportedEditOverAPeerEdit,
} from './android-unreported-edit-scenarios.mjs';
import {
  deleteVsEdit,
  largeSync,
  lostStateRecovery,
  offlineAccumulation,
  peerDeleteOfOpenNoteClosesEditor,
  rapidReconnect,
  selfHostedBearerStaysOutOfVault,
  tombstoneDoesNotBlockNewNote,
} from './delete-recovery-and-bulk-scenarios.mjs';
import {
  dirtyDraftSurvivesAPeerEditThenSettles,
  externalAtomicSaveOntoTheOpenNoteIsAdopted,
  externalWatcherProtectsDirtyDraftThenSettles,
  externalWatcherReloadsCleanNote,
} from './draft-and-external-write-scenarios.mjs';
import { FOLDER_MOVE_CASES } from './folder-move-cases.mjs';
import {
  emptyFolderDoesNotSync,
  folderXVsFileXAtSameLevel,
  moveIntoFolderWithExistingFilename,
  overdeepLocalPathIsReportedBeforeUpload,
  runFolderMoveCase,
  unportableNameNeverSyncsAndIsLeftAlone,
} from './folder-scenarios.mjs';
import {
  hostedFullVaultRaisesTheVaultFullBanner,
  hostedLapsedSubscriptionPausesWritesAndKeepsReads,
  hostedNoVaultShapeReachesAFirstSync,
  hostedPairingBetweenTwoDesktopInstances,
  hostedRestartSyncsAtLaunchWithoutOpeningSettings,
  hostedSignOutKeepsTheNotesOnDisk,
  hostedVaultExistsUnlocksByRecoveryKey,
  hostedVaultExistsUnlocksByVaultPassword,
} from './hosted-sync-scenarios.mjs';
import {
  distinctSameBasenameSurvivesMoveDedup,
  editVsPeerDeletePreservesEdit,
  imageSyncRoundtrip,
  peerDeletesWhileDisconnected,
} from './image-and-data-safety-scenarios.mjs';
import { parkInsideAKeyboardSwitchLeavesTheSwitchAlone } from './note-switch-parking-scenarios.mjs';
import {
  collisionNameUsesFullObjectIdentity,
  collisionPlacementFollowsOpenNote,
  editDuringSyncKeepsLocalDraft,
  focusedOpenNoteDefersPeerEditUntilBlur,
} from './open-note-conflict-scenarios.mjs';
import {
  focusedTypistAfterDeferredPeerEditMintsOneCopy,
  peerRenameWhileSavePendingLeavesNoGhost,
} from './peer-edit-copy-scenarios.mjs';
import {
  aNoteThatIsNotUtf8NeverOpensBlank,
  renameRelinkingTheOpenNoteDoesNotPark,
} from './relink-and-encoding-scenarios.mjs';
import {
  backlinkRewritePropagation,
  concurrentEditConflict,
  editorRoundtripThroughRealSync,
  renamePropagation,
  threeWayMerge,
} from './roundtrip-and-merge-scenarios.mjs';

// ── Scenario registry ───────────────────────────────────────────

export const scenarios = [
  { name: 'image sync roundtrip', fn: imageSyncRoundtrip, matrices: ['desktop-desktop'] },
  {
    name: 'editor roundtrip through real sync',
    fn: editorRoundtripThroughRealSync,
    matrices: ['desktop-desktop'],
  },
  {
    name: 'edit during sync keeps local draft',
    fn: editDuringSyncKeepsLocalDraft,
    serverOptions: { syncDelayMs: 1500 },
    matrices: ['desktop-desktop'],
  },
  {
    name: 'dirty draft survives a peer edit then settles',
    fn: dirtyDraftSurvivesAPeerEditThenSettles,
    matrices: ['desktop-desktop'],
  },
  { name: 'concurrent edit conflict', fn: concurrentEditConflict, matrices: ['desktop-desktop'] },
  { name: 'three way merge', fn: threeWayMerge, matrices: ['desktop-desktop'] },
  { name: 'rename propagation', fn: renamePropagation, matrices: ['desktop-desktop'] },
  {
    name: 'backlink rewrite propagation',
    fn: backlinkRewritePropagation,
    matrices: ['desktop-desktop'],
  },
  {
    name: 'collision placement follows open note',
    fn: collisionPlacementFollowsOpenNote,
    matrices: ['desktop-desktop'],
  },
  {
    name: 'collision name uses full object identity',
    fn: collisionNameUsesFullObjectIdentity,
    matrices: ['desktop-desktop'],
  },
  {
    name: 'focused open note defers peer edit until blur',
    fn: focusedOpenNoteDefersPeerEditUntilBlur,
    matrices: ['desktop-desktop'],
  },
  {
    name: 'a focused typist after a deferred peer edit mints exactly one copy',
    fn: focusedTypistAfterDeferredPeerEditMintsOneCopy,
    matrices: ['desktop-desktop'],
  },
  {
    name: 'peer rename of the open note while a save is pending leaves no ghost',
    fn: peerRenameWhileSavePendingLeavesNoGhost,
    serverOptions: { syncDelayMs: 1500 },
    matrices: ['desktop-desktop'],
  },
  {
    name: 'a park inside a keyboard note switch leaves the switch alone',
    fn: parkInsideAKeyboardSwitchLeavesTheSwitchAlone,
    matrices: ['desktop-desktop'],
  },
  {
    name: 'a folder or note rename relinking the open note does not park and keeps the typed word',
    fn: renameRelinkingTheOpenNoteDoesNotPark,
    matrices: ['desktop-desktop'],
  },
  {
    name: 'a note that is not UTF-8 never opens blank and a relink leaves its bytes alone',
    fn: aNoteThatIsNotUtf8NeverOpensBlank,
    matrices: ['desktop-desktop'],
  },
  // Folder-support v1 + pair_local_moved_objects rows — see FOLDER_MOVE_CASES.
  ...FOLDER_MOVE_CASES.map((row) => ({
    name: row.name,
    fn: (a, b, server) => runFolderMoveCase(row, a, b, server),
    matrices: ['desktop-desktop'],
  })),
  {
    name: 'folder X and file X coexist at same level',
    fn: folderXVsFileXAtSameLevel,
    matrices: ['desktop-desktop'],
  },
  {
    name: 'move into folder with existing filename suffixes',
    fn: moveIntoFolderWithExistingFilename,
    matrices: ['desktop-desktop'],
  },
  { name: 'empty folder does not sync', fn: emptyFolderDoesNotSync, matrices: ['desktop-desktop'] },
  {
    name: 'unportable name never syncs and is left alone',
    fn: unportableNameNeverSyncsAndIsLeftAlone,
    matrices: ['desktop-desktop'],
  },
  {
    name: 'overdeep local path is reported before upload',
    fn: overdeepLocalPathIsReportedBeforeUpload,
    matrices: ['desktop-desktop'],
  },
  // TODO(justin): both external-watcher scenarios race under Docker/xvfb.
  // They swap which one hits the inotify delay run-to-run; one or the other
  // times out at 30s roughly half the time. Locally they pass in <2s, so
  // keep them enabled off-CI. Investigate separately — the notify crate's
  // event loop may be starved while the single-threaded xvfb renders, or
  // the CodeMirror update path may be blocked by unrelated IPC traffic.
  {
    name: 'external watcher reloads clean note',
    fn: externalWatcherReloadsCleanNote,
    matrices: ['desktop-desktop'],
    skipOnCi: true,
  },
  {
    name: 'external watcher protects dirty draft then settles',
    fn: externalWatcherProtectsDirtyDraftThenSettles,
    matrices: ['desktop-desktop'],
    skipOnCi: true,
  },
  {
    name: 'an external atomic save onto the open note is adopted',
    fn: externalAtomicSaveOntoTheOpenNoteIsAdopted,
    matrices: ['desktop-desktop'],
    skipOnCi: true,
  },
  { name: 'delete vs edit', fn: deleteVsEdit, matrices: ['desktop-desktop'] },
  {
    name: 'peer delete of open note closes editor',
    fn: peerDeleteOfOpenNoteClosesEditor,
    matrices: ['desktop-desktop'],
  },
  { name: 'lost state recovery', fn: lostStateRecovery, matrices: ['desktop-desktop'] },
  {
    name: 'self hosted bearer stays out of vault',
    fn: selfHostedBearerStaysOutOfVault,
    matrices: ['desktop-desktop'],
  },
  { name: 'rapid reconnect', fn: rapidReconnect, matrices: ['desktop-desktop'] },
  { name: 'offline accumulation', fn: offlineAccumulation, matrices: ['desktop-desktop'] },
  // slow: ~2 minutes of a ~4-minute scenario budget for a scale probe whose
  // mechanisms (upload, download, batching) cheap scenarios each cover.
  { name: 'large sync', fn: largeSync, matrices: ['desktop-desktop'], slow: true },
  {
    name: 'tombstone does not block new note',
    fn: tombstoneDoesNotBlockNewNote,
    matrices: ['desktop-desktop'],
  },
  // PKT-2 sync data-safety (F1 / F3 / F9).
  {
    name: 'peer deletes while disconnected',
    fn: peerDeletesWhileDisconnected,
    matrices: ['desktop-desktop'],
  },
  {
    name: 'edit vs peer delete preserves edit',
    fn: editVsPeerDeletePreservesEdit,
    matrices: ['desktop-desktop'],
  },
  {
    name: 'distinct same basename survives move dedup',
    fn: distinctSameBasenameSurvivesMoveDedup,
    matrices: ['desktop-desktop'],
  },
  // Hosted sync (Log in with FUTO). Each needs a server in stand-in test mode,
  // which the pinned release does not carry yet — so on CI they skip with the
  // reason printed, and locally they run against a server built from the
  // `hosted-server` branch (FUTO_NOTES_E2EE_SERVER_REPO).
  {
    name: 'hosted no vault shape reaches a first sync',
    fn: hostedNoVaultShapeReachesAFirstSync,
    matrices: ['desktop-desktop'],
    hosted: true,
  },
  {
    name: 'hosted vault exists unlocks by vault password',
    fn: hostedVaultExistsUnlocksByVaultPassword,
    matrices: ['desktop-desktop'],
    hosted: true,
  },
  {
    name: 'hosted vault exists unlocks by recovery key',
    fn: hostedVaultExistsUnlocksByRecoveryKey,
    matrices: ['desktop-desktop'],
    hosted: true,
  },
  {
    name: 'hosted pairing between two desktop instances',
    fn: hostedPairingBetweenTwoDesktopInstances,
    matrices: ['desktop-desktop'],
    hosted: true,
  },
  {
    name: 'hosted lapsed subscription pauses writes and keeps reads',
    fn: hostedLapsedSubscriptionPausesWritesAndKeepsReads,
    matrices: ['desktop-desktop'],
    hosted: true,
  },
  {
    name: 'hosted full vault raises the vault full banner',
    fn: hostedFullVaultRaisesTheVaultFullBanner,
    matrices: ['desktop-desktop'],
    hosted: true,
  },
  {
    name: 'hosted sign out keeps the notes on disk',
    fn: hostedSignOutKeepsTheNotesOnDisk,
    matrices: ['desktop-desktop'],
    hosted: true,
  },
  {
    name: 'hosted restart syncs at launch without opening settings',
    fn: hostedRestartSyncsAtLaunchWithoutOpeningSettings,
    matrices: ['desktop-desktop'],
    hosted: true,
  },
  // Native Android leg — runs whenever a usable device is reachable, and is
  // skipped LOUDLY otherwise (see runAndroidLeg).
  {
    name: 'android receives a desktop note live',
    fn: androidReceivesDesktopNoteLive,
    matrices: [ANDROID_MATRIX],
  },
  {
    name: 'desktop receives an android editor edit',
    fn: desktopReceivesAndroidEditorEdit,
    matrices: [ANDROID_MATRIX],
  },
  {
    name: 'android defers a focused peer edit until blur',
    fn: androidDefersFocusedPeerEditUntilBlur,
    matrices: [ANDROID_MATRIX],
  },
  {
    name: 'android keeps a draft typed while a peer edit is deferred',
    fn: androidKeepsADraftTypedWhileAPeerEditIsDeferred,
    matrices: [ANDROID_MATRIX],
  },
  {
    name: 'android keeps an unreported edit over a peer edit',
    fn: androidKeepsAnUnreportedEditOverAPeerEdit,
    matrices: [ANDROID_MATRIX],
  },
  {
    name: 'android keeps an unreported edit over a peer delete',
    fn: androidKeepsAnUnreportedEditOverAPeerDelete,
    matrices: [ANDROID_MATRIX],
  },
  {
    name: 'android follows a peer rename while open',
    fn: androidFollowsPeerRenameWhileOpen,
    matrices: [ANDROID_MATRIX],
  },
  {
    name: 'android conflicts with a desktop edit',
    fn: androidConflictsWithDesktopEdit,
    matrices: [ANDROID_MATRIX],
  },
];
