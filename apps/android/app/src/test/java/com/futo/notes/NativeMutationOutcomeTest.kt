package com.futo.notes

import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeMutationOutcomeTest {
    @Test
    fun `cancellation after the disk commit cannot skip shell projection`() = runBlocking {
        var isDiskCommitted = false
        var isShellProjected = false
        var hasTransactionReturned = false

        val mutation = launch {
            val callerJob = currentCoroutineContext().job
            runMutationTransaction {
                isDiskCommitted = true
                callerJob.cancel()
                isShellProjected = true
            }
            hasTransactionReturned = true
        }
        mutation.join()

        assertTrue(isDiskCommitted)
        assertTrue(isShellProjected)
        assertTrue(hasTransactionReturned)
    }

}
