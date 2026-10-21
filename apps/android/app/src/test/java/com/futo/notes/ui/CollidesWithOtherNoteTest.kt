package com.futo.notes.ui

import java.text.Normalizer
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The editor's duplicate-title judgement [editor.md, list.md]. The JVM cannot load
 * the UniFFI native library, so [key] stands in for Rust's `collisionKey` (case-
 * and NFC-folded); what is locked here is that the shell compares KEYS, never ids
 * — the exact-id compare QA444 hit on Android let `QA444 ALPHA` save as
 * `QA444 ALPHA-2` beside `qa444 alpha` with no warning.
 */
class CollidesWithOtherNoteTest {
    private val key: (String) -> String = { Normalizer.normalize(it, Normalizer.Form.NFC).lowercase() }

    private fun collides(currentId: String, targetId: String, vararg existing: String) =
        collidesWithOtherNote(currentId, targetId, existing.toList(), key)

    @Test
    fun `a case variant of another note is a duplicate`() {
        assertTrue(collides("beta", "QA444 ALPHA", "qa444 alpha", "beta"))
    }

    @Test
    fun `an NFC and NFD spelling of another note is a duplicate`() {
        assertTrue(collides("beta", "café", "café", "beta"))
    }

    @Test
    fun `an exact match is a duplicate`() {
        assertTrue(collides("beta", "alpha", "alpha", "beta"))
    }

    @Test
    fun `a case-only change to the note's own name is not a duplicate`() {
        assertFalse(collides("alpha", "ALPHA", "alpha", "beta"))
    }

    @Test
    fun `a different name is not a duplicate`() {
        assertFalse(collides("beta", "gamma", "alpha", "beta"))
    }

    @Test
    fun `the same title in another folder is not a duplicate`() {
        assertFalse(collides("beta", "Work/Alpha", "alpha", "beta"))
    }
}
