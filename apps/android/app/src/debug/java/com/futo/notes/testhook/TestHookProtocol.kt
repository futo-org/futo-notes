package com.futo.notes.testhook

import org.json.JSONObject

/**
 * The wire contract between a debug build and the test harness
 * (`tests/lib/android/testHooks.mjs`). Nothing links the two sides at compile
 * time, so both read these definitions as the one description of the protocol.
 */

/**
 * Broadcast action. [TestHooks] registers at runtime, so `am broadcast -a` reaches
 * it and `-n <component>` — which only reaches manifest-declared receivers — does
 * not.
 */
const val TEST_HOOK_ACTION = "com.futo.notes.TEST_HOOK"

/** Which named hook to run. */
const val TEST_HOOK_NAME_EXTRA = "hook"

/**
 * Echoed in the ack so a caller can recognize its own invocation among earlier
 * ones, without clearing the device log out from under anything else watching it.
 */
const val TEST_HOOK_TOKEN_EXTRA = "token"

/** Every ack is one line under this log tag. */
const val TEST_HOOK_TAG = "FutoTestHook"

/** Stands in for an absent token so an ack always has the same field count. */
internal const val TEST_HOOK_NO_TOKEN = "-"

/** What a broadcast asks for, decided before any hook body runs. */
internal sealed interface TestHookRequest {
    data class Invoke(val name: String) : TestHookRequest

    data object Missing : TestHookRequest

    /** [known] is sorted so the ack tells a caller what it could have asked for. */
    data class Unknown(val name: String, val known: List<String>) : TestHookRequest
}

internal fun resolveTestHook(name: String?, known: Set<String>): TestHookRequest = when {
    name.isNullOrBlank() -> TestHookRequest.Missing
    name in known -> TestHookRequest.Invoke(name)
    else -> TestHookRequest.Unknown(name, known.sorted())
}

/** How an invocation ended. */
internal sealed interface TestHookOutcome {
    /** [payload] is the hook's own JSON result, when it reports one. */
    data class Ran(val name: String, val payload: String?) : TestHookOutcome

    data object Missing : TestHookOutcome

    data class Unknown(val name: String, val known: List<String>) : TestHookOutcome

    data class Failed(val name: String, val reason: String) : TestHookOutcome
}

/**
 * One parseable line per invocation, so a caller waits on the hook having run
 * rather than on whatever the hook was expected to change. A broadcast that
 * reaches no app — the common failure, since `am broadcast` succeeds regardless —
 * then fails at the call instead of timing out somewhere later.
 *
 * Newlines are collapsed because the reader matches a single line.
 */
internal fun formatTestHookAck(token: String, outcome: TestHookOutcome): String {
    val head = "testhook"
    return when (outcome) {
        is TestHookOutcome.Ran ->
            "$head ok $token ${outcome.name}${outcome.payload?.let { " $it" } ?: ""}"
        TestHookOutcome.Missing -> "$head missing $token"
        is TestHookOutcome.Unknown ->
            "$head unknown $token ${outcome.name} known=${outcome.known.joinToString(",")}"
        is TestHookOutcome.Failed ->
            "$head failed $token ${outcome.name} ${outcome.reason.replace(Regex("\\s+"), " ")}"
    }
}

/**
 * A hook reports named fields; the ack carries them as JSON on one line.
 *
 * Built key by key rather than with `JSONObject(Map)` because `put` DROPS a key
 * whose value is null, which would silently turn "this field is unset" into
 * "this field does not exist" — and the reader checks for missing fields to catch
 * the two sides drifting apart.
 */
internal fun formatTestHookPayload(fields: Map<String, Any?>): String {
    val json = JSONObject()
    for ((key, value) in fields) json.put(key, value ?: JSONObject.NULL)
    return json.toString()
}
