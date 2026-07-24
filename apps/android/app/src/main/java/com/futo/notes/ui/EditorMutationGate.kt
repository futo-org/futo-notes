package com.futo.notes.ui

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Serializes editor writes with destructive actions. The synchronous flag
 * closes the gap between the delete tap and the coroutine acquiring the lock.
 */
internal class EditorMutationGate {
    private val mutex = Mutex()

    @Volatile
    private var destructiveActionStarted = false

    val isDestructiveActionStarted: Boolean
        get() = destructiveActionStarted

    fun beginDestructiveAction() {
        destructiveActionStarted = true
    }

    fun cancelDestructiveAction() {
        destructiveActionStarted = false
    }

    suspend fun <T> runEditorMutation(block: suspend () -> T): T? =
        mutex.withLock {
            if (destructiveActionStarted) null else block()
        }

    suspend fun <T> runDestructiveMutation(block: suspend () -> T): T =
        mutex.withLock { block() }
}
