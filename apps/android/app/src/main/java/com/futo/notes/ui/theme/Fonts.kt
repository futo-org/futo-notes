package com.futo.notes.ui.theme

import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import com.futo.notes.R

/**
 * FUTO Notes — type tokens. Brand typeface is **Barlow** (a low-contrast,
 * lightly engineered grotesk — tactile and precise), bundled as TTFs in
 * res/font (offline, "file over app" — no Google Play download dependency).
 *
 * Working weights: 600 (display/headings), 500 (titles, buttons, UI labels),
 * 400 (body & captions). Tracking is tight & negative, easing off as size grows.
 */
val Barlow = FontFamily(
    Font(R.font.barlow_regular, FontWeight.Normal),
    Font(R.font.barlow_medium, FontWeight.Medium),
    Font(R.font.barlow_semibold, FontWeight.SemiBold),
    Font(R.font.barlow_bold, FontWeight.Bold),
)

/**
 * The license key's face, bundled rather than borrowed.
 *
 * `FontFamily.Monospace` is NOT monospace on every Android: a phone with a
 * system font theme applied — Motorola's Styles, and the Samsung/OnePlus
 * equivalents — replaces the platform typefaces, and the themed replacement for
 * `monospace` is a proportional grotesk. On a moto g play (Android 13) running
 * the "Rookery" theme, even `android.graphics.Typeface.MONOSPACE` measures
 * proportional, so the masked key and the revealed key are different widths and
 * the plate visibly jumps when the key is revealed (@justin 2026-09-18). That
 * defeats the only reason the value is set in a monospace face at all.
 *
 * JetBrains Mono NL 2.304 (SIL OFL 1.1, `apps/android/licenses/`) is the face
 * the plate was mocked with (docs/plan/license-ship.md D10, which said no new
 * font file would ship — this is that decision reversed, with the reason
 * above). NL = no ligatures: a license key must never fuse two characters into
 * one glyph. Every character a key can contain, plus the mask's middle dot,
 * measures 600/1000 em, which is what `LicenseKeyFontTest` holds.
 *
 * Only the key uses it. Inline code spans and the crash report still ask for
 * the platform's monospace stack: they carry no width contract, and they have
 * to render whatever a note contains, which a single bundled face cannot
 * promise.
 */
val FutoMono = FontFamily(Font(R.font.jetbrains_mono_regular, FontWeight.Normal))
