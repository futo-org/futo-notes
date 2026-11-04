package com.futo.notes.textfirst

import android.graphics.Color
import androidx.activity.ComponentActivity
import androidx.core.content.res.ResourcesCompat
import com.futo.notes.R
import java.io.File
import uniffi.futo_notes_ffi.NoteStore

/** The editor under test, styled like the app, for the classes that drive it through a bare activity. */
internal fun createTextFirstController(activity: ComponentActivity, core: () -> NoteStore, root: File): TextFirstController {
    val metrics = activity.resources.displayMetrics
    val regular = ResourcesCompat.getFont(activity, R.font.barlow_regular)!!
    return TextFirstController(activity, core, root, TextFirstStyle(
        metrics.density, 17f * metrics.scaledDensity, regular,
        ResourcesCompat.getFont(activity, R.font.barlow_semibold)!!,
        ResourcesCompat.getFont(activity, R.font.barlow_bold)!!,
        ResourcesCompat.getFont(activity, R.font.jetbrains_mono_regular)!!,
        Color.BLACK, Color.GRAY, Color.BLUE, Color.GRAY, Color.WHITE, Color.WHITE,
        italic = ResourcesCompat.getFont(activity, R.font.barlow_italic)!!,
        boldItalic = ResourcesCompat.getFont(activity, R.font.barlow_bold_italic)!!,
        semiboldItalic = ResourcesCompat.getFont(activity, R.font.barlow_semibold_italic)!!,
    ))
}
