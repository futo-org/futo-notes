package com.futo.notes.ui

import kotlin.random.Random
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The coin burst's physics, on the JVM.
 *
 * Three claims are worth a test, and none of them can be read off a screenshot:
 * the burst is CONFINED to the plate, it SETTLES rather than buzzing forever,
 * and it ENDS. A canvas full of coins that quietly leaked past the plate's edge,
 * or that never stopped asking for frames, would look perfectly fine in a still.
 *
 * The seeded `Random` makes a failure reproducible; the assertions are
 * invariants, so they hold for any seed. iOS asserts the same three in
 * `CoinShowerTests`, desktop's copy is `coinShower.ts` (drift concept
 * `supporter-coin-burst`).
 */
class CoinShowerTest {
    private val width = 360f
    private val height = 420f
    private val frame = 1f / 60f

    private fun burst(seed: Int = 7) = CoinBurst(
        width = width,
        height = height,
        originX = width / 2f,
        originY = 100f,
        random = Random(seed),
    )

    /** Runs the burst to its end, at most [frames] frames. */
    private fun run(burst: CoinBurst, frames: Int = 600) {
        var stepped = 0
        while (!burst.finished && stepped < frames) {
            burst.advance(frame)
            stepped += 1
        }
    }

    @Test
    fun `every coin stays inside the plate, on every frame`() {
        val burst = burst()
        var stepped = 0
        while (!burst.finished && stepped < 600) {
            burst.advance(frame)
            stepped += 1
            for (coin in burst.coins) {
                assertTrue(
                    "a coin left the left wall at frame $stepped: x=${coin.x} r=${coin.radius}",
                    coin.x - coin.radius >= -0.5f,
                )
                assertTrue(
                    "a coin left the right wall at frame $stepped: x=${coin.x}",
                    coin.x + coin.radius <= width + 0.5f,
                )
                assertTrue(
                    "a coin left the top at frame $stepped: y=${coin.y}",
                    coin.y - coin.radius >= -0.5f,
                )
                assertTrue(
                    "a coin left the bottom at frame $stepped: y=${coin.y}",
                    coin.y + coin.radius <= height + 0.5f,
                )
            }
        }
    }

    @Test
    fun `the burst heaps along the bottom of the plate`() {
        val burst = burst()
        run(burst)

        assertEquals(COIN_BURST_COUNT, burst.coins.size)
        // By the time it fades, the whole burst has come down: every coin is in
        // the bottom third, which is what makes it read as a heap rather than as
        // coins still flying when they vanish. Not every one is at REST — the
        // restitution is high on purpose and the last few are still bouncing
        // small — so the heap, not the rest flag, is the claim.
        assertTrue(
            "every coin should have come down: " +
                burst.coins.filter { it.y <= height * 0.66f }.map { it.y },
            burst.coins.all { it.y > height * 0.66f },
        )
        val resting = burst.coins.count { it.resting }
        assertTrue("most coins should be at rest, got $resting", resting > COIN_BURST_COUNT / 2)
        // Scattered rest lines, so 120 coins read as a heap rather than as a
        // gold rule drawn along the bottom edge.
        assertTrue(
            "the heap should have more than one rest line",
            burst.coins.filter { it.resting }.map { it.y }.distinct().size > 1,
        )
    }

    @Test
    fun `the burst fades out and finishes`() {
        val burst = burst()

        assertEquals(1f, burst.opacity, 0f)
        run(burst)

        assertTrue("the burst should have finished", burst.finished)
        assertEquals("a finished burst draws nothing", 0f, burst.opacity, 0f)
    }

    @Test
    fun `a huge frame delta cannot teleport a coin through a wall`() {
        // A backgrounded view hands back a huge first delta; unclamped, one
        // 300ms step would put a coin outside the plate and it would be caught
        // there and bounced every frame after.
        val burst = burst()
        burst.advance(0.3f)

        for (coin in burst.coins) {
            assertTrue("x=${coin.x}", coin.x - coin.radius >= -0.5f)
            assertTrue("x=${coin.x}", coin.x + coin.radius <= width + 0.5f)
            assertTrue("y=${coin.y}", coin.y + coin.radius <= height + 0.5f)
        }
    }
}
