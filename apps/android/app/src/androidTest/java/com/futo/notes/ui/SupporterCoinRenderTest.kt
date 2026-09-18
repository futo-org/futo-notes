package com.futo.notes.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The supporter coin is a Blender model rendered by Filament, and there is no way
 * to tell from the view tree whether that worked.
 *
 * Every interesting failure leaves a perfectly healthy TextureView behind: a
 * missing asset, a cubemap Filament rejected, a camera framing empty space, or —
 * the one this was written for — a metal with no environment to reflect, which
 * renders black rather than failing. So this reads the PIXELS and insists they
 * are gold, the same assertion the desktop coin's Playwright test makes.
 *
 * A TextureView is used rather than a SurfaceView partly for this: a SurfaceView's
 * content is composited by the system and comes back blank from a window capture.
 */
@RunWith(AndroidJUnit4::class)
class SupporterCoinRenderTest {
    @get:Rule
    val composeTestRule = createComposeRule()

    @Test
    fun theCoinRendersGold() {
        // The flat glyph is gold too, so on a device that cannot run Filament
        // this test would pass without Filament ever drawing anything. Skip
        // there rather than assert something it cannot see; CI's emulator runs
        // a GL that can (scripts/ci-android-emulator.sh).
        assumeTrue(
            "this device cannot run Filament — there is nothing 3D here to measure",
            FilamentSupport.canRender(
                InstrumentationRegistry.getInstrumentation().targetContext,
            ),
        )

        composeTestRule.setContent {
            Box(Modifier.testTag(TAG)) { SupporterCoin(diameter = 160.dp) }
        }
        composeTestRule.onNodeWithTag(FLAT_COIN_TAG).assertDoesNotExist()
        composeTestRule.onNodeWithTag(LIVE_COIN_TAG).assertExists()

        // Filament loads its assets and draws on the Choreographer, neither of
        // which Compose's idling resources know about, so the first composition
        // settling does not mean a frame has been drawn.
        //
        // Waiting on COVERAGE would be no wait at all: the test harness renders
        // on an opaque white backdrop, so every pixel is already opaque before
        // Filament has drawn anything. The signal that the coin arrived is gold.
        var sample: Sample? = null
        val deadline = System.currentTimeMillis() + 15_000
        while (System.currentTimeMillis() < deadline) {
            composeTestRule.waitForIdle()
            sample = sample(TAG)
            if (sample.gold > MINIMUM_COVERAGE) break
            Thread.sleep(250)
        }

        val measured = requireNotNull(sample) { "never captured the coin" }
        assertTrue(
            "the coin covered almost none of its box ($measured) — " +
                "the model probably never loaded",
            measured.opaque > MINIMUM_COVERAGE,
        )
        val goldShare = measured.gold.toDouble() / measured.opaque
        assertTrue(
            "only ${"%.0f".format(goldShare * 100)}% of the coin was gold ($measured) — " +
                "a black coin means the environment did not light the metal, a " +
                "white one means the exposure is wrong",
            goldShare > 0.8,
        )
    }

    /**
     * A device whose GL cannot run Filament gets the flat coin, and no attempt
     * is made to start the renderer.
     *
     * This is the path that used to be a crash rather than a fallback: Filament
     * aborts the process when a material fails to compile, so a licensed user on
     * such a device lost the whole app the moment Settings drew the coin. There
     * is no exception to catch, which is why the refusal has to happen before
     * Filament is handed a surface — and why this asserts the SURFACE is absent
     * and not merely that the glyph is present.
     */
    @Test
    fun aDeviceThatCannotRunFilamentGetsTheFlatCoin() {
        composeTestRule.setContent {
            Box(Modifier.testTag(TAG)) {
                SupporterCoin(diameter = 160.dp, glCanRunFilament = false)
            }
        }

        composeTestRule.onNodeWithTag(FLAT_COIN_TAG).assertExists()
        composeTestRule.onNodeWithTag(LIVE_COIN_TAG).assertDoesNotExist()
    }

    private data class Sample(
        val opaque: Int,
        val gold: Int,
        val red: Int,
        val green: Int,
        val blue: Int,
    ) {
        /// Named in failure messages because "not gold" is ambiguous on its own:
        /// near-black means the environment never lit the metal, near-white means
        /// the exposure blew it out, and anything else means it is not the coin.
        override fun toString() = "$opaque px, mean rgb($red, $green, $blue), $gold gold"
    }

    private fun sample(tag: String): Sample {
        val bitmap = composeTestRule.onNodeWithTag(tag).captureToImage().asAndroidBitmap()
        var opaque = 0
        var gold = 0
        var sumRed = 0L
        var sumGreen = 0L
        var sumBlue = 0L
        // Every 4th pixel in each direction: 1600 samples out of a 160dp box is
        // plenty to tell gold from black, and a full walk is slow on an emulator.
        for (x in 0 until bitmap.width step 4) {
            for (y in 0 until bitmap.height step 4) {
                val pixel = bitmap.getPixel(x, y)
                val red = pixel shr 16 and 0xFF
                val green = pixel shr 8 and 0xFF
                val blue = pixel and 0xFF
                // The Compose test harness draws on an OPAQUE WHITE backdrop, so
                // alpha cannot separate the coin from the space around it the way
                // it does on desktop's transparent canvas. Anything this close to
                // white is the backdrop: the coin's brightest gold still has its
                // blue channel far below this.
                if (red > 240 && green > 240 && blue > 240) continue
                opaque += 1
                // Gold is red >= green > blue by a clear margin.
                if (red > 70 && red >= green && green > blue + 25) gold += 1
                sumRed += red
                sumGreen += green
                sumBlue += blue
            }
        }
        if (opaque == 0) return Sample(0, 0, 0, 0, 0)
        // Kept for the failure message; nothing asserts on the mean.
        writeDiagnostic(bitmap)
        return Sample(
            opaque, gold,
            (sumRed / opaque).toInt(), (sumGreen / opaque).toInt(), (sumBlue / opaque).toInt(),
        )
    }

    /// Dropped where `adb pull` can reach it, so a failure can be LOOKED at
    /// rather than inferred from three numbers.
    private fun writeDiagnostic(bitmap: android.graphics.Bitmap) {
        val context = androidx.test.platform.app.InstrumentationRegistry
            .getInstrumentation().targetContext
        // filesDir, not external storage: the emulator images this runs on do not
        // all mount one, and `adb exec-out run-as` reaches this on a debug build.
        runCatching {
            java.io.File(context.filesDir, "supporter-coin.png")
                .outputStream()
                .use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
        }
    }

    private companion object {
        const val TAG = "supporter-coin-under-test"

        /// Face-on the coin covers about half its box, and edge-on far less, so
        /// this is deliberately well under either: it separates "a coin is there"
        /// from "the camera framed nothing", and nothing more.
        const val MINIMUM_COVERAGE = 300
    }
}
