package com.futo.notes.textfirst

import com.futo.notes.localization.LocalizedMessage
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class TitleWarningTest {
    private val forbidden = LocalizedMessage("notes.title.forbiddenCharacter")
    private val duplicate = LocalizedMessage("notes.title.duplicate")

    @Test fun forbiddenCharacterWarningHidesAfterTwoSeconds() = runTest {
        val warning = TitleWarning(backgroundScope)
        warning.forbiddenCharacter()
        advanceTimeBy(1999); runCurrent()
        assertEquals(forbidden, warning.message)
        advanceTimeBy(2); runCurrent()
        assertNull(warning.message)
    }

    @Test fun aValidationWarningReplacingItStays() = runTest {
        val warning = TitleWarning(backgroundScope)
        warning.forbiddenCharacter()
        warning.validate(duplicate)
        advanceTimeBy(5000); runCurrent()
        assertEquals(duplicate, warning.message)
    }
}
