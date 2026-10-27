package com.futo.notes.ui

import android.content.SharedPreferences
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember

/**
 * A boolean preference as Compose state that FOLLOWS the preference file.
 *
 * `remember { mutableStateOf(prefs.getBoolean(…)) }` copies the value once, so a
 * write from anywhere but that toggle — the debug puppet listener's
 * `ToggleIssueReporting`, or another screen — left the switch showing the old
 * value until the screen was recomposed from scratch. Setting the returned state
 * writes the preference; a preference write from elsewhere updates the state.
 */
@Composable
fun rememberPreferenceBoolean(
    prefs: SharedPreferences,
    key: String,
    default: Boolean,
): MutableState<Boolean> {
    val state = remember(prefs, key) {
        object : MutableState<Boolean> {
            private val backing = mutableStateOf(prefs.getBoolean(key, default))
            override var value: Boolean
                get() = backing.value
                set(next) {
                    backing.value = next
                    prefs.edit().putBoolean(key, next).apply()
                }

            /** The preference changed under us: reflect it without writing it back. */
            fun refresh() {
                backing.value = prefs.getBoolean(key, default)
            }

            override fun component1() = value
            override fun component2(): (Boolean) -> Unit = { value = it }
        }
    }
    DisposableEffect(prefs, key) {
        val listener = SharedPreferences.OnSharedPreferenceChangeListener { _, changed ->
            if (changed == key) state.refresh()
        }
        prefs.registerOnSharedPreferenceChangeListener(listener)
        onDispose { prefs.unregisterOnSharedPreferenceChangeListener(listener) }
    }
    return state
}
