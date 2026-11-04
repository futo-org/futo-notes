package com.futo.notes

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

/** Retry budget for one post-sync list refresh. A refresh the store refuses
 *  (an attached draft whose rename destination is briefly leased) usually
 *  succeeds within a few seconds; one that does not is terminal. */
internal data class LocalTreeRetry(val attempts: Int = 5, val delayMs: Long = 2_000)

/**
 * Project one sync summary into the shell: a scoped refresh, retried a bounded
 * number of times, then a full rescan so the list recovers, then the summary is
 * published either way (the open editor reconciles itself from one atomic note
 * read). The caller serialises events, so this must always finish — a refresh
 * that fails forever would stall every later list update.
 *
 * [active] is false once a vault reset or epoch change retires the event; the
 * event is then abandoned without a rescan or publish.
 */
internal suspend fun <T> projectLocalTree(
    retry: LocalTreeRetry,
    active: () -> Boolean,
    refresh: suspend () -> T,
    apply: (T) -> Unit,
    rebuild: suspend () -> Unit,
    emit: suspend () -> Unit,
    log: (message: String, error: Throwable?) -> Unit = { _, _ -> },
) {
    var lastError: Exception? = null
    for (attempt in 1..retry.attempts) {
        if (!active()) return
        val result = try {
            refresh()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            lastError = e
            if (attempt < retry.attempts) delay(retry.delayMs)
            continue
        }
        if (!active()) return
        apply(result)
        emit()
        return
    }
    if (!active()) return
    log("scoped local-tree refresh failed; rebuilding snapshot", lastError)
    try {
        rebuild()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        log("local-tree snapshot recovery failed", e)
    }
    if (active()) emit()
}
