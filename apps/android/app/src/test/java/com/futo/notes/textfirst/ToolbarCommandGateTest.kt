package com.futo.notes.textfirst

import org.junit.Assert.*
import org.junit.Test

class ToolbarCommandGateTest {
    @Test fun repeatedTapsCannotQueueBehindAnAdmittedCommand() {
        val gate = ToolbarCommandGate()
        assertTrue(gate.acquire())
        repeat(100) { assertFalse(gate.acquire()) }
        gate.complete()
        assertTrue(gate.acquire())
    }

    @Test fun leavingRejectsTapsUntilAFailedSaveMakesTheDraftEditableAgain() {
        val gate = ToolbarCommandGate()
        assertTrue(gate.acquire())
        gate.close()
        assertFalse(gate.begin())
        gate.complete()
        assertFalse(gate.acquire())
        gate.reopen()
        assertTrue(gate.acquire())
    }
}
