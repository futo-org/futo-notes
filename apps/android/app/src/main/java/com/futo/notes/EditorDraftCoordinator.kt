package com.futo.notes

/**
 * Admission control for fire-and-forget editor draft flushes.
 *
 * Rename, move, and delete advance an identity generation synchronously before
 * suspending. Flushes admitted under an older generation are rejected, while
 * the identity mutation waits for the previously admitted queue tail.
 */
internal class EditorDraftCoordinator {
    data class Admission(val id: String, val generation: Long)
    data class IdentityMutation(val id: String, val generation: Long)

    private val generations = mutableMapOf<String, Long>()
    private val blocked = mutableSetOf<String>()

    @Synchronized
    fun admit(id: String): Admission? =
        if (id in blocked) null else Admission(id, generations[id] ?: 0)

    @Synchronized
    fun permits(admission: Admission): Boolean =
        admission.id !in blocked &&
            (generations[admission.id] ?: 0) == admission.generation

    @Synchronized
    fun beginIdentityMutation(id: String): IdentityMutation {
        val generation = (generations[id] ?: 0) + 1
        generations[id] = generation
        blocked += id
        return IdentityMutation(id, generation)
    }

    @Synchronized
    fun finishIdentityMutation(mutation: IdentityMutation, committed: Boolean) {
        if (generations[mutation.id] != mutation.generation) return
        if (!committed) blocked -= mutation.id
    }

    /** A newly created/written note at a previously deleted id is a new owner. */
    @Synchronized
    fun reopen(id: String) {
        if (id !in blocked) return
        generations[id] = (generations[id] ?: 0) + 1
        blocked -= id
    }
}
