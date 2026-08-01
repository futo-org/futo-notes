package com.futo.notes

import uniffi.futo_notes_ffi.RenamePair
import uniffi.futo_notes_ffi.SyncFailure
import uniffi.futo_notes_ffi.SyncSummary

/**
 * One builder for the FFI cycle report, so a new engine field is added in a
 * single place instead of breaking every sync test that happens to construct
 * one. Defaults describe a no-op cycle; each test names only what it is about.
 */
internal fun syncSummary(
    uploaded: UInt = 0u,
    downloaded: UInt = 0u,
    deleted: UInt = 0u,
    conflicts: UInt = 0u,
    localWritesApplied: UInt = 0u,
    failures: List<SyncFailure> = emptyList(),
    failureMessage: String? = null,
    updatedIds: List<String> = emptyList(),
    deletedIds: List<String> = emptyList(),
    peerUpdatedIds: List<String> = emptyList(),
    peerDeletedIds: List<String> = emptyList(),
    renamed: List<RenamePair> = emptyList(),
) = SyncSummary(
    uploaded = uploaded,
    downloaded = downloaded,
    deleted = deleted,
    conflicts = conflicts,
    localWritesApplied = localWritesApplied,
    failures = failures,
    failureMessage = failureMessage,
    updatedIds = updatedIds,
    deletedIds = deletedIds,
    peerUpdatedIds = peerUpdatedIds,
    peerDeletedIds = peerDeletedIds,
    renamed = renamed,
)
