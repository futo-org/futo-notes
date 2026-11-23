package com.futo.notes.textfirst

import android.text.Spannable

// A list marker unit is U+FFFC in the engine's display text and a no-break space in the note's Editable. U+FFFC lets a
// line break after it; a no-break space keeps the marker on its item's first word's row, on every API level. One
// character for one: every offset is the engine's. Only the Editable holds it: the keyboard, copy, find and every edit
// go through the engine's text.

/** What the Editable holds where the engine's display has a list marker unit. */
internal const val LIST_MARKER_UNIT_STORED = "\u00A0"

/** The positions in [text] whose U+FFFC is a list marker unit of [specs]: never a typed character, an image or a divider. */
internal fun listMarkerUnitPositions(text: CharSequence, specs: List<SpanSpec>): List<Int> =
    specs.filterIsInstance<SpanSpec.ListItemMarker>()
        .map { it.start }
        .filter { it in 0 until text.length && text[it] == ENGINE_MARKER_UNIT }

/** Store each list marker unit of [specs] in [target] as a no-break space. */
internal fun storeListMarkerUnits(target: Spannable, specs: List<SpanSpec>) {
    val editable = target as? android.text.Editable ?: return
    for (at in listMarkerUnitPositions(editable, specs)) editable.replace(at, at + 1, LIST_MARKER_UNIT_STORED)
}

private const val ENGINE_MARKER_UNIT = '\uFFFC'
