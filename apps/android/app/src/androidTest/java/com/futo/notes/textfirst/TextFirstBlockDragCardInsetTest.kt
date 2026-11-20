package com.futo.notes.textfirst

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.PointF
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.io.File

/**
 * Mason (S23, batch 3): the lifted card had uneven page-colour strips around the block, different for each kind. The
 * card is what the block draws plus one inset, the same on all four sides for every kind.
 */
class TextFirstBlockDragCardInsetTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    /** The block holding [word] in [note], lifted and carried over the empty page below the note: its four margins. */
    private fun margins(kind: String, note: String, word: String?, files: Map<String, ByteArray> = emptyMap()) = compose.openDragScreen(note, files) {
        if (files.isNotEmpty()) compose.waitUntil(5_000) { ui { view.text!!.getSpans(0, view.length(), TfImage::class.java).all { it.bitmap != null } } }
        val from = if (word != null) at(offsetOf(word)) else ui {
            val r = checkNotNull(view.imageRect(view.text!!.getSpans(0, view.length(), TfImage::class.java).first()))
            val loc = IntArray(2).also(view::getLocationOnScreen)
            PointF(loc[0] + r.centerX(), loc[1] + r.centerY() - view.scrollY)
        }
        // What the block draws in the note before it lifts: anything not the page's white within its rows, in the window.
        val before = screenshot()
        val window = ui { IntArray(2).also(view.rootView::getLocationOnScreen) }
        down(from); hold(600)
        assertTrue("lifted", lifted)
        SystemClock.sleep(400)
        val block = ui { view.blockLift.drag!!.plan.block }
        // A photo's own box (lifted out of its line it has no rows of its own), else the block's rows.
        val (rowTop, rowBottom) = ui {
            val at = IntArray(2).also(view::getLocationInWindow)
            val photo = if (word == null) view.imageRect(view.text!!.getSpans(0, view.length(), TfImage::class.java).first()) else null
            if (photo != null) (at[1] + photo.top - view.scrollY) to (at[1] + photo.bottom - view.scrollY)
            else (at[1] + view.boundaryY(BlockSlot(block.start, false))!! - view.scrollY) to (at[1] + view.boundaryY(BlockSlot(block.end, block.toEnd))!! - view.scrollY)
        }
        var inkLeft = Int.MAX_VALUE; var inkRight = -1; var inkTop = Int.MAX_VALUE; var inkBottom = -1
        for (y in (window[1] + rowTop).toInt() until (window[1] + rowBottom).toInt()) for (x in 0 until before.width) {
            val p = before.getPixel(x, y)
            if (Color.red(p) > 247 && Color.green(p) > 247 && Color.blue(p) > 247) continue
            inkLeft = minOf(inkLeft, x); inkRight = maxOf(inkRight, x); inkTop = minOf(inkTop, y); inkBottom = maxOf(inkBottom, y)
        }
        val card = ui { view.blockLift.drag!!.cardInWindow() }
        val m = listOf(inkLeft - window[0] - card.left, card.right - (inkRight + 1 - window[0]), inkTop - window[1] - card.top, card.bottom - (inkBottom + 1 - window[1]))
        val inset = ui { view.style.dp(8f) }
        android.util.Log.i("CARDINSET", "$kind left=${m[0].toInt()} right=${m[1].toInt()} top=${m[2].toInt()} bottom=${m[3].toInt()} (inset ${inset.toInt()} px)")
        val shot = screenshot()
        val dir = InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null)
        val crop = android.graphics.Rect((window[0] + card.left - 30).toInt().coerceAtLeast(0), (window[1] + card.top - 30).toInt().coerceAtLeast(0),
            (window[0] + card.right + 30).toInt().coerceAtMost(shot.width), (window[1] + card.bottom + 30).toInt().coerceAtMost(shot.height))
        File(dir, "card-$kind.png").outputStream().use { Bitmap.createBitmap(shot, crop.left, crop.top, crop.width(), crop.height()).compress(Bitmap.CompressFormat.PNG, 100, it) }
        up(from)
        compose.waitUntil(5_000) { !lifted }
        for (side in m) assertTrue("$kind: margins $m, each the inset $inset", kotlin.math.abs(side - inset) <= 3f)
    }

    @Test fun aCodeBlock() = margins("code", "intro\n\n```js\nconst a = 1\nconst b = 2\n```\n\nend", "const a")
    @Test fun aPhotoAlone() = margins("photo", "intro\n\n![](p.png)\n\nend", null, mapOf("p.png" to png(300, 200)))
    @Test fun aPhotoInline() = margins("photo-inline", "intro\n\nNice!![](p.png)\n\nend", null, mapOf("p.png" to png(300, 200)))
    @Test fun aOneLineParagraph() = margins("paragraph", "intro\n\nA single line here.\n\nend", "single")
    @Test fun aWrappedParagraph() = margins("wrapped", "intro\n\nA paragraph long enough to wrap onto a second and a third visual line on a phone screen, for the card.\n\nend", "paragraph")
    @Test fun aHeading() = margins("heading", "intro\n\n## A heading\n\nend", "heading")
    @Test fun aNestedListItem() = margins("list", "intro\n\n- parent\n  - child item\n\nend", "child")
    @Test fun aQuote() = margins("quote", "intro\n\n> A quoted line\n\nend", "quoted")
    @Test fun aTable() = margins("table", "intro\n\n| a | b |\n| - | - |\n| c | d |\n\nend", "c |")
}
