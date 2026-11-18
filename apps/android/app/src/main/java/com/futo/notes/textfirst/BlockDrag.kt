package com.futo.notes.textfirst

import android.animation.ValueAnimator
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.RectF
import android.graphics.Shader
import android.view.animation.PathInterpolator

// One lifted block on screen: its card, its dimmed place and the drop line (BlockLift.kt starts it).

/**
 * One drag on screen: what was lifted, its slots, where the finger holds it and what is drawn
 * for it. Geometry is read from the view's layout every time it is needed, keyed by text offsets,
 * so a photo loading or a scroll mid-drag re-measures and nothing is kept by screen position.
 * All y here are content coordinates (the layout's, plus the view's top padding).
 */
internal class BlockDrag private constructor(
    private val view: TextFirstEditText,
    val plan: LiftPlan,
    /** A photo lifted out of its line: its card is the photo, and it has no edges of its own. */
    private val photo: TfImage?,
    /** Where the card's content starts below the block's top, its height, and its sides. */
    private val cardFromTop: Float,
    private val contentHeight: Float,
    private val left: Float,
    private val right: Float,
    /** The finger at the lift, and the card's top-left then, in view coordinates. */
    private val liftX: Float,
    private val liftY: Float,
    private val cardX: Float,
    private val cardY: Float,
) {
    val book = SlotBook().apply { add(plan.slots, plan.covered) }
    var slot: BlockSlot? = null
        private set
    var fetching = false
    /** Released over a slot, waiting for the move to land. */
    var landing = false
    private var dx = 0f
    private var dy = 0f
    private var scale = ENTER_SCALE
    private var animator: ValueAnimator? = null
    private val capped get() = contentHeight < sourceHeight()
    private val d = view.style.density

    private fun sourceHeight(): Float = sourceRect()?.height() ?: contentHeight

    /** The block's top and bottom as laid out now (a photo's own box), content coordinates. */
    private fun sourceRect(): RectF? {
        photo?.let { return view.imageRect(it) }
        val top = view.boundaryY(BlockSlot(plan.block.start, false)) ?: return null
        val bottom = view.boundaryY(BlockSlot(plan.block.end, plan.block.toEnd)) ?: return null
        return RectF(0f, top, view.width.toFloat(), bottom)
    }

    /** Where it may land as drawn now: the slots on screen and its own edges as far as they show. */
    fun targets(): DropTargets {
        val top = view.scrollY.toFloat()
        val bottom = top + view.height
        val near = view.visibleChars()
        val slots = if (near == null) emptyList() else book.slotsIn(near).mapNotNull { s ->
            view.boundaryY(s)?.takeIf { it in top..bottom }?.let { s to it }
        }
        val source = sourceRect()
        val own = when {
            source == null || source.bottom < top || source.top > bottom -> null
            photo != null -> source.centerY() to source.centerY()
            else -> maxOf(source.top, top) to minOf(source.bottom, bottom)
        }
        return DropTargets(slots, own)
    }

    /** The finger is at ([x], [y]) in view coordinates: the card follows it and the drop line moves to the nearest slot. True when it reached a slot it was not on. */
    fun follow(x: Float, y: Float): Boolean {
        dx = x - liftX
        dy = y - liftY
        val previous = slot
        slot = targets().nearest(y + view.scrollY)?.first
        return slot != null && slot != previous
    }

    /**
     * How the view keeps its place when the block lands on [to]: a block taken from above the
     * screen would pull everything on it up by its height, so the line drawn just above the
     * drop line is held where it is; otherwise the scroll stays.
     */
    fun holdFor(to: BlockSlot): DropHold {
        val source = sourceRect() ?: return DropHold.KEEP
        if (plan.block.start >= to.offset || source.top > view.scrollY + 0.5f) return DropHold.KEEP
        val e = view.editableText ?: return DropHold.KEEP
        val lineStart = e.lastIndexOf('\n', to.offset - 2) + 1
        val top = view.boundaryY(BlockSlot(lineStart, false)) ?: return DropHold.KEEP
        val middle = lineStart + (to.offset - lineStart) / 2 - (plan.block.end - plan.block.start)
        return DropHold(middle.coerceAtLeast(0), (top - view.scrollY).toInt())
    }

    fun enter() {
        animator = ValueAnimator.ofFloat(ENTER_SCALE, LIFTED_SCALE).apply {
            duration = ENTER_MS
            interpolator = PathInterpolator(0.2f, 0.9f, 0.3f, 1f)
            addUpdateListener { scale = it.animatedValue as Float; view.invalidate() }
            start()
        }
    }

    /** A card that did not land slides back to where it was lifted, then goes. */
    fun returnHome(done: () -> Unit) {
        animator?.cancel()
        slot = null
        val fromX = dx
        val fromY = dy
        animator = ValueAnimator.ofFloat(1f, 0f).apply {
            duration = RETURN_MS
            addUpdateListener { val f = it.animatedValue as Float; dx = fromX * f; dy = fromY * f; view.invalidate() }
            addListener(object : android.animation.AnimatorListenerAdapter() {
                override fun onAnimationEnd(animation: android.animation.Animator) { done() }
            })
            start()
        }
    }

    fun dispose() { animator?.cancel(); animator = null }

    // ---- drawing, after the text, in content coordinates ----

    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val shadow = Paint(Paint.ANTI_ALIAS_FLAG)
    private val border = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val fade = Paint().apply { xfermode = PorterDuffXfermode(PorterDuff.Mode.DST_OUT) }
    private val path = Path()

    fun draw(canvas: Canvas) {
        val look = view.style
        val source = sourceRect()
        // The block's place, dimmed (35% shows through), until the move lands.
        if (source != null) {
            fill.color = withAlpha(look.pageColor, 0.65f)
            canvas.drawRect(source, fill)
        }
        drawCard(canvas, source)
        // Over the card, which is under the finger, so it never fades.
        val at = slot?.takeIf { !landing }?.let { view.boundaryY(it) }
        if (at != null) {
            fill.color = look.linkColor
            val h = DROP_LINE_DP * d
            canvas.drawRoundRect(view.totalPaddingLeft - 6 * d, at - h / 2, view.width - view.totalPaddingRight + 6 * d, at + h / 2, h / 2, h / 2, fill)
        }
    }

    private fun drawCard(canvas: Canvas, source: RectF?) {
        val look = view.style
        val padY = if (photo != null) 0f else CARD_PAD_Y_DP * d
        val w = right - left
        val h = contentHeight + 2 * padY
        val save = canvas.save()
        canvas.translate(cardX + dx + view.scrollX, cardY + dy + view.scrollY)
        canvas.scale(scale, scale, w * 0.5f, h * 0.4f)
        val radius = CARD_RADIUS_DP * d
        path.reset()
        path.addRoundRect(0f, 0f, w, h, radius, radius, Path.Direction.CW)
        // Three soft shadows outside the card, the web editor's [offset y, blur, alpha].
        canvas.save()
        canvas.clipOutPath(path)
        for ((offsetY, blur, alpha) in SHADOWS) {
            shadow.color = look.pageColor
            shadow.setShadowLayer(blur * d, 0f, offsetY * d, android.graphics.Color.argb((alpha * 255).toInt(), 0, 0, 0))
            canvas.drawPath(path, shadow)
        }
        canvas.restore()
        // A see-through surface: only the background, the text stays opaque.
        fill.color = withAlpha(look.pageColor, 0.8f)
        canvas.drawPath(path, fill)
        border.color = look.borderColor
        border.strokeWidth = maxOf(1f, d)
        canvas.drawPath(path, border)
        if (source != null) {
            canvas.clipPath(path)
            val layer = if (capped) canvas.saveLayer(0f, padY, w, padY + contentHeight, null) else -1
            canvas.save()
            canvas.clipRect(0f, padY, w, padY + contentHeight)
            canvas.translate(-left, padY - (source.top + cardFromTop))
            view.drawLayoutRegion(canvas, plan.block.start, plan.block.end)
            canvas.restore()
            if (layer >= 0) {
                // Capped: the last part of what shows fades out.
                val fadeTop = padY + contentHeight - FADE_DP * d
                fade.shader = LinearGradient(0f, fadeTop, 0f, padY + contentHeight, 0, android.graphics.Color.BLACK, Shader.TileMode.CLAMP)
                canvas.drawRect(0f, fadeTop, w, padY + contentHeight, fade)
                canvas.restoreToCount(layer)
            }
        }
        canvas.restoreToCount(save)
    }

    companion object {
        private const val ENTER_SCALE = 0.97f
        private const val LIFTED_SCALE = 1.04f
        private const val ENTER_MS = 120L
        private const val RETURN_MS = 200L
        private const val CARD_RADIUS_DP = 14f
        private const val CARD_PAD_X_DP = 6f
        private const val CARD_PAD_Y_DP = 10f
        private const val FADE_DP = 56f
        private const val DROP_LINE_DP = 3f
        private const val MAX_SCREEN_FRACTION = 0.4f
        private val SHADOWS = listOf(Triple(1f, 2f, 0.12f), Triple(6f, 14f, 0.16f), Triple(20f, 44f, 0.24f))

        private fun withAlpha(color: Int, alpha: Float) = (color and 0x00ffffff) or ((alpha * 255).toInt() shl 24)

        /** The drag for [plan], held at ([x], [y]); null when no part of the block shows. */
        fun lift(view: TextFirstEditText, plan: LiftPlan, x: Float, y: Float): BlockDrag? {
            val e = view.editableText ?: return null
            val d = view.style.density
            val photo = e.getSpans(plan.block.start, plan.block.end, TfImage::class.java).firstOrNull {
                e.getSpanStart(it) == plan.block.start && e.getSpanEnd(it) == plan.block.end
            }?.takeIf { !coversWholeLines(e, plan.block) }
            val shownTop = view.scrollY.toFloat()
            val shownBottom = shownTop + view.height
            val source = if (photo != null) view.imageRect(photo) else {
                val top = view.boundaryY(BlockSlot(plan.block.start, false))
                val bottom = view.boundaryY(BlockSlot(plan.block.end, plan.block.toEnd))
                if (top == null || bottom == null) null else RectF(0f, top, view.width.toFloat(), bottom)
            } ?: return null
            // The part that shows, at most 40% of the screen's height.
            val top = maxOf(source.top, shownTop)
            val bottom = minOf(source.bottom, shownBottom)
            if (bottom <= top) return null
            val cap = view.resources.displayMetrics.heightPixels * MAX_SCREEN_FRACTION
            val height = minOf(bottom - top, cap)
            val left = if (photo != null) source.left else view.totalPaddingLeft - CARD_PAD_X_DP * d
            val right = if (photo != null) source.right else view.width - view.totalPaddingRight + CARD_PAD_X_DP * d
            val padY = if (photo != null) 0f else CARD_PAD_Y_DP * d
            return BlockDrag(
                view, plan, photo, top - source.top, height, left, right, x, y,
                cardX = left, cardY = top - padY - view.scrollY,
            )
        }

        /** Whether [block] runs from a line's start to the start of a line after it (or the end): what lifts with its lines. */
        private fun coversWholeLines(text: CharSequence, block: LiftedBlock): Boolean {
            val length = text.length - 1 // the end sentinel is not the note's
            val startsLine = block.start == 0 || text[block.start - 1] == '\n'
            val endsLine = block.end >= length || (block.end > 0 && text[block.end - 1] == '\n')
            return startsLine && endsLine
        }
    }
}
