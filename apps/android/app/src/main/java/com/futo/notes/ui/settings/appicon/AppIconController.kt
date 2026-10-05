package com.futo.notes.ui.settings.appicon

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

internal interface AppIconSystem {
    fun enabled(icon: AppIcon): Boolean
    fun apply(changes: List<Pair<AppIcon, Boolean>>)
}

internal fun iconComponentEnabled(state: Int, manifestEnabled: Boolean): Boolean = when (state) {
    PackageManager.COMPONENT_ENABLED_STATE_DEFAULT -> manifestEnabled
    PackageManager.COMPONENT_ENABLED_STATE_ENABLED -> true
    else -> false
}

private class PackageManagerIcons(context: Context) : AppIconSystem {
    private val manager = context.packageManager
    private val packageName = context.packageName
    private fun component(icon: AppIcon) = ComponentName(packageName, icon.aliasName)
    override fun enabled(icon: AppIcon) = iconComponentEnabled(
        manager.getComponentEnabledSetting(component(icon)), icon.manifestEnabled,
    )
    override fun apply(changes: List<Pair<AppIcon, Boolean>>) {
        fun state(enabled: Boolean) = if (enabled) PackageManager.COMPONENT_ENABLED_STATE_ENABLED
            else PackageManager.COMPONENT_ENABLED_STATE_DISABLED
        if (Build.VERSION.SDK_INT >= 33) {
            manager.setComponentEnabledSettings(changes.map { (icon, enabled) ->
                PackageManager.ComponentEnabledSetting(component(icon), state(enabled), PackageManager.DONT_KILL_APP)
            })
        } else {
            // The first entry always enables the requested icon. MainActivity
            // stays enabled and there is a launcher throughout the transition.
            changes.forEach { (icon, enabled) ->
                manager.setComponentEnabledSetting(component(icon), state(enabled), PackageManager.DONT_KILL_APP)
            }
        }
    }
}

class AppIconController internal constructor(private val system: AppIconSystem) {
    constructor(context: Context) : this(PackageManagerIcons(context.applicationContext))
    var selected by mutableStateOf(AppIcon.LIGHT_STANDARD)
        private set
    var changing by mutableStateOf(false)
        private set
    var failed by mutableStateOf(false)
        private set

    private fun enabled() = AppIcon.entries.filter(system::enabled)
    private fun changes(icon: AppIcon) = listOf(icon to true) +
        AppIcon.entries.filter { it != icon }.map { it to false }

    private fun readAndReconcile(): AppIcon {
        val active = enabled()
        // An interrupted older-API switch can leave the default and requested
        // alternate enabled. Prefer the alternate, then restore a single entry.
        val actual = active.firstOrNull { it != AppIcon.LIGHT_STANDARD }
            ?: active.firstOrNull() ?: AppIcon.LIGHT_STANDARD
        if (active.size != 1) system.apply(changes(actual))
        check(enabled() == listOf(actual)) { "Launcher icon reconciliation failed" }
        return actual
    }

    suspend fun refresh() {
        if (changing) return
        changing = true
        try {
            selected = withContext(Dispatchers.IO) { readAndReconcile() }
            failed = false
        } catch (_: Exception) {
            failed = true
        } finally { changing = false }
    }

    suspend fun select(icon: AppIcon) {
        if (changing) return
        changing = true
        failed = false
        try {
            selected = withContext(Dispatchers.IO) {
                val prior = readAndReconcile()
                if (prior != icon) {
                    try {
                        system.apply(changes(icon))
                        check(enabled() == listOf(icon)) { "Launcher icon readback failed" }
                    } catch (failure: Exception) {
                        // Restore by enabling the prior entry before disabling
                        // others. If restoration fails, surface it; never claim
                        // the requested icon succeeded from a stale preference.
                        try { system.apply(changes(prior)) }
                        catch (restore: Exception) { failure.addSuppressed(restore) }
                        throw failure
                    }
                }
                icon
            }
        } catch (_: Exception) {
            val actual = withContext(Dispatchers.IO) {
                runCatching {
                    val active = enabled()
                    active.firstOrNull { it != AppIcon.LIGHT_STANDARD } ?: active.firstOrNull()
                }.getOrNull()
            }
            if (actual != null) selected = actual
            failed = true
        } finally { changing = false }
    }

    suspend fun reset() {
        select(AppIcon.LIGHT_STANDARD)
        check(!failed && selected == AppIcon.LIGHT_STANDARD) { "Launcher icon reset failed" }
    }
}
