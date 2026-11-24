package com.futo.notes.ui

import android.view.TextureView
import android.widget.FrameLayout
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

class SupporterCoinFrameTest {
    @get:Rule val compose = createComposeRule()
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    @Test fun aPausedCoinStopsCallbacksAndRendersAgainWhenVisible() = withCoin { coin ->
        compose.runOnIdle { coin.scene.setVisible(true) }
        awaitRender(coin)
        compose.runOnIdle {
            coin.scene.setVisible(false)
            assertFalse(coin.frames.hasFrame)
            coin.scene.setVisible(true)
            assertTrue(coin.frames.hasFrame)
        }
        awaitRender(coin)
    }

    @Test fun aDetachedSurfaceStopsCallbacksAndRendersAfterReattachment() = withCoin { coin ->
        compose.runOnIdle { coin.scene.setVisible(true) }
        awaitRender(coin)
        compose.runOnIdle { coin.container.removeView(coin.texture) }
        compose.waitUntil(5_000) { compose.runOnUiThread { !coin.texture.isAvailable } }
        compose.runOnIdle {
            assertFalse(coin.frames.hasFrame)
            coin.container.addView(coin.texture)
        }
        compose.waitUntil(5_000) { compose.runOnUiThread { coin.texture.isAvailable } }
        awaitRender(coin)
    }

    @Test fun aPauseRequestedBeforeTheFirstFrameTakesEffectAfterItRenders() = withCoin { coin ->
        compose.runOnIdle {
            coin.scene.setVisible(true)
            coin.scene.setVisible(false)
            assertEquals(0, coin.frames.renders)
            assertTrue(coin.frames.hasFrame)
        }
        awaitRender(coin)
        compose.runOnIdle { assertFalse(coin.frames.hasFrame) }
    }

    private fun awaitRender(coin: CoinFixture): Unit {
        val renderedBefore = compose.runOnIdle { coin.frames.renders }
        compose.waitUntil(15_000) {
            compose.runOnUiThread {
                coin.frames.dispatch()
                coin.frames.renders > renderedBefore
            }
        }
    }

    private fun withCoin(check: (CoinFixture) -> Unit): Unit {
        assumeTrue(FilamentSupport.glIsNewEnough(context))
        lateinit var coin: CoinFixture
        compose.setContent {
            AndroidView(modifier = Modifier.size(160.dp), factory = { activity ->
                FilamentSupport.renderSucceeded(activity)
                FilamentSupport.beginRenderAttempt(activity)
                val texture = FilamentRuntime.surface(activity)
                val frames = CountedCoinFrames()
                val container = FrameLayout(activity).apply { addView(texture) }
                coin = CoinFixture(container, texture, CoinScene(activity, texture, animates = true, frames), frames)
                container
            })
        }
        try {
            compose.waitUntil(5_000) { compose.runOnUiThread { coin.texture.isAvailable } }
            check(coin)
        } finally {
            compose.runOnIdle { coin.scene.destroy() }
        }
    }

    private data class CoinFixture(
        val container: FrameLayout,
        val texture: TextureView,
        val scene: CoinScene,
        val frames: CountedCoinFrames,
    )

    private class CountedCoinFrames : CoinFrameScheduler {
        private var running: CoinFrame? = null
        var renders = 0
            private set
        val hasFrame: Boolean get() = running != null

        override fun startCoinFrames(frame: CoinFrame): Unit {
            if (running == null) running = frame
        }

        override fun stopCoinFrames(): Unit {
            running = null
        }

        fun dispatch(): Unit {
            val frame = running ?: return
            if (frame.render(System.nanoTime())) renders++
        }
    }
}
