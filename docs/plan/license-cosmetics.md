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
| D5 | Vocabulary | "included with a license", "comes with a license", and "unlock(s)" for what a license includes (cosmetics): allowed on **link-out builds only**, @justin 2026-10-16 (the footnote and sheet say "unlocks the ability to change the app icon"). Key-only builds (no Buy in `licenseRowActions`; App Store 3.1.1) keep "included with a license" (`settings.appIcon.license.footnoteKeyOnly`; their sheet is `license.keyOnlyExplanation`). **Never** "paywall", "premium". "free" and "donate" stay banned (license.md § Principles). |
| D6 | Store posture | Unchanged (ADR-0005). Key-only builds (iOS outside the US, Android `play`) get the key-only ask: `license.keyOnlyExplanation` + "I already paid", no Buy, no "Lost your key?", no website. |
| D7 | Desktop | No picker, so no visible change. Desktop still projects the Rust rule (M1) so a future desktop cosmetic is one shell change. The card's new sentence renders on native only. |
| D8 | Rust owns the rule | What a license includes is one Rust answer (`license_includes`), projected through UniFFI and Tauri. No Swift/Kotlin/TS copy. Shells only ask. |
| D9 | The spec principle changes | "Nothing is gated" becomes "Nothing that works is gated." Rewritten in the same MR as M1, with ADR-0006 recording the decision and the CEO's sign-off. |
| D10 | License sync (M6) is its own MR, after this plan is approved | It touches the sync payload (AGENTS.md §11.6). This document is the ask; M6 does not start until @justin OKs its section. **Amended by D16:** M6 is now required before the iOS IAP ships; it is still its own MR and still waits for that OK (open question 3). |
| D11 | Picker treatment | **Concept A**: coin badges on every tile but the current one, one footnote under the grid, a sheet on tap. Concept B (an ask card inside the picker) is rejected. (@justin 2026-10-15) |
| D12 | The License card does not change | No new sentence on the Unlicensed card. The App icon row hint is the only Settings-level touch. `license.explanationIncludes` is **not** added. (@justin 2026-10-15) |
| D13 | Picker once Licensed | The coin **stays** on every icon but Standard, so the picker still shows which ones came with the license. No footnote, no ask, no sheet. (@justin 2026-10-15) |
| D14 | The icon restriction applies to everyone | Every country, every platform. No per-country rule (D1 stands). (@justin 2026-10-16) |
| D15 | iOS sells the license as a non-consumable IAP; no server work | Outside the US, steering is banned (ADR-0005) and a bare key field that unlocks a feature conflicts with guideline 3.1.1, so iOS adopts ADR-0005 option B at the license price, which puts the key field under 3.1.3(b). FUTOpay/lib-polar does not change; an IAP purchase is **not** converted into a FUTOpay key. A license has two proofs, the FUTOpay pair or an App Store signed transaction (JWS), and Rust `evaluate` accepts either (D8); the Apple proof is verified **offline in Rust** against a pinned Apple root. ADR-0007. (@justin 2026-10-16) |
| D16 | M6 is required before the IAP ships | The license proof (either kind) must follow the vault so a purchase on one device covers the user's other synced devices. M6 carries both proofs. Carrier choice (open question 3) is still @justin's to confirm. (@justin 2026-10-16) |

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
| `settings.appIcon.license.footnote` | Purchasing a FUTO Notes license unlocks the ability to change the app icon. |
| `settings.appIcon.license.footnoteKeyOnly` | Choosing an app icon is included with a FUTO Notes license. (key-only builds) |
| `settings.appIcon.license.sheetTitle` | Included with a license |
| `settings.appIcon.license.sheetBody` | Purchasing a FUTO Notes license unlocks the ability to change the app icon. |
| `settings.appIcon.license.notNow` | Not now |
| `settings.appIcon.license.landing` | Your license includes choosing your app icon. Pick one. |
| `settings.appIcon.license.a11yIncluded` | {iconName}, included with a license |

Reused: `license.buy`, `license.renew`, `license.enterKey`, `license.keyOnlyExplanation`,
`license.activated`, `license.explanationLicensed`, `license.coinAccessibilityLabel`.

## 7. M6 — the license follows the vault (REQUIRED before M7 ships; ask-first; own MR)

Problem: the license is entered per device (license.md Gap "License sync"). Once a license
includes something visible, a second phone that is synced but Unlicensed reads as broken. Since
D15/D16 this is **required**: an App Store purchase proof is bound to an Apple account and is
otherwise useless on the buyer's Android phone or desktop. M6 carries "the license proof", which
is either the FUTOpay pair or an App Store signed transaction (a JWS string, a few KB). The
carrier is the one the Feasibility note below recommends (option (a): a dedicated engine slot at
a reserved non-note path); **confirming it is still @justin's call (§ 9, Q3)**, and M6 does not
start before that OK. Additions for the second proof:

- The object holds a small tagged value (`{"kind":"futopay-pair",...}` or
  `{"kind":"apple-jws","jws":"..."}`). One object, one proof: when a device holds both, publish
  the one `evaluate` ranks Licensed, preferring the FUTOpay pair (portable, carries `issued_at`).
- A pulled proof of either kind goes to Rust `evaluate` as if typed or bought; nothing is trusted
  for arriving by sync. A synced Apple proof verifies on **Android and desktop** too: it is pure
  Rust, offline, no Apple call. On Android `play` that is allowed (Google lets any app be
  consumption-only: access bought elsewhere may be honored; it just cannot be sold there).
- A synced Apple proof gives **no revocation signal off iOS**. Only an iOS device that sees
  StoreKit report a revocation removes the proof and syncs the tombstone (the tombstone-wins rule, § 9 Q9); Android and desktop keep honoring the stored JWS until then.
- Self-hosted sync: unchanged, the object is an opaque encrypted blob on any server.
- Users without sync keep a per-device license. State this in the spec; do not paper over it.

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

## 7b. M7 — in-app purchase on iOS (REQUIRES M6; own MR)

Decisions D15, D16; [ADR-0007](../adr/0007-ios-sells-the-license-in-app.md). Not started. Nothing
ships to a store before M6 is merged and verified.

**Rust (`crates/futo-notes-license`)**

- A second proof type next to `LicensePair`: `LicenseProof::Futopay(LicensePair) |
  LicenseProof::AppStore(String /* JWS */)`. `evaluate` takes a `LicenseProof`; the Futopay arm
  is today's code, byte for byte. `LicenseDetails` gains no new field the shells must branch on
  (`key` becomes the original transaction id for an Apple proof, rendered by the card as it
  renders a key today; decide the display in review). Rule stays single (D8).
- `verify_app_store_jws(jws, &AppStoreConfig, now)`: split on `.`; header `alg == "ES256"` and
  an `x5c` array; the chain is validated to a **pinned Apple root** (Apple Root CA - G3 DER
  embedded, SHA-256 fingerprint asserted in a test; per Apple's engineer use all Apple Root CAs,
  so the anchor list is an array and the first task is to decide whether G3 alone is enough);
  the leaf and intermediate role constraints are checked as Apple's `ChainVerifier` does (read
  that source first; a chain that ends at Apple's root is **not** sufficient); certificate
  validity is checked at the signed `signedDate`, not at `now` (decide, § 9 Q8); ES256 signature over
  `header.payload` with the leaf key; only then decode the payload. Use RustCrypto (`p256`,
  `x509-cert`), already the family of the RSA crate this crate uses; no OpenSSL, no network.
- Claims: `bundleId` equals the config's; `productId` equals the config's (a new constant next to
  `PRODUCT_SLUG`); `type` is Non-Consumable; `environment` matches the config (Production for the
  release id, Sandbox for `.dev`/staging; see Q7 for the release-binary sandbox case);
  `revocationDate` absent; `inAppOwnershipType` is `PURCHASED`. Each failure is a distinct
  `InvalidReason` variant (diagnostic only, like today's).
- `AppStoreConfig` rides `LicenseConfig` (`trust_anchors`, `bundle_id`, `product_id`,
  `environment`). Tests construct their own; `Environment::config()` supplies Apple's root.
- **Fixtures and the trust anchor.**
  - The real chain: capture once from a sandbox purchase in the `.dev` build (TestFlight/App Store
    Connect sandbox tester) or from Xcode, check the JWS in as `tests/fixtures/license/appstore/
    sandbox-*.jws.txt` with the date captured, and keep the file as a **conformance golden**.
    Apple's leaf certificates expire, which is why the test passes a fixed `now`/`signedDate`
    instead of the wall clock.
  - Xcode StoreKit testing (`.storekit` file, `StoreKitTest`) signs with a **local** certificate
    that is itself a root and has no chain (Apple, "Setting up StoreKit Testing in Xcode"; export
    with Editor > Save Public Certificate). It is not Apple's root and must never be a trust
    anchor in a release. Tests inject it as the anchor through `AppStoreConfig.trust_anchors`;
    release configs have exactly Apple's. A test asserts that the release `Environment::config()`
    anchor set contains no non-Apple certificate, and that a Xcode-signed fixture is **Invalid**
    under it.
  - Synthetic fixtures for every rejection path (wrong bundle, wrong product, Production in a
    Sandbox config, Sandbox in a Production config, revoked, family-shared, tampered payload,
    `alg: none`, truncated chain, leaf signed by a non-Apple root, chain with a non-purchase
    leaf): generated by a test helper that mints a throwaway CA and signs payloads (so the test
    covers the verifier without Apple). The real golden proves we match Apple's real shape.
- FFI/Tauri: `evaluate` and `license_row_actions` accept the new proof; a contract test mirrors
  the Rust one. Desktop and Android never present a purchase; they only verify a synced proof.

**iOS shell (`apps/ios/Sources/License/`)**

- `LicenseStoreKit` (new): load the product, **Buy** runs `product.purchase()`; on `.success` hand
  `VerificationResult.jwsRepresentation` to Rust; finish the transaction only after Rust says
  Licensed. We do not trust StoreKit's `.verified` as our rule (D8): Rust decides, StoreKit only
  delivers the string. `.pending` and `.userCancelled` are not errors.
- **Restore Purchases** (`AppStore.sync()` then read `currentEntitlements`), always visible next
  to the key field; required by guideline 3.1.1.
- Observe `Transaction.updates` for the app's life and re-read `currentEntitlements` at launch.
  A revocation (the transaction is absent from entitlements, or `revocationDate` is set) removes
  the stored proof and, via M6, the synced one. A revoked Apple proof never removes a FUTOpay
  pair the user also holds.
- Storage: the Apple JWS lives where the pair lives (`LicenseStorage`, `UserDefaults`, bundle-id
  scoped), as one more string. Stored verbatim.
- Surface: Buy (IAP) and the key field in every storefront; the StoreKit sheet shows the price, so
  `LicenseCopy` still never states one. The US storefront's website link-out is an open question
  (§ 9 Q6); `LicenseStorefront` keeps governing it, and outside the US nothing but IAP and the
  key. The picker's key-only sheet becomes an IAP sheet: Buy and "I already paid" both present.
- Tests: `LicenseModelTests` with a fake store (purchase success, cancel, pending, restore,
  revocation removes proof, a revoked Apple proof leaves a FUTOpay pair); a StoreKit configuration
  file (`apps/ios/Tests/...storekit`) used by UI tests through `SKTestSession`, with its saved
  public certificate as the injected anchor under `#if DEBUG` only.

**Android and desktop shells**: no purchase surface. They verify a synced Apple proof through the
same Rust call. Android `play` stays key-only; a synced Apple proof is "access bought elsewhere".

**App Store Connect setup (human checklist, @justin; no agent can do it)**

1. Create the non-consumable IAP with the product id the Rust constant names, at the license
   price tier, Family Sharing **off**; localized name/description; review screenshot.
2. Enrol in the Small Business Program if eligible (commission rate), and confirm the tax and
   banking agreements for paid apps/IAP are in place.
3. Create sandbox tester accounts for QA; create a TestFlight build.
4. App Review notes: the app is free, the license is one non-consumable IAP, Restore Purchases
   is in Settings > License, the key field serves buyers from other platforms and the same thing is
   available as IAP (3.1.3(b)), and how to test with the sandbox account. Decide Q7 first.
5. Re-read guidelines 3.1.1, 3.1.1(a), 3.1.3(b) before the submission; update ADR-0007's snapshot.

**Verification**: `cargo test -p futo-notes-license -p futo-notes-ffi`; `just ios-native` with the
StoreKit configuration file on a simulator: buy, restore after reinstall, refund (Xcode transaction
manager) removing the proof; a sandbox purchase on a device or sim signed into a sandbox tester,
checking the real chain verifies; then the M6 sync scenarios with an iOS purchase appearing as
Licensed on a second synced device (an Android emulator and desktop), and a refund propagating
only after the iOS device observes it. Per platform rules, drive iOS, Android and desktop.

## 7c. Alternative: Apple receipts become FUTOpay keys — scoping (2026-10-16)

Scoping only; nothing built, nothing decided. An alternative to the offline-proof design of
ADR-0007 / § 7b: the app sends the StoreKit 2 signed transaction to **FUTOpay (lib-polar)**,
which verifies it with Apple's official Python library and answers with an ordinary FUTOpay
license key + activation. The client then holds **only** a FUTOpay pair, on every platform. If
chosen it supersedes ADR-0007's "No server work", "two possible proofs" and "never sent to
FUTO" clauses (D15) and replaces the Rust verifier half of M7. Read for this section
(2026-10-16): ADR-0005/0007; this plan §§ 0, 7, 7b, 8, 9; `crates/futo-notes-license`
(`enter.rs`, `activation.rs`, `config.rs`, `AGENTS.md`); `crates/futo-notes-ffi/src/license/`;
`apps/ios/Sources/License/`; `docs/spec/license.md` (principles, entering a key); lib-polar
`main` (`licensing/key.py`, `utils/org_tools.py` `create_key_func`/`issue_session_license`,
`api/public/pages.py`, `webhooks.py`, `database/dto.py` + `db_manager.py` table registry,
`pyproject.toml`, `.gitlab-ci.yml`) and branch `feat/futo-notes-v2-activation` (read through
`git show`/`diff`, not checked out). Apple library facts are from the
[README](https://github.com/apple/app-store-server-library-python) and
[`signed_data_verifier.py`](https://github.com/apple/app-store-server-library-python/blob/main/appstoreserverlibrary/signed_data_verifier.py)
as fetched 2026-10-16 (a summarizing fetch, not a source checkout).

### 7c.1 The flow

1. User taps Buy (iOS). `product.purchase()`; on `.success` the app holds
   `VerificationResult.jwsRepresentation` and does **not** call `transaction.finish()` yet.
2. The same tap continues into one `POST {pay2}/api/v1/redeem/apple/futo-notes` with the JWS.
   This is user-initiated, so the zero-background-network principle holds (license.md
   § Principles: "only on an explicit user action"); the spec line becomes "two explicit actions:
   a bare key's `GET`, and an Apple redemption `POST`", each one request, no retry.
3. The server verifies the JWS, maps `originalTransactionId` to a license (minting one on
   first sight), and answers `200 {"license_key": ..., "activation": ...}`.
4. The app feeds that pair to the **existing** `evaluate` exactly as a typed or deep-linked
   pair (the server's answer is untrusted until the baked org key verifies it, so a hostile or
   confused server cannot make anything Licensed). Stored in `LicenseStorage` like any pair;
   then `transaction.finish()`; then the M5 landing.
5. **Restore Purchases** = `AppStore.sync()`, read `Transaction.currentEntitlements`, redeem
   the license product's JWS the same way. Idempotent on `originalTransactionId`: same key
   back, no second mint. Works on any device signed into the buyer's Apple ID.
6. The card already has tap-to-reveal for the key, so an iOS buyer can type the key on Android or
   desktop (one `GET`, existing path) without sync; with M6 it just appears.

**Offline / failure at purchase time.** The StoreKit purchase itself needs the network, so the
window is "App Store reachable, FUTOpay not" (outage, captive portal, 5xx). The unfinished
transaction stays in StoreKit's queue, and the shell also keeps the JWS in a pending slot in
`LicenseStorage` (a string awaiting redemption, never evaluated, never shown as Licensed: D8
means the shell does not trust StoreKit's `.verified`). The License card shows a fourth state,
"Purchase received, not yet activated", with **Try again** and **Restore Purchases**, both
user-initiated. No launch-time or Settings-visit auto-retry (that would be a background network
call); whether the card may retry once when the user opens it is a question for @justin (§ 9).
Cost of this design versus ADR-0007: between a paid purchase and a successful redemption the
user is not Licensed, where the offline proof would be Licensed instantly. Apple keeps the
transaction, so nothing is lost, only delayed; support can point to Restore.
Server answers map as: 200 verified; transport error or 5xx = pending; 4xx (bad JWS, wrong
bundle/product/environment) = "couldn't verify this purchase, contact support" (new copy), nothing
stored.

### 7c.2 lib-polar (read-only study; nothing there was changed)

**How keys are minted today.** A Polar `order.paid` webhook (`api/public/webhooks.py`,
`POST /webhook/polar/{org_slug}`) or the buyer's status poll both funnel into
`issue_session_license` (`utils/org_tools.py`), serialized by `app_session_issue_lock`, which
confirms the purchase with Polar and calls `create_key_func`. `create_key_func(db, org_slug,
product_slug, customer_email)` is the reusable core and is already what the admin route
`/admin/createkey/{org}/{product}` calls: it generates a key + activation with the org's RSA
key, inserts a `used_license_keys` row (public schema) and a `license_activations` row (org
schema, keyed by `license_key`). `GET /api/v1/activate/{key}` then serves the stored
activation (`api/public/pages.py`). Data model: `organizations` (signing key pair),
`futopay_products` (per org; already has an unused-for-this `apple_store_url`),
`used_license_keys`, `license_activations`, `app_sessions`. Tables and missing columns are
created at startup from the model lists (`_PUBLIC_TABLES` / `_ORGANIZATION_TABLES` in
`db_manager.py`), so a new table needs no migration script.

**New endpoint.** `POST /api/v1/redeem/apple/{org_slug}`, body `{"signed_transaction": "<jws>"}`,
in a new `api/public/apple.py` bound from `bind_public_api` (`api/public/__init__.py`). Steps:
verify, check the product mapping, then under a lock (or an `INSERT ... ON CONFLICT DO
NOTHING` on the primary key, then re-read) look up `original_transaction_id`; if absent call
`create_key_func(db, org, product, customer_email="apple:<originalTransactionId>")`, store the
mapping, and return the key plus the activation the activation table holds. Idempotent and
race-safe because the mapping row is the single source; two concurrent first redemptions must
yield one key, mirroring `app_session_issue_lock`.

**Storage.** New public table `apple_transactions`: `original_transaction_id` PRIMARY KEY,
`license_key`, `org_slug`, `product_id`, `apple_product_id`, `bundle_id`, `environment`
(`Production`/`Sandbox`), `first_transaction_id`, `t_created`, `t_last_redeemed`,
`redeem_count`. Add a `DatabaseManager` getter/insert next to `get_used_license_key`.

**Verification with Apple's library** (`pip install app-store-server-library`, Python 3.8+;
this server is 3.12). API as read 2026-10-16:
`SignedDataVerifier(root_certificates: List[bytes], enable_online_checks: bool, environment,
bundle_id, app_apple_id=None)`, then `verify_and_decode_signed_transaction(signed_transaction)
-> JWSTransactionDecodedPayload`; failures raise `VerificationException` carrying a
`VerificationStatus` (`INVALID_APP_IDENTIFIER`, `INVALID_ENVIRONMENT`, `INVALID_CHAIN`,
`INVALID_CERTIFICATE`, `INVALID_CHAIN_LENGTH`, `VERIFICATION_FAILURE`,
`RETRYABLE_VERIFICATION_FAILURE`). In that method the library checks `bundleId` and
`environment` equality; it does **not** check `app_apple_id` there, but the constructor requires
`app_apple_id` when `environment == PRODUCTION`. Consequences for us:

- **Roots**: all three Apple roots (Apple Root CA, G2, G3; decided, § 9 Q8) as DER files in the
  repo (README: download from Apple PKI, "provide these certificates as an array"). The
  root-to-trust question is closed; the chain, role and date rules are the library's, not ours.
- **A verifier is per environment**: build one for Production (needs the numeric App Store app
  id) and one for Sandbox, and try Production then Sandbox, or read the unverified `environment`
  claim only to choose which verifier to try, never to skip verification.
- **Never construct a verifier for `XCODE` or `LOCAL_TESTING`**: for those the library returns
  the payload **without checking the signature** (its `_decode_signed_object` skips verification
  and leaves the environment check to the caller). Only `PRODUCTION` and `SANDBOX` are ever
  configured, and a test asserts it.
- **`enable_online_checks`**: `True` makes the library call Apple's OCSP responder per
  verification (30 s timeout, `RETRYABLE_VERIFICATION_FAILURE` on network trouble) and use the
  current date for certificate validity; `False` validates against the transaction's signed
  date and makes no outbound call. Refunds are out of scope (@justin 2026-10-16), so recommend
  `False`: no new availability dependency on Apple's OCSP host. Not revisited unless refunds return.
- **Claims we check ourselves** after the library: `productId` equals the configured Apple
  product id, `type` is non-consumable, `inAppOwnershipType == PURCHASED` (reject family-shared),
  and bundle id as configured. `revocationDate` is ignored (refunds are not a concern); it can
  be turned into a 4xx later with one line.
- **App Store Server API keys are not needed.** We verify a JWS Apple already signed; no call to
  Apple's API. Keys (and a JWT signer) would only be needed to fetch transaction history,
  look up a refund, or send test notifications, all out of scope.

**Config / secrets.** No new secret. Non-secret config: `APPLE__BUNDLE_ID` (`com.futo.notes`),
`APPLE__APP_APPLE_ID` (numeric, from App Store Connect), `APPLE__ROOT_CERT_DIR`,
`APPLE__ACCEPT_SANDBOX`, and a per-product map from the Apple product id to the FUTOpay
org/product slug in the same `.env` style the v2 branch uses
(`POLAR__ORGS__FUTO_NOTES__PRODUCTS__FUTO_NOTES__APPLE_PRODUCT_ID`). The org signing key is the
existing one (no new key; the memory note on org keys applies: the deployed key, not 1Password,
is the authority).

**Staging vs production.** The deployments split exactly as today (`staging-pay2` mints with the
staging org key, `pay2` with the production key), and the client's `Environment` already picks
host + key together (no dev/prod crossover). Two facts shape this:

1. A `.dev` bundle has no App Store Connect record, so it can only buy through an Xcode StoreKit
   configuration, whose transactions are `XCODE`-environment and **unverifiable by the server by
   design**. So `.dev` builds cannot exercise the real endpoint end to end. Real Sandbox
   purchases come from a **TestFlight build of `com.futo.notes`**, and TestFlight/App Review
   purchases are Sandbox transactions in the *release* binary, which talks to **production**
   FUTOpay. So the production deployment must accept Sandbox transactions (this is the server
   half of Q7), or the reviewer's purchase fails.
2. The staging path remains testable through the existing `FUTO_LICENSE_ENV=staging` compile
   flag on a TestFlight build of the release bundle: staging FUTOpay is configured with the
   release bundle id and accepts Sandbox only.

**Sandbox abuse, and the recommended containment.** A Sandbox JWS is a real Apple signature, and
TestFlight purchases are free, so on a production server that accepts Sandbox, anyone who can
install our TestFlight build can mint production keys. The stakes are a cosmetic (and ADR-0004
already accepts reuse), but it is unbounded. Options: (a) accept it, flag the row
`environment=Sandbox` so keys can be audited; (b) mint Sandbox redemptions as **v2 activations
with a short `expires_at`** (needs the v2 branch; the client already verifies v2 and shows
Expired); (c) refuse Sandbox in production and give the reviewer a review-only build (a second
binary: rejected by Q7 as written). Recommendation: (b) if v2 lands first, else (a).

**Is the v2 branch a prerequisite? No.** `create_key_func` on `main` mints v1, which the client
accepts today. The branch (`feat/futo-notes-v2-activation`, last commit 2026-09-09, 63 commits
behind `main`, merge-base `fac91ab0`) adds per-product `activation_format`/`license_term_months`
and `issue_activation`. It helps (a real `issued_at` for the card, the product bound into the
signature, short-expiry Sandbox keys) and it hardens the v1 tripwire (`crates/futo-notes-license/
AGENTS.md`), but redemption through v1 is correct. If both are wanted, land v2 first: the
redeem endpoint then calls the same `mint_license_key_pair` the branch introduces. Verified by
reading the diff only; I did not run either branch.

**Rate limiting / abuse.** lib-polar has no rate-limit machinery (grep for slowapi / rate-limit
finds only an unused `RateLimitError` class). Verification is a local ECDSA + chain check with
`enable_online_checks=False`, so garbage bodies are cheap to reject; a mint needs a valid Apple
signature and happens once per `originalTransactionId`. A JWS is a bearer proof: replay returns
the same key, exactly ADR-0004's stance. Add a body-size cap and a per-IP limit at the reverse
proxy rather than in the app (not verified what fronts pay2; ask the lib-polar owner).

**Tests (lib-polar).** No Apple dependency in CI: tests mint a throwaway CA, leaf and ES256 JWS
and pass the throwaway CA as the verifier's `root_certificates` (the library takes whatever
roots it is given). Cases: valid mint, replay returns the same key, concurrent first
redemptions yield one row, wrong bundle, wrong product, wrong environment, family-shared,
tampered payload, chain to an unknown root, `alg` not ES256, Xcode-environment payload rejected
(proves we never configure it), Sandbox refused when `ACCEPT_SANDBOX` is off. One golden from a
real TestFlight transaction (captured once, checked in with its date; its leaf will have expired
so the test pins the effective date by running with online checks off, as production does).
Existing test style: plain `test_*.py` under `pylib/futopay_server/tests/`, runnable without a
database for the pure-function ones (see `test_activation_v2.py` on the branch).

**Deploy.** The table is created on next startup; add the dependency to `pyproject.toml` and the
`server.Dockerfile` image; set the `.env` variables on staging and production; ship the Apple
root files with the image. **Hard ordering**: production FUTOpay must be live with the endpoint
and Sandbox acceptance **before** an App Store submission, because App Review exercises it.

#### lib-polar task list

| # | Task | Size | Files |
|---|---|---|---|
| L1 | Dependency + Apple roots + config (`APPLE__*`, product map), `AppleVerifier` wrapper: per-environment verifiers, claim checks, never XCODE/LOCAL_TESTING, mapped exceptions | S-M | `pyproject.toml`, `server.Dockerfile`, new `licensing/apple.py`, new `licensing/apple_roots/*.cer`, `common.py` (config), `env.example` |
| L2 | `apple_transactions` table + manager getter/insert, race-safe first-redeem | S-M | `database/dto.py`, `database/db_manager.py` (`_PUBLIC_TABLES`) |
| L3 | `POST /api/v1/redeem/apple/{org}` route: verify, map, mint via `create_key_func` (or v2 `mint_license_key_pair`), idempotent, JSON response, error codes (200/400/403/404/409/503) | M | new `api/public/apple.py`, `api/public/__init__.py`, reuse `utils/org_tools.py` |
| L4 | Tests with a throwaway CA (+ one real golden) | M | `tests/test_apple_redeem.py`, `tests/conformance/` |
| L5 | Sandbox policy: acceptance flag, row flag, optional short-expiry v2 | S (L if v2 not yet landed) | `api/public/apple.py`, branch `feat/futo-notes-v2-activation` |
| L6 | Deploy: staging then production, App Store Connect ids, proxy limit, README section | S | `README.md`, deployment repo (not read) |

Whole lib-polar side: **M** (about a week of focused work including tests; L5's v2 dependency is
the only thing that could widen it).

### 7c.3 FUTO Notes (this repo)

**Rust (`crates/futo-notes-license`, `crates/futo-notes-ffi`).** No JWS verifier, no Apple roots,
no `LicenseProof` enum, no `evaluate` change. What is left:

- `redeem_apple(jws, config, transport) -> Result<AcceptedLicense, EnterKeyError-like>` next to
  `enter_license_key`: POST the JWS, parse `{license_key, activation}`, then `evaluate` the
  pair like any other (the same `LicensePair`, the same product and key-prefix checks). Reuses
  `AcceptedLicense`. `redeem_url(config)` joins the existing `activation_url` in `config.rs`
  (same environment-selected host).
- The transport trait is GET-only today (`ActivationTransport::get`); add `post_json` (or a
  sibling trait) and `Pay2Transport::post_json` in `futo-notes-ffi/src/license/transport.rs`
  (same timeouts, no redirects, no retry). The "exactly one GET" rule in
  `crates/futo-notes-license/AGENTS.md` and license.md becomes "at most one request per
  explicit action".
- FFI: `license_redeem_apple(jws, bundle_id)` in `contract.rs` mirroring `license_enter_key`;
  Tauri gets nothing (desktop never purchases).
- Conformance: extend `tests/conformance/license.json` with redeem cases (200 with a signed pair,
  200 with a bad signature, 404/4xx, 5xx, transport failure, wrong product) and the
  "panics on any request" transports stay for the offline paths.

**iOS (`apps/ios/Sources/License/`).** `LicenseStoreKit` (load product, Buy, Restore,
`Transaction.updates` observed only to *deliver* unfinished transactions into the pending slot,
never to call the network); `LicenseStorage` gains the pending-JWS slot; `LicenseModel` gains a
`pendingRedemption` state and the redeem action; `LicenseSettingsSection` the fourth card state
+ Try again + Restore; the picker's key-only sheet becomes Buy + "I already paid"
(`LicenseCopy`: new strings for the pending and not-verified states, catalog entries, English
only). No refund handling (nothing observes `revocationDate`). Tests: `LicenseModelTests` with a
fake store and fake redeem (success, cancel, `.pending`, transport failure leaves the pending
slot and keeps the transaction unfinished, retry succeeds, restore returns the same key, 4xx
stores nothing); a StoreKit configuration file for UI tests, where the redeem call is faked
because the server cannot verify `XCODE` transactions. A sandbox purchase through a TestFlight
build against staging FUTOpay is the real end-to-end check (needs L1-L5 deployed to staging).

**M6 gets smaller.** It only ever carries a FUTOpay pair (`{key, activation}`): no tagged union,
no "prefer the FUTOpay pair" ranking, no Apple verification on Android and desktop, no
refund/revocation tombstone rule (§ 9 Q9 shrinks to the offline-Remove rule § 7 already needs),
and an iOS purchase reaches Android/desktop as a plain pair or a typed key. § 7's remaining
costs (engine slot, LWW rule, `/slow-review`) are unchanged.

**Specs/ADR.** ADR-0007 gains a "superseded in part by 7c" note if chosen; license.md
principles (network wording, "never sent to FUTO"), § Store posture, a Restore section; plan
D15 text.

#### FUTO Notes task list

| # | Task | Size | Files |
|---|---|---|---|
| A1 | Rust redeem workflow + `redeem_url` + POST transport + FFI export + conformance cases | M | `crates/futo-notes-license/src/{enter,config,lib}.rs` (or new `redeem.rs`), `crates/futo-notes-ffi/src/license/{contract,transport,mod}.rs`, `tests/conformance/license.json`, `scripts/gen-license-fixture.mjs` |
| A2 | iOS StoreKit layer: Buy, Restore, pending slot, finish-after-activate | M | new `LicenseStoreKit.swift`, `LicenseStorage.swift`, `LicenseModel.swift` |
| A3 | iOS UI: pending/not-verified card state, Try again, Restore, Buy in the picker sheet, copy + catalog | S-M | `LicenseSettingsSection.swift`, `LicenseCopy.swift`, `AppIconPicker.swift`, `languages/en.json` |
| A4 | iOS tests (fake store/redeem), StoreKit config file, TestFlight-vs-staging QA pass | M | `apps/ios/Tests/...`, `*.storekit` |
| A5 | M6 simplified to one proof kind (already its own MR) | L (as before, minus the Apple branch) | `crates/futo-notes-sync/...` |
| A6 | Spec + ADR + plan edits; App Store Connect checklist (§ 7b, unchanged) | S | `docs/spec/license.md`, `docs/adr/0007-*.md`, this plan |

FUTO Notes side: **M** for A1-A4 (the large risk item, the offline JWS verifier, is gone), A5 as before.

### 7c.4 Comparison with ADR-0007 (offline proof)

| | ADR-0007: offline Apple JWS in Rust | 7c: redeem for a FUTOpay key |
|---|---|---|
| lib-polar | none | M (L1-L6) |
| FUTO Notes Rust | verifier + roots + chain/role/date rules + new proof type through `evaluate`/FFI/Tauri + test CA + real golden: L, highest risk | redeem workflow + POST transport: M |
| iOS shell | StoreKit + Restore + `Transaction.updates` revocation removal | StoreKit + Restore + pending state |
| Android / desktop | verify a synced Apple JWS (needs M6 or nothing) | a real key, typed in with one request, or via M6; works without sync |
| M6 | two proofs, ranking, tombstone-for-refund | one proof kind |
| Licensed after purchase | instantly, offline | after one FUTOpay round trip (pending state if it fails) |
| FUTOpay availability | irrelevant | a hard dependency at purchase and at Restore, and **during App Review** |
| Sandbox (Q7) | client rule needing `AppTransaction.environment` | server flag; TestFlight/review hit production FUTOpay |
| Apple roots / chain rules (Q8) | ours to get right and keep current | Apple's library's |
| Display (Q10) | no key, no `issued_at` | a normal key card |
| Privacy | JWS never leaves the device | JWS (with `originalTransactionId`) goes to FUTO |
| Account binding | proof bound to Apple ID, portable only via the vault | key is bearer and portable; Apple ID only needed to Restore |

Open questions that disappear: Q8 (roots, validation time: the library), Q10 (display), the
tagged-proof part of M6, Q7's client-side `AppTransaction` input. Q9 shrinks. New ones: the
Sandbox containment above, whether the card may retry on open, the proxy rate limit, and the
prod-deploy ordering before submission.

Risks of 7c worth naming: (1) money taken but no key when FUTOpay is down, softened by
Apple's durable transaction and Restore, but a support burden; (2) App Review runs against
production FUTOpay, so an outage or a mis-set Apple app id is a rejection (guideline 2.1) with
no client-side fix; (3) a server bug is fixed in minutes, a verifier bug in the shipped app
needs a release; (4) FUTOpay being ever retired strands Restore (existing keys keep verifying
offline); (5) the Sandbox-mints-production-keys exposure.

**Recommendation.** Take 7c. It deletes the riskiest, least-verified piece of ADR-0007 (a
hand-written Rust copy of Apple's `ChainVerifier`, which ADR-0007 itself says nobody has read),
reuses the one mint path and the one client rule that already ship, and gives Android and
desktop a real key. Its price is a hard FUTOpay dependency at purchase and review time and a
privacy reversal (the JWS goes to FUTO), both of which are bounded and operable. Order: L1-L3
and L4 on staging first, then A1-A2 against a TestFlight build with `FUTO_LICENSE_ENV=staging`,
then production deploy, then submit. Land v2 first only if the short-expiry Sandbox containment
is wanted; it is not required for correctness.

Not verified: the Apple library was read through a summarizing fetch of its README and
`signed_data_verifier.py`, not a checkout, so exact exception class names and the
`JWSTransactionDecodedPayload` field names should be confirmed against the installed version;
Apple's own JWSTransaction/`jwsRepresentation` doc pages returned 404 to the fetch tool; that
TestFlight purchases are Sandbox-environment is from general knowledge (ADR-0007 states it the
same way); what fronts pay2 (rate limit), the deployment repo's env handling, and whether a
Sandbox `originalTransactionId` is reused across tester resets were not checked; no code was
run in either repo.

## 8. Order and sizing

| Milestone | Scope | MR |
|---|---|---|
| M1 | Rust rule + FFI/Tauri projection + spec/ADR rewrite + catalog | this plan's MR, then a feature MR |
| M2, M3 | iOS and Android picker and row | same feature MR |
| M4 | Buy URL `from` | same feature MR (small, independent commit) |
| M5 | Post-activation landing | same feature MR, last |
| M6 | License follows the vault (both proofs) | **separate MR after OK on § 7; REQUIRED before M7 ships (D16)** |
| M7 | iOS in-app purchase | **separate MR, after M6**; Rust verifier first (largest risk), then the shell. Needs the App Store Connect checklist done by @justin before review. Rough size: M6 large (sync engine, `/slow-review`), M7 medium-large |

M1–M5 are unchanged and independent of M6/M7. M6 and M7 are the critical path to a store release that includes icons on iOS outside the US; until then, ADR-0005's key-only shape (and its review risk) is what ships.

Time box: M1–M5 is one merge request. If it is not green in a week, ship M1–M3 and move M4–M5
to a follow-up rather than growing the MR.

## 9. Open questions for @justin

Resolved 2026-10-15: picker treatment is A (D11).
Resolved 2026-10-16 (@justin): M6 waits for its own MR (feasibility is in § 7); iOS
Expired → Renew is accepted on unit coverage (no expired staging fixture, no simulator
clock control — the same bar as the License card).

Decisions 2026-10-16 (@justin), recorded with the 7c scoping:

- **Refunds are not a concern.** Nothing is designed for them: no revocation handling, no
  tombstone-for-refund rule, no OCSP/revocation checks (Q9 reduces to the offline-Remove rule).
- **US builds point to the website** (link-out, as today; ADR-0005's US row stands). This
  answers Q6 for now: the US storefront keeps the website Buy link; whether it also shows IAP is
  not separately asked.
- **Sandbox transactions are accepted when the app is not a production App Store install**
  (Q7: yes). Under 7c this lands server-side (a production FUTOpay that accepts Sandbox,
  with the containment options in § 7c.2) rather than as a client `AppTransaction` rule.
- **M6 carrier = option (a), the hidden vault slot** (Q3, **confirmed**): a dedicated engine
  slot at a reserved non-`.md` path, never a file on disk (§ 7 Feasibility).
- **Roots to trust = all current Apple roots, with Apple's chain constraints** (Q8, delegated to
  the coordinator and decided 2026-10-16): do what Apple's official App Store Server Library does.
  Trust Apple Inc. Root (Apple Root CA), Apple Root CA - G2 and Apple Root CA - G3 (the three
  roots listed at <https://www.apple.com/certificateauthority/>, read 2026-10-16), not G3
  alone, so a root rotation does not break verification. Enforce the library's constraints:
  chain of exactly three certificates (leaf, intermediate, root); the leaf carries extension OID
  `1.2.840.113635.100.6.11.1` and the intermediate `1.2.840.113635.100.6.2.1` (presence only, as
  the library checks; a chain that merely ends at an Apple root is not enough); OpenSSL strict
  mode; validity evaluated at the transaction's signed date when online checks are off (the
  library's `effective_date` rule). Source: `signed_data_verifier.py` in
  [app-store-server-library-python](https://github.com/apple/app-store-server-library-python),
  read 2026-10-16 through a summarizing fetch (re-confirm the OIDs against the checked-out
  source before relying on them). On the 7c route this lives in lib-polar through the library
  (ship all three roots in L1); on the ADR-0007 offline route the Rust verifier ships the same
  three roots and the same constraints. This replaces the "G3 alone?" question in § 7b and Q8.
- **Open:** ADR-0007 (offline proof) versus § 7c (receipts become FUTOpay keys): scoped, with a
  recommendation for 7c, not decided.

Taken as written (2026-10-15, the docs/catalog pass; reopen with @justin if wrong):

- Q1: Expired closes the picker (D3 as written).
- Q2: the toast is enough on desktop.
- Q4: the row hint shows on key-only builds.
- Q5: not in scope.
- Q3: **resolved 2026-10-16**, option (a), the hidden vault slot (see the decisions above).

D14-D16 (2026-10-16): the icon restriction applies everywhere; iOS sells the license as an IAP (ADR-0007); M6 is required first. Q6-Q10 below are new.

This pass is **iPhone only**: Android UI (M3) and desktop UI are deferred, and the specs record Android as a Gap.

1. D3: should Expired keep the picker open (a lapsed buyer keeps choosing) or close it as
   written? Written: closes.
2. M5 on desktop: there is no picker, so nothing to land on. Confirm the toast is enough.
3. M6 § 7: which carrier, (a) hidden vault path or (b) protocol object kind, once the
   feasibility note is written.
4. Does the row hint ("With a license") belong on key-only builds, where the row cannot lead
   to a purchase? Written: yes, the hint names a fact, not a sale.
5. **Resolved (@justin 2026-10-16):** the reviewed Settings sketch (`01-settings-row-hint.png`)
   shows the License card's paragraph as "FUTO Notes is paid for by you, not by ads or by
   selling your data." Justin chose the sketch wording: `license.explanation` now says exactly
   that, replacing the FUTO mission paragraph.
6. **US build (ADR-0007)**: with IAP, does the US storefront show website link-out *and* IAP,
   or IAP only? Link-out is 0% commission today but leaves the proof in a FUTOpay key; IAP-only is
   one flow everywhere. ADR-0005 recorded your preference order as link out, then text, then IAP.
7. **Sandbox in the release binary**: TestFlight and App Review purchases are Sandbox
   transactions in the `com.futo.notes` binary. A strict rule (Production only on release)
   fails the reviewer's purchase. Options: (a) accept Sandbox in the release config only when the
   running app's own `AppTransaction.environment` is not Production (a shell-supplied input;
   unverified that review builds report Sandbox there); (b) accept Sandbox everywhere, which lets
   anyone with a sandbox account for our bundle mint a license; (c) ship a review-only build. We
   propose (a); confirm before M7.
8. **Chain validation time and roots**: validate certificate dates at the signed time rather than
   now, and which Apple roots to trust (G3 only, or all of them per Apple's guidance). Needs
   a read of Apple's `ChainVerifier` source before coding.
9. **Offline-Remove / refund rule**: M6's tombstone-wins decision now also governs refunds
   (a revoked Apple proof removes the synced copy; an offline device republishing it must not
   win). Needs the same explicit rule as § 7.
10. **Display**: what does the Licensed card show for an Apple proof (no key to show, no
    `issued_at` from the pair; `purchaseDate` is in the JWS)?

## 10. Sketches

| File | Shows |
|---|---|
| `license-cosmetics/01-settings-row-hint.png` | Settings, unlicensed, link-out build: the row hint, the only Settings-level change |
| `license-cosmetics/02-picker-unlicensed.png` | The picker unlicensed: A (chosen) beside B (rejected) |
| `license-cosmetics/03-tap-sheet.png` | The sheet on tapping a coined tile, link-out and key-only builds |
| `license-cosmetics/04-after-activation.png` | The landing right after activation, and the licensed picker on any later visit |
| `license-cosmetics/05-android-and-second-device.png` | Android's bottom sheet, and a second synced device after M6 |
