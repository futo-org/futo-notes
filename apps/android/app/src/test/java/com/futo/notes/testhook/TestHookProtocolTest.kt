package com.futo.notes.testhook

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The ack line and its payload are a contract with `tests/lib/android/testHooks.mjs`,
 * which nothing links at compile time. These tests pin the shape the reader parses,
 * so a change here that would break every Android harness fails in CI instead of
 * on a device.
 */
class TestHookProtocolTest {
    // ============================
    // Which hook a broadcast asks for
    // ============================

    @Test
    fun aRegisteredNameResolvesToAnInvocation() {
        assertEquals(
            TestHookRequest.Invoke("state"),
            resolveTestHook("state", setOf("state", "storage-mode")),
        )
    }

    @Test
    fun anAbsentOrBlankNameIsReportedAsMissingRatherThanGuessed() {
        assertEquals(TestHookRequest.Missing, resolveTestHook(null, setOf("state")))
        assertEquals(TestHookRequest.Missing, resolveTestHook("", setOf("state")))
        assertEquals(TestHookRequest.Missing, resolveTestHook("   ", setOf("state")))
    }

    /** A typo is the common caller mistake, so the ack has to name the alternatives. */
    @Test
    fun anUnknownNameCarriesTheRegisteredNamesInSortedOrder() {
        assertEquals(
            TestHookRequest.Unknown("stat", listOf("state", "storage-mode")),
            resolveTestHook("stat", setOf("storage-mode", "state")),
        )
    }

    // ============================
    // The ack line the reader matches
    // ============================

    @Test
    fun aSuccessfulHookAcksItsTokenAndName() {
        assertEquals(
            "testhook ok 7 storage-mode",
            formatTestHookAck("7", TestHookOutcome.Ran("storage-mode", null)),
        )
    }

    @Test
    fun aReportingHookAppendsItsPayloadToTheSameLine() {
        val ack = formatTestHookAck("7", TestHookOutcome.Ran("state", """{"notes":2}"""))
        assertEquals("""testhook ok 7 state {"notes":2}""", ack)
        assertEquals("one line, so a single logcat record carries it", 1, ack.lines().size)
    }

    @Test
    fun anUnknownHookAcksTheRegisteredNames() {
        assertEquals(
            "testhook unknown 7 stat known=state,storage-mode",
            formatTestHookAck("7", TestHookOutcome.Unknown("stat", listOf("state", "storage-mode"))),
        )
    }

    @Test
    fun aBroadcastWithNoHookNameAcksMissing() {
        assertEquals("testhook missing 7", formatTestHookAck("7", TestHookOutcome.Missing))
    }

    /** A multi-line exception message must not split the ack into several records. */
    @Test
    fun aFailingHookReportsItsReasonOnOneLine() {
        val ack = formatTestHookAck(
            "7",
            TestHookOutcome.Failed("storage-mode", "no such mode:\n  SDCARD"),
        )
        assertEquals("testhook failed 7 storage-mode no such mode: SDCARD", ack)
        assertEquals(1, ack.lines().size)
    }

    @Test
    fun anAbsentTokenStillProducesAWellFormedAck() {
        assertEquals(
            "testhook ok $TEST_HOOK_NO_TOKEN state",
            formatTestHookAck(TEST_HOOK_NO_TOKEN, TestHookOutcome.Ran("state", null)),
        )
    }

    // ============================
    // The reported fields
    // ============================

    @Test
    fun reportedFieldsSurviveAsJsonOfTheirOwnTypes() {
        val json = JSONObject(
            formatTestHookPayload(
                mapOf(
                    "storageMode" to "DEVICE",
                    "notes" to 2,
                    "movingNotes" to false,
                ),
            ),
        )
        assertEquals("DEVICE", json.getString("storageMode"))
        assertEquals(2, json.getInt("notes"))
        assertEquals(false, json.getBoolean("movingNotes"))
    }

    /**
     * `JSONObject.put` drops a null-valued key, which would report "this field
     * does not exist" for a field that is merely unset — and the reader treats a
     * missing field as the two sides having drifted apart.
     */
    @Test
    fun anUnsetFieldIsReportedAsNullRatherThanOmitted() {
        val json = JSONObject(formatTestHookPayload(mapOf("vaultPath" to null)))
        assertTrue("the key must still be present", json.has("vaultPath"))
        assertTrue("and explicitly null", json.isNull("vaultPath"))
    }

    @Test
    fun payloadsAreOneLineSoAnAckStaysOneLogRecord() {
        val payload = formatTestHookPayload(mapOf("vaultPath" to "/sdcard/Documents/FUTO Notes Dev"))
        assertEquals(1, payload.lines().size)
    }
}
