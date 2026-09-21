package com.futo.notes.license

import android.graphics.Paint
import android.graphics.Typeface
import androidx.compose.ui.platform.LocalFontFamilyResolver
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontSynthesis
import androidx.compose.ui.text.font.FontWeight
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.futo.notes.ui.theme.FutoType
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The license key is set in a face where every character it can contain is the
 * same width, so revealing the key swaps glyph for glyph and nothing on the
 * plate moves.
 *
 * This measures the face the plate will actually draw with, rather than
 * asserting which family the token names, because the family that *says*
 * monospace is not always monospace: a phone with a system font theme applied
 * (Motorola Styles, and the Samsung/OnePlus equivalents) answers
 * `FontFamily.Monospace` — and `android.graphics.Typeface.MONOSPACE` — with a
 * proportional grotesk, which is exactly how this shipped broken on a moto g
 * play running "Rookery" (@justin 2026-09-18).
 *
 * It also covers the mask: the middle dot is part of the alphabet here, because
 * a face that has every letter on the grid but falls back for U+00B7 breaks the
 * swap just as thoroughly.
 */
@RunWith(AndroidJUnit4::class)
class LicenseKeyFontTest {
    @get:Rule
    val compose = createComposeRule()

    /** Everything a FUTOpay key can contain, plus the character that masks it. */
    private val alphabet: List<Char> =
        ('A'..'Z').toList() + ('0'..'9').toList() + listOf('-', '·')

    @Test
    fun everyCharacterTheKeyCanContainIsTheSameWidth() {
        var resolved: Typeface? = null
        compose.setContent {
            val resolver = LocalFontFamilyResolver.current
            resolved = resolver.resolve(
                fontFamily = FutoType.plateKey.fontFamily,
                fontWeight = FutoType.plateKey.fontWeight ?: FontWeight.Normal,
                fontStyle = FutoType.plateKey.fontStyle ?: FontStyle.Normal,
                fontSynthesis = FontSynthesis.None,
            ).value as Typeface
        }
        compose.waitForIdle()

        val paint = Paint().apply {
            typeface = checkNotNull(resolved) { "the key style resolved to no typeface" }
            // Big enough that a one-unit metric difference cannot round away.
            textSize = 400f
        }
        val widths = alphabet.associateWith { paint.measureText(it.toString()) }

        assertEquals(
            "the key's face is not monospace — advances: $widths",
            1,
            widths.values.distinct().size,
        )
    }
}
