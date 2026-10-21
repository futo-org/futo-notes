package com.futo.notes

import com.futo.notes.storage.StorageMode
import com.futo.notes.storage.StorageSwitchPlan

internal data class VaultSurfaceState(
    val renderShell: Boolean,
    val showMovingOverlay: Boolean,
)

internal fun vaultSurfaceState(
    hasStore: Boolean,
    needsRegrant: Boolean,
    storageSwitching: Boolean,
): VaultSurfaceState = VaultSurfaceState(
    renderShell = hasStore,
    showMovingOverlay = hasStore && storageSwitching && !needsRegrant,
)

/** A storage switch waiting on the user's confirmation to open an existing folder. */
internal data class PendingStorageAdoption(
    val mode: StorageMode,
    val plan: StorageSwitchPlan.OpenExisting,
)
