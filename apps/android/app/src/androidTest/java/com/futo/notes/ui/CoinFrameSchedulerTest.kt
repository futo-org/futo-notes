package com.futo.notes.ui

import android.view.Choreographer
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertTrue
import org.junit.Test

class CoinFrameSchedulerTest {
    @Test fun aCancelledDispatchCannotConsumeTheReplacement(): Unit {
        val dispatchTimes = CompletableFuture<Pair<Long, Long>>()
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            val choreographer = Choreographer.getInstance()
            val frames = ChoreographerCoinFrames()
            // Choreographer pulls both callbacks off its queue before running either one.
            choreographer.postFrameCallback { cancelledFrameTime ->
                frames.stopCoinFrames()
                frames.startCoinFrames { replacementFrameTime ->
                    dispatchTimes.complete(cancelledFrameTime to replacementFrameTime)
                    frames.stopCoinFrames()
                    true
                }
            }
            frames.startCoinFrames { error("The cancelled frame ran") }
        }
        val (cancelledFrameTime, replacementFrameTime) = dispatchTimes.get(10, TimeUnit.SECONDS)
        assertTrue("The cancelled dispatch ran the replacement", replacementFrameTime > cancelledFrameTime)
    }
}
