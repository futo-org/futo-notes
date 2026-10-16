# Plan: what a license includes — app icons, the landing after paying, attribution, and a license that follows the vault

Status: rough spec, 2026-10-15, reviewed by @justin the same day (decisions D11–D13 below
are his). Nothing implemented. Decided with @justin and FUTO's CEO: a
license may include **purely cosmetic** choices. Every working feature stays available
without one; what a license buys is the things that cost FUTO recurring money (sync) and the
cosmetics FUTO chooses to include. App icons are the first; themes are the likely second.
Behavioral truth to update: `docs/spec/license.md`, `docs/spec/settings.md`.
Sketches: `docs/plan/license-cosmetics/*.png` (exported from the reviewed design doc,
<https://claude.ai/code/artifact/e6bb4266-b1e4-42a8-b8ff-12e38cd1b417>; the doc stays the
editable original, the PNGs are what this plan was written against).

Written for an implementing agent. Read root `AGENTS.md`, `crates/futo-notes-license/AGENTS.md`,
`crates/futo-notes-ffi/AGENTS.md`, `apps/ios/AGENTS.md`, `apps/android/AGENTS.md`,
`crates/futo-notes-sync/AGENTS.md` (M6 only) and `docs/spec/AGENTS.md` before touching their
layers. Every milestone ends with its verification and a commit in `type(scope): imperative
summary` form with a `Verified:` line.

## 0. Decisions (locked — do not reopen without @justin)

| # | Decision | Value |
|---|---|---|
| D1 | What a license includes today | **Choosing the app icon.** All six existing choices (Standard, Reversed, Dark, Dark Reversed, FUTO, Scanlines). Standard is the default every install has, not a "free" tier. No seventh, licensee-only icon. |
| D2 | The gate is on choosing, never on keeping | A removed or expired license leaves whatever icon is set. Nothing in the app ever changes the icon on its own except Full reset (unchanged: it restores Standard). |
| D3 | Expired | Expired does **not** include the icons: Expired is Unlicensed with a story. The picker shows the same ask, with "Renew" where Buy would be. |
| D4 | Where the ask may appear (the nag budget) | Only where the user walked in: the picker (coin badges, footnote, the sheet on tap) and the License card's one new sentence. Never on launch, never a popup, never in the editor or the list. |
| D5 | Vocabulary | "included with a license", "comes with a license". **Never** "paywall", "unlock", "premium". "free" and "donate" stay banned (license.md § Principles). |
| D6 | Store posture | Unchanged (ADR-0005). Key-only builds (iOS outside the US, Android `play`) get the key-only ask: `license.keyOnlyExplanation` + "I already paid", no Buy, no "Lost your key?", no website. |
| D7 | Desktop | No picker, so no visible change. Desktop still projects the Rust rule (M1) so a future desktop cosmetic is one shell change. The card's new sentence renders on native only. |
| D8 | Rust owns the rule | What a license includes is one Rust answer (`license_includes`), projected through UniFFI and Tauri. No Swift/Kotlin/TS copy. Shells only ask. |
| D9 | The spec principle changes | "Nothing is gated" becomes "Nothing that works is gated." Rewritten in the same MR as M1, with ADR-0006 recording the decision and the CEO's sign-off. |
| D10 | License sync (M6) is its own MR, after this plan is approved | It touches the sync payload (AGENTS.md §11.6). This document is the ask; M6 does not start until @justin OKs its section. |
| D11 | Picker treatment | **Concept A**: coin badges on every tile but the current one, one footnote under the grid, a sheet on tap. Concept B (an ask card inside the picker) is rejected. (@justin 2026-10-15) |
| D12 | The License card does not change | No new sentence on the Unlicensed card. The App icon row hint is the only Settings-level touch. `license.explanationIncludes` is **not** added. (@justin 2026-10-15) |
| D13 | Picker once Licensed | The coin **stays** on every icon but Standard, so the picker still shows which ones came with the license. No footnote, no ask, no sheet. (@justin 2026-10-15) |

## 1. The picker when the license does not include icons (M2, M3)

Concept A (D11), `license-cosmetics/02-picker-unlicensed.png`. The resting picker is unchanged in
shape: two-column grid, six labeled tiles, the current choice checked.

- Every tile except the current one wears a small coin badge (the existing
  `SupporterCoin` artwork, 26pt, bottom-trailing of the artwork, surface-colored ring).
  Tiles are **not** dimmed and **not** disabled: a cosmetic should look like what it is.
- A footnote under the grid: `settings.appIcon.license.footnote`.
- Tapping a badged tile opens a sheet over the picker (iOS: `.sheet` with a medium detent;
  Android: a second `ModalBottomSheet`): the tapped icon's artwork with the coin badge, the
  title `settings.appIcon.license.sheetTitle`, one paragraph, one filled button, text links.
  - Link-out: paragraph `settings.appIcon.license.sheetBody`; filled **Buy a license**
    (`license.buy`, or `license.renew` when Expired) → opens the Buy URL with
    `from=app-icon` (M4) exactly the way the License card opens it today (default browser
    on iOS, Custom Tab on Android `direct`); links **I already paid** (`license.enterKey`)
    → dismisses the sheet and the picker, scrolls Settings to the License card, opens the key
    field; **Not now** (`settings.appIcon.license.notNow`) → back to the grid.
  - Key-only: paragraph `license.keyOnlyExplanation`; filled **I already paid**; link **Not
    now**. No other control, no other copy.
  - Which shape is Rust's answer: reuse `license_row_actions(status, link_out)` — if it
    contains `Buy`/`Renew` the sheet is link-out, else key-only. No new storefront logic.
- Tapping the current tile is a no-op, as today.
- The Settings row gains a trailing coin + `settings.appIcon.license.rowHint` before the
  chevron while the license does not include icons (`01-settings-row-hint.png`). The License
  card itself does not change (D12).
- The sheet is `03-tap-sheet.png`, both builds.
- Licensed (D13, right half of `04-after-activation.png`): the footnote, the sheet and the row
  hint disappear; the coin badge stays on every tile but Standard. Tapping a tile changes the
  icon exactly as today.

## 2. M1 — the Rust rule and its projections

`crates/futo-notes-license`:

```rust
/// What a license includes beyond the card. Cosmetic only, by policy (D1, license.md).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LicenseInclusion { AppIcon }

/// The one place the policy lives. Licensed → everything; Unlicensed and Expired → nothing.
pub fn license_includes(status: LicenseStatus) -> Vec<LicenseInclusion>
```

- Tests: Licensed includes `AppIcon`; Unlicensed and Expired include nothing; the list is
  stable (snapshot) so adding a variant is a deliberate edit.
- `futo-notes-ffi` license contract: export `license_includes` and `LicenseInclusion` as a
  `uniffi::Enum`, next to `license_row_actions`. Contract test mirrors the Rust one.
- Tauri: `includes` rides on the `LicenseView` the existing license commands already return
  (computed in Rust through `license_includes`, off `LicenseState::status()`); TS reads it
  from the view, no second IPC call. Desktop renders nothing from it yet.
- Shells: `LicenseModel` (Swift/Kotlin) exposes `includes: Set<LicenseInclusion>` derived from
  `view.status` through the FFI call, updated wherever `view` is assigned (load, apply,
  remove, full reset). `AppIconController` does **not** learn about licenses; the picker view
  reads `license.includes.contains(.appIcon)` and branches between the two renderings. Keep
  the icon-change mechanics (`select`, confirm dialog, readback) untouched.
- Rewrite the policy text: `docs/spec/license.md` § Principles ("Nothing is gated" → "Nothing
  that works is gated" + the inclusion rule), line 4 of the same file, line 637's copy claim,
  `crates/futo-notes-license/AGENTS.md:9`, `crates/futo-notes-license/src/lib.rs:4`,
  `apps/ios/Sources/License/LicenseSettingsSection.swift:83`,
  `src/features/license/LicenseSettingsSection.svelte:9`, `docs/plan/license-ship.md:278`.
  Add `docs/adr/0006-a-license-may-include-cosmetics.md`.
- Spec: new lines in `docs/spec/license.md` (a "What a license includes" section, platform
  tagged) and `docs/spec/settings.md` § Native app icons (the unlicensed rendering, the sheet,
  the row hint, D2, D3). `settings-visual.md` § Native app icon picker gets the badge and
  sheet geometry.

Verification: `cargo test -p futo-notes-license -p futo-notes-ffi`, `just check`.

## 3. M2 iOS, M3 Android — the picker

- iOS: `AppIconPicker.swift` grows the badge (both states, D13), the footnote and the sheet
  (unlicensed only); `SettingsView.swift` the row hint. `LicenseSettingsSection.swift` is
  untouched (D12). Tests: `AppIconPickerTests` (rendering per status, which is a pure function
  of `includes` + `rowActions`), a UI test in `AppIconTests` that taps a badged tile on a
  forced-Unlicensed build and sees the sheet, then forces Licensed and sees the grid with
  badges and no footnote. Storefront forcing already exists (`-FUTOLicenseStorefront`).
- Android: `AppIconSheet.kt` the same; `SettingsScreen.kt` the row hint;
  `LicenseSettingsSection.kt` untouched. Tests: `AppIconSheetTest` (Compose, both renderings,
  both flavors). The existing "Change app icon to …?" confirm stays after the license check,
  untouched. Android sketch: `05-android-and-second-device.png`, left.
- Accessibility: a badged tile's label becomes "{name}, included with a license"
  (`settings.appIcon.license.a11yIncluded`); the sheet's title is its heading.
- Catalog: every string in § 6, English only, `pnpm run check:languages`.

Verification: `just ios-native` + the suites above; `just android-native` on both flavors +
`AppIconSheetTest`; a device pass on each per `apps/*/AGENTS.md` with screenshots of the four
renderings (unlicensed link-out, unlicensed key-only, sheet, licensed).

## 4. M4 — attribution on the Buy URL

`buy_url(config, platform)` becomes `buy_url(config, platform, source)` with

```rust
pub enum BuySource { LicenseCard, AppIconPicker }
```

serialised as `&from=license-card` / `&from=app-icon`, after the existing `platform`. Every
caller names its source; there is no default. `license_links` grows a `source` parameter;
the desktop command and both shells pass it.

- It rides the click the user already makes: no new request, nothing stored, nothing sent
  without a tap. State this in the spec next to the zero-background-network principle.
- The deployed server does not record `platform` yet (license.md Gap). **Before M4 lands**,
  confirm with the FUTOpay/lib-polar owner which query parameters `checkout-ready` forwards
  into Polar order metadata and under what names, and write the answer into the Gap. If
  `from` is dropped on the floor, M4 is still correct and still cheap, but the Gap says so.
- Tests: the two URLs are exact-string tested per source and per environment; the contract
  test `the_buy_url_carries_the_platform` grows a sibling for `from`.

Verification: `cargo test -p futo-notes-license -p futo-notes-ffi`; open each Buy on a dev
build and read the URL in the browser's address bar.

## 5. M5 — land on the reward after activation

Native only. When an activation succeeds (deep link, cold or warm; or a bare key / pair entered
on the card) **and** the new `includes` contains `AppIcon` **and** the shell has a picker:

1. The existing toast `license.activated` still shows.
2. Settings is presented if it is not already (the deep link can arrive on the list), and the
   picker is opened over it, with a one-time header above the grid: the coin,
   `license.explanationLicensed` in bold, `settings.appIcon.license.landing` under it
   (`04-after-activation.png`, left). The coin badges are already on the tiles (D13).
3. The header exists only for this presentation. Dismissing the picker and reopening it shows
   today's plain grid. Nothing is persisted; there is no "seen" flag.
4. If the picker is already open (the user went Buy from the sheet, or typed a key after
   "I already paid"), the sheet dismisses itself and the grid re-renders licensed, with the
   same header.
5. M1 rule: the shell has already rendered before a cold-start link is applied; the picker is
   presented after, never gating the shell.
6. Android's "FUTO Notes may close" confirm stays on the first tap. An interrupted alias
   transition is reconciled by the existing startup observation; nothing new.
7. If the OS cannot change icons (iOS `supportsAlternateIcons == false`), skip the landing
   entirely: the picker would only show `settings.appIcon.unavailable`.

Tests: iOS `LicenseModelTests` + a UI test driving `futonotes://license/…` with the staging
fixture and asserting the picker is on screen with the header; Android `LicenseLinkActivity`
→ `MainActivity` path with the same assertion in `AppIconSystemTest`. Spec lines in
`license.md` § Deep link and `settings.md` § Native app icons.

## 6. Catalog entries

| Key | English |
|---|---|
| `settings.appIcon.license.rowHint` | With a license |
| `settings.appIcon.license.footnote` | Choosing an app icon is included with a FUTO Notes license. |
| `settings.appIcon.license.sheetTitle` | Included with a license |
| `settings.appIcon.license.sheetBody` | Choosing an app icon comes with a FUTO Notes license. Everything else in the app works without one. |
| `settings.appIcon.license.notNow` | Not now |
| `settings.appIcon.license.landing` | Your license includes choosing your app icon. Pick one. |
| `settings.appIcon.license.a11yIncluded` | {iconName}, included with a license |

Reused: `license.buy`, `license.renew`, `license.enterKey`, `license.keyOnlyExplanation`,
`license.activated`, `license.explanationLicensed`, `license.coinAccessibilityLabel`.

## 7. M6 — the license follows the vault (ask-first; own MR)

Problem: the license is entered per device (license.md Gap "License sync"). Once a license
includes something visible, a second phone that is synced but Unlicensed reads as broken.

Proposed shape, to be confirmed before any code:

- The stored pair (key + activation) travels inside the E2EE vault as one small encrypted
  object, the same way a note's bytes do, so the server keeps seeing opaque blobs and the
  hosted and self-hosted servers need no change. **First task is to establish whether the
  sync crate can carry a non-note object today** (the vault model is note-shaped:
  `sync/vault.rs`, `sync/encrypted_note.rs`). If it cannot, the options are (a) a reserved,
  hidden vault path the store never lists as a note, or (b) a new object kind in the
  protocol, which also touches the server repo. Write the answer into this section before
  choosing; (a) is the preference if the store's listing and the editor can be kept from
  ever seeing it.
- Entering a key on any device publishes the pair on the next push. A pull that delivers a
  pair hands it to Rust `evaluate` exactly as a typed key would; the dev/prod split holds
  (a production pair in a `.dev` build verifies as Unlicensed, correctly). Nothing is trusted
  because it arrived by sync; verification is the same RSA check.
- **Remove license** on any device removes the synced copy too: one vault, one license.
  Last-writer-wins on the object; a conflict between two different valid pairs keeps the one
  with the later `issued_at`, else the later write.
- A device that receives a pair runs the M5 landing only if it is in the foreground and in
  Settings; otherwise just the toast. Never present UI from a background pull.
- Zero background network stays true for the license module: the pair arrives through the
  sync cycle the user already configured; the license crate still makes no call of its own.
- Spec: license.md Gap closes; sync.md gains a "What travels besides notes" line; the
  conflict rule gets a line in § Conflict & data safety.

Verification: the cross-platform sync harness (`tests/cross-platform-sync.mjs`, `tests/sync-integration.mjs`), two emulators/simulators, a
desktop + phone pair; `just test-rust`.

### Feasibility (2026-10-15)

Read-only research; no code changed. Recommendation only. Justin's call: M6 is not now
(own MR later), so this records what the later MR must do.

**Can the sync crate carry a non-note object today? No, not without engine changes. The
server can carry it; the client engine cannot.**

- The server is already kind-agnostic. An object is `id, version, change_seq, deleted,
  blob_key, size_bytes, timestamps` (`futo-notes-server/internal/objects/objects.go:25`;
  `docs/Rewriting the server in Go.md` § objects). There is no path or kind column: the path
  lives only inside the encrypted blob. The server validates only blob size (100 MiB,
  `internal/config/config.go:104`) and batch size (32 MiB). A listing exposes only opaque ids
  and sizes, so a hidden path leaks nothing, and self-hosted servers need no change for (a).
- The client engine is file-shaped end to end. The blob frame is `pack_note_v2(path, content)`
  (`futo-notes-core/src/e2ee/note_frame.rs:11`). A pulled object is classified by path
  (`classify_incoming_sync_path`, `futo-notes-core/src/files/paths.rs:89`); anything that is
  not `.md` or an image is `Ignore`d silently (`paths.rs:95`; `sync/pull/apply_remote.rs:50-62`:
  no failure, nothing written, nothing mapped). Push enumerates the disk (`sync/vault.rs:100`
  skips every dot entry, `:130` skips non-syncable names), and deletion only considers
  `is_syncable_filename` names (`sync/push/delete_local.rs:73`). So a non-note object is
  never pushed, never tracked in `object_map` (keyed by file name, `checkpoint.rs:41`), and
  never deleted by today's engine. Create, update, tombstone and conflict handling all hang
  off that map and the disk scan.
- Nothing else non-note travels today except images (same note frame, base64; `sync.md`
  § Embedded images). Folders are implied by note paths; settings, non-image attachments and
  folder metadata do not sync. `.e2ee-state.json` is a vault dotfile that is per-device state
  and is not synced.

**What the rest of the app would see.** Dot-prefixed entries are already invisible: store
listing (`futo-notes-store/src/vault.rs:333`, `:401`) and sync scan (`sync/vault.rs:100`), and
search/index/editor read the store listing. I found no iOS/Android/desktop directory walk that
bypasses the Rust store. A reserved path that is never a file on disk cannot be listed by any
of them. (Not verified at runtime.)

**Option (a): reserved hidden path, carried as a side channel rather than a file.**
- Path: a non-syncable extension, e.g. `.futo/license.json`, in the normal note frame. It must
  NOT end in `.md` or an image extension: an old client would `Accept` that and write it to disk.
- Do not materialise it as a file. The push scan skips it and delete-detection would read it as
  "missing locally". Keep it out of `object_map` and add one dedicated slot to `ConnectedState`
  (e.g. `license_object: Option<ObjectState>`; plain serde, `checkpoint.rs:35`, no
  `deny_unknown_fields`, so an older client reading the state file ignores it), with a hook in
  push (publish when the local pair changed or was removed) and in pull (recognise the reserved
  path before `classify_incoming_sync_path`, hand the pair up through the summary, write no
  file). This is a real sync-engine change: push-first ordering applies (publish after notes in
  the same cycle) and AGENTS.md §11.6 (sync payload) makes it ask-first.
- Listings to filter: none in store/search/editor if no file exists. The only new filtering is
  inside the engine (pull classifier, object-map pruning, `delete_missing`).
- Conflict/LWW: the server gives per-object optimistic versions (stale PUT returns 409) but
  does NOT enforce path uniqueness. Two devices entering a key offline each POST a new object
  at the reserved path, i.e. two objects. The existing path-collision rule
  (`sync/collision_resolution.rs:28`: lowest object id wins, loser becomes a conflict copy) is
  note-shaped and must not be reused. The license needs its own rule (later `issued_at`, else
  later write, as § 7 says) and must tombstone the losing duplicate; a 409 re-reads the remote
  pair and re-applies the same rule. New merge code in a crate that merits `/slow-review`.
- Deletion: "Remove license removes the synced copy" is a normal DELETE of that one object
  (tombstone). Peers pull it and drop their pair. Gap: a device offline during Remove keeps its
  pair and would republish it on its next push, resurrecting the license. The rule needs
  tombstone-wins (never republish a pair whose object was tombstoned after it was last synced),
  otherwise "one vault, one license" does not hold. Decide this explicitly.
- E2EE: unchanged. AES-GCM under the vault key like every note; the server sees an opaque blob
  of a few hundred bytes. Every synced device holds the vault key, so any of them can read the
  pair; that is inherent and matches "one vault, one license".
- Self-hosted: works on any server that accepts a normal object; no change to
  `scripts/sync-server-pin.json`.
- Mixed-version clients: an OLD client downloads and decrypts the object, then `Ignore`s it
  (`IGNORE_NOT_A_NOTE`): no failure, no journal line, no file, no map entry. It never publishes
  or removes it, so old devices simply stay per-device licensed. Needs a mixed-version run to
  confirm (CI never pins that pairing).

**Option (b): a new object kind.**
- Server `kind` column: migrations for both Postgres and SQLite
  (`internal/db/migrations/{postgres,sqlite}`), API/OpenAPI and listing changes, a server
  release and a pin bump. Self-hosters on older servers silently lose the feature, and the
  hosted deploy must be coordinated. The server never interprets content, so it buys nothing.
- Client-only variant (a new frame byte, e.g. `0x03`): worse for old clients. `unpack_note`
  returns `UnknownFrame` (`note_frame.rs:41`), which `decrypt_bytes` turns into
  `FailureKind::Decrypt` (`encrypted_note.rs:53`): a loud pull failure on every old device that
  may also hold the pull cursor back (`pull/mod.rs:41`). The cursor stall is unverified; treat
  it as a risk to test.

**Risks.** (1) The engine change is real even for (a): the crate has no notion of a non-file
object. (2) The duplicate-object race and offline-Remove resurrection need the explicit rules
above. (3) A `.dev` and a prod build sharing one vault would publish/remove each other's pair;
decide whether a build publishes a pair it cannot verify. A prod pair in a `.dev` build is
simply Unlicensed, as § 7 says. (4) Spec debt: sync.md "What travels besides notes", the
conflict-rule line, license.md Gap, a `tests/cross-platform-sync.mjs` scenario, and
`/sync-adversarial`.

**Recommendation (not a decision).** When M6 is picked up: option (a), a reserved non-`.md`
path (`.futo/license.json`) carried by a dedicated engine slot rather than a vault file. It
leaves the server and self-hosted compatibility untouched, old clients ignore it silently, and
nothing in store/search/editor can see it because no file exists. Reject (b): it needs a server
release for something the server cannot interpret, and the in-frame variant breaks old
clients loudly. Also reject a reserved hidden *file* in the vault: the scan skips it and
delete-detection would treat it as gone. Open for the later MR: the offline-Remove rule.

## 8. Order and sizing

| Milestone | Scope | MR |
|---|---|---|
| M1 | Rust rule + FFI/Tauri projection + spec/ADR rewrite + catalog | this plan's MR, then a feature MR |
| M2, M3 | iOS and Android picker and row | same feature MR |
| M4 | Buy URL `from` | same feature MR (small, independent commit) |
| M5 | Post-activation landing | same feature MR, last |
| M6 | License follows the vault | **separate MR after OK on § 7** |

Time box: M1–M5 is one merge request. If it is not green in a week, ship M1–M3 and move M4–M5
to a follow-up rather than growing the MR.

## 9. Open questions for @justin

Resolved 2026-10-15: picker treatment is A (D11).
Resolved 2026-10-16 (@justin): M6 waits for its own MR (feasibility is in § 7); iOS
Expired → Renew is accepted on unit coverage (no expired staging fixture, no simulator
clock control — the same bar as the License card).

Taken as written (2026-10-15, the docs/catalog pass; reopen with @justin if wrong):

- Q1: Expired closes the picker (D3 as written).
- Q2: the toast is enough on desktop.
- Q4: the row hint shows on key-only builds.
- Q5: not in scope.
- Q3: still pending M6's feasibility note.

This pass is **iPhone only**: Android UI (M3) and desktop UI are deferred, and the specs record Android as a Gap.

1. D3: should Expired keep the picker open (a lapsed buyer keeps choosing) or close it as
   written? Written: closes.
2. M5 on desktop: there is no picker, so nothing to land on. Confirm the toast is enough.
3. M6 § 7: which carrier, (a) hidden vault path or (b) protocol object kind, once the
   feasibility note is written.
4. Does the row hint ("With a license") belong on key-only builds, where the row cannot lead
   to a purchase? Written: yes, the hint names a fact, not a sale.
5. The reviewed Settings sketch (`01-settings-row-hint.png`) shows the License card's
   paragraph as "FUTO Notes is paid for by you, not by ads or by selling your data." instead
   of today's `license.explanation`. Was that a sketch shortcut, or a copy change to make? Not
   in scope here unless you say so.

## 10. Sketches

| File | Shows |
|---|---|
| `license-cosmetics/01-settings-row-hint.png` | Settings, unlicensed, link-out build: the row hint, the only Settings-level change |
| `license-cosmetics/02-picker-unlicensed.png` | The picker unlicensed: A (chosen) beside B (rejected) |
| `license-cosmetics/03-tap-sheet.png` | The sheet on tapping a coined tile, link-out and key-only builds |
| `license-cosmetics/04-after-activation.png` | The landing right after activation, and the licensed picker on any later visit |
| `license-cosmetics/05-android-and-second-device.png` | Android's bottom sheet, and a second synced device after M6 |
