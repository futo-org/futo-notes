package com.futo.notes.sync.hosted

import com.futo.notes.BuildConfig

/**
 * Whether this build shows hosted sync ("Log in with FUTO").
 *
 * Off is not a variant of the sync screen — it is today's self-hosted screen,
 * rendered by the same `SelfHostedSyncSections` that has always rendered it, so
 * a store release before launch cannot grow a dead button (ADR 0003 decision
 * 13; parent spec user story 36).
 *
 * `BuildConfig.HOSTED_SYNC` is wired per build type in `app/build.gradle.kts`:
 * debug is always `true`, and release reads the `FUTO_HOSTED_SYNC` environment
 * variable, which CI sets only for the internal-track (prerelease-tag) build. A
 * stable `vX.Y.Z` tag — the store release — builds it `false`.
 */
object HostedSyncBuild {
    val isEnabled: Boolean
        get() = BuildConfig.HOSTED_SYNC
}
