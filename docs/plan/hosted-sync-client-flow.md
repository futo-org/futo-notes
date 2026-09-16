# Hosted sync client flow — state of the branch

Work in progress. Decisions are in [ADR 0003](../adr/0003-hosted-sync-client-flow.md);
the spec is futo-notes#172 and the fourteen tickets under it are #173–#186.

This file is the hand-off: what landed, what does not work yet, and what closing
each hole actually takes. Behavioural truth stays in `docs/spec/sync.md` — every
hole below is also a `> **Gap:**` note there, next to the behaviour it qualifies.

## What landed

Fifteen commits, `0384d832` (ADR) through `4fae0ead`:

| Ticket | Commit | |
|---|---|---|
| #173 | `7641af4c` | Argon2id envelope, recovery key, X25519 sealed box |
| #174 | `c27fdd5e` | `connect` split into authenticate + unlock; three secret stores learn a vault key and a session token |
| #175 | `4a78d3fb` | `HostedSetup`: sign in, billing, checkout |
| #176 | `ac21fbbd` | create vault, three unlock doors, sign out, `current_step` |
| #177 | `d774bcef` | desktop wizard, account card, banners, build flag |
| #178 | `6d3bbc75` | iOS wizard |
| #179 | `fc16ac60` | Android wizard |
| #180 | `41711b5c` | pairing in Rust |
| #181 | `5194b110` | desktop pairing, and the first sync on unlock |
| #182 | `5ab471f3` | iOS pairing |
| #183 | `7fb70fe8` | Android pairing |
| #184 | `efe2f4c9` | change vault password, new recovery key |
| #185 | `3adf4a54` | harness starts a stand-in server; both test families in one command |
| #186 | `4fae0ead` | desktop end-to-end scenarios, device QA stories |

The Rust engine is the strong part. The wizard step is derived from server facts on
every shell, and quitting halfway and reopening lands on the right screen — verified
on desktop, a simulator and an emulator.

## What does not work yet

**1. iOS and Android finish the wizard and never sync.** `connect_sync` has no UniFFI
projection and neither SyncManager calls it, so both devices end setup with the account
card reading `0 B of 10 GB used` and the notes only on disk. Thirteen tickets built
sign-in, billing, three unlock doors, pairing and password rotation on mobile; the one
thing they exist to reach does not happen. No ticket owns this. Closing it: project
`connect_sync` through `crates/futo-notes-ffi`, call it from each SyncManager.

**2. Desktop syncs only on the first visit to Settings after a restart.** Nothing at
launch knows the vault is hosted: `isE2eeConfigured()` reads password-mode app state and
the hosted secrets live in the keyring, where only Rust looks. Closing it: a local read —
does this vault's keyring hold a vault key and a session token — that
`loadCredentialsOnBoot` can make without a network call. `e2ee_hosted_current_step` is
not it; that asks the server.

**3. The "Sync paused" banner is not where the person is when sync pauses.** It is a
reading of the billing endpoint taken while the sync screen is open, not a reaction to
the refused write. A lapsed push comes back through the ordinary failure path as
`1 change couldn't reach the server (HTTP 402)` (507 for a full vault), and the banner
appears only once somebody opens the sync screen and billing is re-read. ADR decision 8
says a 402 changes the sync-status line, so this is either implemented or the decision is
amended — it should not stay ambiguous. Cheapest real fix is one classifier change.

**4. Nothing hosted can fail CI.** `scripts/sync-server-pin.json` pins `v0.7.0` with
`standinMode: false`, because the server work is on an unmerged, untagged branch. So the
seven hosted cross-platform scenarios skip, the Rust hosted scenarios run against an
in-test stub, and both device QA stories need a local Go checkout. Somebody can break
hosted sync and every pipeline stays green.

**5. `just android-native` silently ignores `FUTO_HOSTED_SERVER`.** `apps/android/run.sh`
calls `scripts/build-rust-android.sh` without `FUTO_ANDROID_FFI_PROFILE=dev`, so the core
builds `release-ffi`, which inherits `release` and turns `debug_assertions` off — and the
override is gated on it. The baked `https://notes-sync.futo.org` wins, so Android QA
aimed at a local stand-in server probes staging instead. `apps/ios/run.sh` sets the dev
profile; Android's does not. Setting it unconditionally would slow the Android dev loop,
so prefer setting it only when an override is present.

**6. No real camera has scanned a pairing code on iOS.** A simulator has none, so the
scan side rests on the injected-string path. Android proved it once with
`-camera-back virtualscene` and the QR as a scene poster. `confirm_pairing` is the only
call in the product that puts a vault key on the wire, so this is the riskiest path and
the least exercised. Somebody should scan a real code with a real phone before TestFlight.

Smaller: desktop sign-out leaves `lastSyncedAt` set, so a signed-out vault still names a
last-sync time.

## Path forward

In the order that buys the most:

1. **Close (1).** Without it the feature does not do what it is for on two of three
   platforms.
2. **Cut a server release and bump the pin.** Merge `hosted-server` (server#14–#17,
   ~25 commits ahead of main) and tag it; then bump `version` and the five sha256s
   (`node scripts/lib/sync-server.mjs refresh` prints the block) and flip `standinMode`
   to `true` **in the same commit**; then delete `crates/futo-notes-sync/tests/hosted_stub/`.
   That is #185's remaining two criteria and it turns every hosted scenario from skipped
   into blocking.
3. **Decide (3)** — implement decision 8 or amend it.
4. **Decide whether (2) ships as it is.**
5. **Fix (5)**, then re-run the Android QA story against a stand-in server for real.
6. **Do (6)** before any TestFlight or internal-track build.

## Running it locally

The server lives in its own repo. Build one from the unreleased branch and point the
harness at it:

```
FUTO_NOTES_E2EE_SERVER_REPO=<futo-notes-server checkout at hosted-server> \
FUTO_NOTES_E2EE_SERVER_STANDIN=1 just test-cross-platform
```

That run is 40/40. Without a stand-in server it is 33/33 with the hosted seven skipped,
each naming the reason. `just test-sync-integration` starts both server modes and runs
the whole Rust integration file in one command. The server's own contracts — `docs/API.md`,
`docs/openapi.yaml`, and its ADRs 0006, 0008 and 0009 — are authoritative for anything on
the wire.
