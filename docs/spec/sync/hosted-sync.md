## Hosted sync — Log in with FUTO

Behind a build-time flag: on for debug builds and for any build made with
`VITE_HOSTED_SYNC=true` _(desktop)_, with the `FUTO_HOSTED_SYNC` Swift
compilation condition, which the Debug configuration always carries and the
internal TestFlight archive sets through `FUTO_HOSTED_SYNC_CONDITION` _(iOS)_,
or with `BuildConfig.HOSTED_SYNC`, which the debug build type always sets and the
release build type reads from the `FUTO_HOSTED_SYNC` environment variable
_(Android)_; off for store releases until launch, where the sync screen is
exactly the self-hosted screen described above and nothing in this section
exists. On Android the internal track is a prerelease tag, which builds
everything and publishes nothing, so that is the only release build CI sets the
variable for; a stable `vX.Y.Z` tag — the one that reaches Play — does not. →
`hostedSyncEnabled.ts` _(desktop)_, `HostedSyncBuild.swift` + `project.yml` +
`.cirrus.yml` _(iOS)_, `HostedSyncBuild.kt` + `app/build.gradle.kts` +
`.gitlab-ci.yml` _(Android)_, ADR 0003 decision 13

Everywhere the flag turns on for an internal build (debug, the iOS
default-branch dogfood archive, the Android prerelease-tag build), CI also
sets `FUTO_HOSTED_SERVER_BAKED=https://staging-notes-sync.futo.org` before the
Rust FFI build, so the hosted address compiled into that build is staging, not
production; a store build sets neither and keeps `notes-sync.futo.org`. →
`crates/futo-notes-sync/src/hosted/address.rs`, ADR 0003 decision 2

- [Sign-in wizard, vault password and recovery key](hosted-sync/sign-in-wizard-and-vault-password.md)
- [Unlock doors and QR pairing](hosted-sync/unlock-doors-and-qr-pairing.md)
- [Account, billing and session](hosted-sync/account-billing-and-session.md)
- [Starting and resuming hosted sync](hosted-sync/starting-and-resuming-sync.md)
