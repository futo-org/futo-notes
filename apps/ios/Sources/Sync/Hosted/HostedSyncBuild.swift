import Foundation

/// Whether this build shows hosted sync ("Log in with FUTO").
///
/// Off is not a variant of the sync screen — it is today's self-hosted screen,
/// rendered by the same `SelfHostedSyncSections` that has always rendered it,
/// so a store release before launch cannot grow a dead button (ADR 0003
/// decision 13; parent spec user story 36).
///
/// `FUTO_HOSTED_SYNC` is a Swift compilation condition wired per configuration
/// in `apps/ios/project.yml`: Debug always carries it, and Release takes it
/// from the `FUTO_HOSTED_SYNC_CONDITION` build setting, which is empty in the
/// project and set to `FUTO_HOSTED_SYNC` only by the internal TestFlight
/// archive in `.cirrus.yml`. A store (tag) archive passes nothing and compiles
/// none of the flow in.
enum HostedSyncBuild {
    static var isEnabled: Bool {
        #if FUTO_HOSTED_SYNC
            return true
        #else
            return false
        #endif
    }
}
