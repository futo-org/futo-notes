package com.futo.notes.testhook

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.core.content.ContextCompat

/**
 * A named-command surface for driving the app from a shell — the Android
 * counterpart of the desktop `window.__testSync` hook, and for the same reason.
 * Driving a flow through the accessibility tree costs ~2s per UI dump and goes
 * stale under Compose frame throttling (AGENTS.md M21), so a test that taps its
 * way through a multi-step flow is both slow and unreliable. Hooks call the app's
 * own entry points, leaving the code under test unchanged; what they replace is
 * the automation around it.
 *
 * Debug builds only. This file lives in the `debug` source set and a release
 * build compiles the no-op sibling at the same name instead, so the release APK
 * carries none of it.
 */
object TestHooks {
    private var receiver: BroadcastReceiver? = null

    /**
     * Register [hooks] by name for the lifetime of [activity]. A hook may report
     * named fields, which travel back as JSON on its ack line — that is how a
     * caller reads app state without an accessibility dump.
     *
     * Registering again replaces the previous receiver, so an activity recreated
     * on a configuration change cannot leave one behind.
     */
    fun install(activity: ComponentActivity, hooks: Map<String, (Intent) -> Map<String, Any?>?>) {
        uninstall(activity)
        val installed = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                val token = intent?.getStringExtra(TEST_HOOK_TOKEN_EXTRA) ?: TEST_HOOK_NO_TOKEN
                val outcome =
                    if (intent == null) TestHookOutcome.Missing else invoke(intent, hooks)
                Log.i(TEST_HOOK_TAG, formatTestHookAck(token, outcome))
            }
        }
        receiver = installed
        // RECEIVER_EXPORTED: the point is to be reachable from `adb shell am
        // broadcast`, which is another uid.
        ContextCompat.registerReceiver(
            activity,
            installed,
            IntentFilter(TEST_HOOK_ACTION),
            ContextCompat.RECEIVER_EXPORTED,
        )
    }

    fun uninstall(activity: ComponentActivity) {
        // Tolerate an already-unregistered receiver: uninstall runs from both
        // onDestroy and a re-install, and the second call must not throw.
        receiver?.let { runCatching { activity.unregisterReceiver(it) } }
        receiver = null
    }

    private fun invoke(
        intent: Intent,
        hooks: Map<String, (Intent) -> Map<String, Any?>?>,
    ): TestHookOutcome {
        val name = intent.getStringExtra(TEST_HOOK_NAME_EXTRA)
        return when (val request = resolveTestHook(name, hooks.keys)) {
            TestHookRequest.Missing -> TestHookOutcome.Missing
            is TestHookRequest.Unknown -> TestHookOutcome.Unknown(request.name, request.known)
            // A throwing hook is reported, not swallowed: a broadcast receiver
            // that lets the exception escape would take the app down instead.
            is TestHookRequest.Invoke -> runCatching { hooks.getValue(request.name)(intent) }.fold(
                { fields ->
                    TestHookOutcome.Ran(request.name, fields?.let(::formatTestHookPayload))
                },
                { error ->
                    TestHookOutcome.Failed(
                        request.name,
                        error.message ?: error::class.java.simpleName,
                    )
                },
            )
        }
    }
}
