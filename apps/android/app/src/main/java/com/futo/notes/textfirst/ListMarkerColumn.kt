package com.futo.notes.textfirst

import android.graphics.Paint

// The own marker column supplies level one. Add three full steps and
// four half steps, then retain a complete marker at the capped body edge.
internal fun listLead(look: TextFirstStyle, depth: Int): Float =
    look.listIndent * (depth.coerceIn(0, 3) + (depth - 3).coerceIn(0, 4) * 0.5f)

/**
 * The width of an item's marker column: one list step, or a number's whole label and its gap when that is wider, so a
 * long number is never clipped. The marker unit takes this width on the item's first row; wrapped rows hang past it.
 */
internal fun listMarkerColumn(look: TextFirstStyle, marker: ListMarker, label: String): Float {
    if (marker != ListMarker.Ordered) return look.listIndent
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { textSize = look.textSizePx; typeface = look.regular }
    val required = paint.measureText(label) + look.dp(LIST_NUMBER_GAP_DP)
    return if (required > look.listIndent) kotlin.math.ceil(required) else look.listIndent
}

/** The gap between a number and its item's text, in dp. */
internal const val LIST_NUMBER_GAP_DP = 5f
