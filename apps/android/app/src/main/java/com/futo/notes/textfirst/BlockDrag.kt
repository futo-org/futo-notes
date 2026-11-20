package com.futo.notes.textfirst

import android.animation.ValueAnimator
import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.PixelFormat
import android.graphics.drawable.Drawable
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.RectF
import android.graphics.Shader
import android.view.animation.PathInterpolator

// One lifted block on screen: its card, and either the reflow preview (BlockReflowPreview.kt,
// #450) or, when animations are off or the preview cannot be built, its dimmed place and the
// drop line (#444). BlockLift.kt starts it.

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
    /** Where the card's content starts below the block's top: the part that showed at the lift. */
    private val cardFromTop: Float,
    /** The finger at the lift, in view coordinates. */
    private val liftX: Float,
    private val liftY: Float,
) {
    val book = SlotBook().apply { add(plan.slots, plan.covered) }
    var slot: BlockSlot? = null
        private set
    /** The reflow preview; null when the drag uses the drop line. */
    val reflow: BlockReflowPreview? = reflowFor(view, plan, book, photo)
    /** What the preview showed at the release, to find again once the move lands. */
    var capture: ReflowCapture? = null
    /** The engine revision the move landed at, while the landing slides. */
    var landedAt: ULong? = null
    var fetching = false
    /** Released over a slot, waiting for the move to land. */
    var landing = false
    private var dx = 0f
    private var dy = 0f
    private var scale = ENTER_SCALE
    private var animator: ValueAnimator? = null
    private val d = view.style.density
    /** The one margin between what the block draws and the card's edge, the same on all four sides for every kind. */
    private val padY = CARD_INSET_DP * d

    /** The card's sides, the content y it shows from, how much it shows and whether that is cut short. */
    private class Card(val left: Float, val right: Float, val from: Float, val height: Float, val capped: Boolean)
    private var lastCard: Card? = null
    /** The source the last card was measured from: its ink is drawn again only when the layout moves it. */
    private var measuredFrom: RectF? = null

    /** The card's top-left at the lift, in view coordinates: what the block draws stays where it was. */
    private val cardX: Float
    private val cardY: Float

    init {
        val card = card()
        cardX = card.left - view.scrollX
        cardY = card.from - padY - view.scrollY
    }

    /**
     * The card as the block is laid out now (a photo decoding, a new width): what the block draws, from the part that
     * showed at the lift, plus the one inset; at most 40% of the screen tall.
     */
    private fun card(source: RectF? = sourceRect()): Card {
        if (source == null) return checkNotNull(lastCard)
        lastCard?.let { if (source == measuredFrom) return it }
        val shownTop = source.top + cardFromTop
        // The whole card, insets included, is at most the screen fraction.
        val cap = view.resources.displayMetrics.heightPixels * MAX_SCREEN_FRACTION - 2 * padY
        // A photo is its own box (the text on its line stays); a block is measured no further than the card can show.
        val measuredTo = minOf(source.bottom, shownTop + cap)
        val ink = (if (photo != null) RectF(source) else view.blockInkBounds(plan.block.start, plan.block.end, shownTop, measuredTo))
            ?: RectF(view.totalPaddingLeft.toFloat(), shownTop, (view.width - view.totalPaddingRight).toFloat(), measuredTo)
        val shows = maxOf(1f, if (measuredTo < source.bottom) source.bottom - ink.top else ink.height())
        measuredFrom = RectF(source)
        return Card(ink.left - padY, ink.right + padY, ink.top, minOf(shows, cap), shows > cap).also { lastCard = it }
    }

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
        reflow?.let { r -> return r.follow(y + view.scrollY).also { slot = r.slot } }
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
        // The preview's tiles are recorded after the lift's frame, before the gap first moves.
        reflow?.let { later(0) { if (!it.drawing) it.tiles.warm() } }
        animator = ValueAnimator.ofFloat(ENTER_SCALE, LIFTED_SCALE).apply {
            duration = ENTER_MS
            interpolator = PathInterpolator(0.2f, 0.9f, 0.3f, 1f)
            addUpdateListener { scale = it.animatedValue as Float; invalidate() }
            start()
        }
    }

    /** A card that did not land slides back over its block, where it is drawn now (the note may have scrolled), then goes. */
    fun returnHome(done: () -> Unit) {
        animator?.cancel()
        slot = null
        val fromX = dx
        val fromY = dy
        animator = ValueAnimator.ofFloat(1f, 0f).apply {
            duration = RETURN_MS
            addUpdateListener {
                val f = it.animatedValue as Float
                val home = card().from - padY - view.scrollY - cardY
                dx = fromX * f
                dy = fromY * f + home * (1 - f)
                invalidate()
            }
            addListener(object : android.animation.AnimatorListenerAdapter() {
                override fun onAnimationEnd(animation: android.animation.Animator) { done() }
            })
            start()
        }
    }

    /** The card goes at once (the release, with reflow): the preview stays until the block lands. */
    fun dropCard() {
        animator?.cancel()
        animator = null
        overlay?.remove(floating)
        overlay = null
    }

    /** Draw the note as the reflow preview has it; false when the view draws it itself. */
    fun drawNote(canvas: Canvas): Boolean = reflow?.takeIf { it.drawing }?.draw(canvas) ?: false

    private val queued = ArrayList<Runnable>()

    /** Run [work] after [ms] unless this drag has been disposed first. */
    fun later(ms: Long, work: () -> Unit) {
        val r = Runnable { work() }
        queued += r
        view.postDelayed(r, ms)
    }

    /** The drop line's slot while it shows on screen with the lifted block laid out; null otherwise (a view cut for a new width). */
    fun shownSlot(): BlockSlot? {
        val s = slot ?: return null
        sourceRect() ?: return null
        val y = view.boundaryY(s) ?: return null
        return s.takeIf { y >= view.scrollY && y <= view.scrollY + view.height }
    }

    fun dispose() {
        for (r in queued) view.removeCallbacks(r)
        queued.clear()
        reflow?.landing?.cancel()
        reflow?.tiles?.clear()
        animator?.cancel()
        animator = null
        // From the overlay it was put on: once the note has left its window, rootView is another.
        overlay?.remove(floating)
        overlay = null
    }

    private var overlay: android.view.ViewOverlay? = null

    /** Redraw the dim and the drop line in the note, and the card over the window. */
    fun invalidate() {
        view.invalidate()
        floating.invalidateSelf()
    }

    /** The card floats over the whole window, as the web editor's did, so the note's edges never cut it. */
    private val floating = object : Drawable() {
        override fun draw(canvas: Canvas) {
            val at = IntArray(2).also(view::getLocationInWindow)
            val root = IntArray(2).also(view.rootView::getLocationInWindow)
            val save = canvas.save()
            canvas.translate((at[0] - root[0] - view.scrollX).toFloat(), (at[1] - root[1] - view.scrollY).toFloat())
            drawCard(canvas, sourceRect())
            if (reflow == null) drawDropLine(canvas)
            canvas.restoreToCount(save)
        }
        override fun setAlpha(alpha: Int) = Unit
        override fun setColorFilter(filter: ColorFilter?) = Unit
        @Deprecated("Deprecated in Java") override fun getOpacity() = PixelFormat.TRANSLUCENT
    }

    /** Where the card is drawn now, unscaled, in window coordinates. */
    internal fun cardInWindow(): RectF {
        val at = IntArray(2).also(view::getLocationInWindow)
        val card = card()
        val x = at[0] + cardX + dx
        val y = at[1] + cardY + dy
        return RectF(x, y, x + card.right - card.left, y + card.height + 2 * padY)
    }

    /** The y of the drop line drawn now, in window coordinates; null when none is drawn. */
    internal fun dropLineInWindow(): Float? {
        if (reflow != null) return null
        val at = slot?.takeIf { !landing }?.let { view.boundaryY(it) } ?: return null
        return IntArray(2).also(view::getLocationInWindow)[1] + at - view.scrollY
    }

    /** The block's place in window coordinates, as dimmed now. */
    internal fun sourceInWindow(): RectF? = sourceRect()?.apply {
        val at = IntArray(2).also(view::getLocationInWindow)
        offset(at[0].toFloat() - view.scrollX, at[1].toFloat() - view.scrollY)
    }

    /** Put the card up over the window. */
    fun attach() {
        val root = view.rootView
        floating.setBounds(0, 0, root.width, root.height)
        overlay = root.overlay.also { it.add(floating) }
    }

    // ---- drawing, after the text, in content coordinates ----

    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val shadow = Paint(Paint.ANTI_ALIAS_FLAG)
    private val border = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val fade = Paint().apply { xfermode = PorterDuffXfermode(PorterDuff.Mode.DST_OUT) }
    private val path = Path()

    /** In the note: the block's place, dimmed (35% shows through), until the move lands. The card and the drop line float over the window. */
    fun draw(canvas: Canvas) {
        // Once the reflow's gap has moved, the copy in the gap is the dimmed block.
        if (reflow?.opened == true) return
        val source = sourceRect()
        if (source != null) {
            fill.color = withAlpha(view.style.pageColor, 0.65f)
            canvas.drawRect(source, fill)
        }
    }

    /** The drop line, over the card (which is under the finger), so it never fades. */
    private fun drawDropLine(canvas: Canvas) {
        val at = slot?.takeIf { !landing }?.let { view.boundaryY(it) } ?: return
        fill.color = view.style.linkColor
        val h = DROP_LINE_DP * d
        canvas.drawRoundRect(view.totalPaddingLeft - 6 * d, at - h / 2, view.width - view.totalPaddingRight + 6 * d, at + h / 2, h / 2, h / 2, fill)
    }

    private fun drawCard(canvas: Canvas, source: RectF?) {
        val look = view.style
        val card = if (source != null || lastCard != null) card(source) else return
        val w = card.right - card.left
        val contentHeight = card.height
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
            val layer = if (card.capped) canvas.saveLayer(0f, padY, w, padY + contentHeight, null) else -1
            canvas.save()
            canvas.clipRect(0f, padY, w, padY + contentHeight)
            canvas.translate(-card.left, padY - card.from)
            val layoutTop = (card.from - view.totalPaddingTop).toInt()
            view.drawCodeBlocksForDrag(canvas, layoutTop, layoutTop + kotlin.math.ceil(card.height).toInt())
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
        /** The page-colour margin around what a lifted block draws, on every side. */
        private const val CARD_INSET_DP = 8f
        private const val FADE_DP = 56f
        private const val DROP_LINE_DP = 3f
        private const val MAX_SCREEN_FRACTION = 0.4f
        private val SHADOWS = listOf(Triple(1f, 2f, 0.12f), Triple(6f, 14f, 0.16f), Triple(20f, 44f, 0.24f))

        /** The reflow preview, unless animations are off (system settings) or it cannot be built: the drag then uses the drop line, and says why. */
        private fun reflowFor(view: TextFirstEditText, plan: LiftPlan, book: SlotBook, photo: TfImage?): BlockReflowPreview? {
            if (!ValueAnimator.areAnimatorsEnabled()) {
                android.util.Log.i(ReflowCapture.TAG, "animations are off: the block drag uses the drop line")
                return null
            }
            val (preview, why) = BlockReflowPreview.build(view, plan.block, book, photo)
            if (preview == null) android.util.Log.w(ReflowCapture.TAG, "no reflow preview, the block drag uses the drop line: $why")
            return preview
        }

        private fun withAlpha(color: Int, alpha: Float) = (color and 0x00ffffff) or ((alpha * 255).toInt() shl 24)

        /** The drag for [plan], held at ([x], [y]); null when no part of the block shows. */
        fun lift(view: TextFirstEditText, plan: LiftPlan, x: Float, y: Float): BlockDrag? {
            val e = view.editableText ?: return null
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
            // The part that shows: the card starts there.
            val top = maxOf(source.top, shownTop)
            val bottom = minOf(source.bottom, shownBottom)
            if (bottom <= top) return null
            return BlockDrag(view, plan, photo, if (photo != null) 0f else top - source.top, x, y)
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
