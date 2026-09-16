# Plan: ship the paid client license on desktop, iOS and Android

Status: decisions taken 2026-09-16 by @justin; implementation not started.
Branch: `feat/license` (MR !303, draft). Behavioral truth: `docs/spec/license.md`.
Design: the "Steel Ledger" artboard on the design canvas, version 4 (ring removed) —
<https://claude.ai/artifact/A4wh9z11msn9RVY6LRoNMj>.

This plan is written for an implementing agent. Read root `AGENTS.md`, then
`src/AGENTS.md`, `crates/futo-notes-license/AGENTS.md`, `apps/tauri/AGENTS.md`,
`apps/ios/AGENTS.md`, `apps/android/AGENTS.md` and `docs/spec/AGENTS.md` before
touching their layers. Every phase ends with the verification listed for it and a
commit in `type(scope): imperative summary` form with a `Verified:` line.

## 0. Decisions (locked — do not reopen without @justin)

| # | Decision | Value |
|---|---|---|
| D1 | Card treatment, all three platforms | **Steel Ledger** plate: one container (the plate is the card), gunmetal gradient, gold accent, a 184px circular **well** with an inset shadow and **no ring/outline**, present in every state; a 160px coin sits in it when Licensed, the well is empty otherwise. |
| D2 | Date line vs v1 reality | Ship with the "since" row implemented but **blank for v1** activations (production mints v1 today, so no real buyer sees a date until FUTOpay serves v2). No release is blocked on v2. |
| D3 | Wording of the dated line | **"Licensed since {date}"**, full localized date, never a bare year. Replaces "Supporter since {year}" everywhere (spec, catalog, three shells, footer). |
| D4 | License key on the card | **Shown masked**; click/tap reveals the full key and offers Copy. |
| D5 | Mobile | iOS and Android get the **same plate card** (native SwiftUI / Compose) with a **static** coin. Only desktop animates. |
| D6 | Unlicensed/Expired paragraph | Unchanged: `license.explanation` (the FUTO mission sentence). |
| D7 | Licensed paragraph | `license.explanationLicensed` = **"Thank you for paying for FUTO Notes."** (one sentence; the second sentence is removed). |
| D8 | Buy button | Unchanged: "Buy a license"; Expired says "Renew". |
| D9 | Store posture | Unchanged from 2026-09-09: Buy link ships worldwide on iOS and both Android flavors, `LICENSE_LINK_OUT` true. |
| D10 | Fonts | No new font files. Barlow 400/500/600/700 are bundled (`src/styles/fonts.css`); the mock's Barlow Condensed becomes Barlow 700 uppercase with tracking, and the mock's JetBrains Mono key value uses the platform's system monospace stack. |
| D11 | Rows on the card | **Key**, **Licensed since**, **Term**. The mock's "Verified · ED25519" row is dropped (it is wrong: verification is RSA-SHA256, and the spec forbids the client describing the mechanism). |

Assumptions the implementer may take without asking (flag them in the MR):

- Eyebrow above the product name reads "Client license"; the product name line reads "FUTO Notes". Both are catalog entries even though one is a brand name.
- Term row values: "Perpetual" when `expires_at` is null **or** the activation is v1 (the spec states a v1 license is perpetual by format, so this is not an invented date); "Valid until {date}" when `expires_at` is set and in the future; "Expired {date}" in the Expired state.
- The masked key shows only the **last group**: seven groups of four middle dots then the real last four characters, e.g. `···· ···· ···· ···· ···· ···· ···· 6UJV`. Reveal lasts while the card is mounted; leaving Settings re-masks.

## 1. State of the branch on 2026-09-16 (read before starting)

- 23 commits ahead of `origin/main`, **3 behind**. Merge main first (Phase 1).
- **CI is red on every job** (pipeline 36505): `pnpm install --frozen-lockfile` fails because `pnpm-lock.yaml` lists `@types/three` under `dependencies` while `package.json` has it under `devDependencies`. Running `pnpm install` produces a 6-line lockfile fix; it is sitting **uncommitted** in the `.claude/worktrees/license` worktree.
- `just check` has never been run on the WIP commit `08a31503`. The coin has never been seen in the real desktop app.
- Production FUTOpay has **no `futo-notes` org** (`GET https://pay2.futo.org/checkout/polar/futo-notes/activation/public-key` → "Public key not found"; `/futo-notes-license/info` → "Organization not found"). `PRODUCTION_PUBLIC_KEY_BASE64` in `crates/futo-notes-license/src/config.rs` is a fail-closed placeholder. **Nothing in this repo can ship to real users until Phase 6.**
- Staging is complete: org, product, key baked, a real purchase delivered a key and activated iOS and Android on 2026-09-15 (spec § Gaps).
- Production mints **v1** activations (no `issued_at`, no `expires_at`). Expired and Renew are built and tested but unreachable in production because the product is perpetual.
- MR !303's description is stale (it says the branch is blocked on license delivery). Issues #160 and #161 are open though their work is done.

## 2. Copy: the catalog after this plan

All in `languages/en.json` under `messages.license`. `zh-Hans.json` entries are welcome, not required. Run `pnpm run check:languages` after every catalog edit. Naming grammar: `languages/README.md`.

**Remove** (composite row strings that the card no longer renders):
`license.licensed`, `license.licensedPerpetual`, `license.licensedUndated`, `license.expired`, `license.supporterSince`.

**Keep unchanged:** `sectionTitle`, `explanation`, `unlicensed` ("Unlicensed"), `buy`, `renew`, `enterKey`, `lostKey`, `remove`, `keyLabel`, `keyPlaceholder`, `activate`, `activating`, `cancelEntry`, `openLicenseSettings`, `coinAccessibilityLabel`, `activated`, `keyInvalid`, `linkInvalid`, `offline`.

**Change:** `explanationLicensed` → `"Thank you for paying for FUTO Notes."`

**Add:**

| Key | English |
|---|---|
| `license.statusLicensed` | `Licensed` |
| `license.statusExpired` | `Expired` |
| `license.licensedSince` | `Licensed since {date}` (ambient footer label; `{date}` is the full localized date of `issued_at`) |
| `license.card.eyebrow` | `Client license` |
| `license.card.productName` | `FUTO Notes` |
| `license.card.keyLabel` | `Key` |
| `license.card.sinceLabel` | `Licensed since` |
| `license.card.termLabel` | `Term` |
| `license.card.termPerpetual` | `Perpetual` |
| `license.card.termValidUntil` | `Valid until {date}` |
| `license.card.termExpired` | `Expired {date}` |
| `license.card.revealKey` | `Show key` (accessible name of the masked value; it is a button) |
| `license.card.copyKey` | `Copy key` |
| `license.card.keyCopied` | `License key copied` (toast) |
| `license.card.emptyWell` | `No license` (accessibility label of the empty well when not Licensed) |

The word "donate" must not appear anywhere (spec § Principles). Nothing may call the app "free".

## 3. The shared view-model (drift-registered)

The three shells today share the concept `license-row-copy` in `scripts/drift-registry.json` (`licenseRowText` in `src/features/license/licenseCopy.ts`, `apps/ios/Sources/License/LicenseCopy.swift`, `apps/android/.../license/LicenseCopy.kt`, locked by `licenseCopy.test.ts`, `LicenseCopyTests.swift`, `LicenseCopyTest.kt`). The card replaces the one-line row with a small structure. Rename the concept to `license-card-copy` and give every copy the same shape:

```
licenseCardModel(view) -> {
  status:  'unlicensed' | 'licensed' | 'expired'   // already judged by Rust; never re-derived
  badge:   string | null      // Unlicensed → license.unlicensed; Expired → license.statusExpired; Licensed → null
  since:   string | null      // full localized date of issued_at, or null (row renders blank)
  term:    string             // termPerpetual | termValidUntil{date} | termExpired{date}
  maskedKey: string | null    // '···· … XXXX' from the stored key, null when no license
}
licenseAmbientLabel(view) -> string | null   // desktop footer: license.unlicensed, license.licensedSince{date}, or null for a v1 license (unchanged rule)
```

Rules (unchanged from the spec, restated so nobody re-derives them):

- `since` is null whenever `issued_at` is absent. No stand-in, no fetch time, no current year.
- `term` for a v1 activation is `termPerpetual`.
- Expired always has both dates; keep the existing guard that falls back to Unlicensed if it ever arrives without them (the "Supporter since NaN" guard).
- Whether the state is licensed/expired/unlicensed is Rust's answer (`LicenseView.state` / `LicenseStatus`). The model formats; it never judges.

Update the drift-registry entry's `concept`, `description`, `copies[].pattern` (new function names) and keep `lockStatus: partial` with the same three test locks. `just check-drift` must pass.

## 4. Rust: the key crosses the boundary

Both `LicenseView` records gain the stored key so every shell reads it from the same place (there is no desktop route to it otherwise, and iOS/Android should not reach past the contract into their own storage for display):

- `apps/tauri/src-tauri/src/license.rs` — `pub struct LicenseView { …, pub key: Option<String> }`, `None` when Unlicensed. Populate it wherever a `LicenseView` is built from a stored pair (the status read, `license_enter_key`, `license_remove` → `None`, the pending-link drain). Extend the existing lib tests: `cargo test -p futo-notes-tauri license` (15 tests today) must cover "the view carries the normalized key when licensed and nothing when not".
- `crates/futo-notes-ffi/src/license/contract.rs` — `pub struct LicenseView { …, pub key: Option<String> }` and `license_evaluate` fills it from `stored.map(|p| p.key)`. Add a contract test beside the 29 existing ones. Rebuild bindings before native work (`just build-rust-ios`, `just build-rust-android`; M9).
- `src/lib/platform/license.ts` — `LicenseView.key: string | null`; `UNLICENSED` gets `key: null`. Update `src/lib/platform/tauri/license.ts` and its contract test if it asserts the shape.
- No license **rule** changes. `futo-notes-license` itself is untouched; `just test-rust` still passes with the goldens as they are.

This is an IPC record change, not an `AppState` schema or sync payload change, so it does not fall under root AGENTS.md §11 item 6.

## 5. Phases

Work top to bottom. Each phase is one or more small commits.

### Phase 1 — make the branch honest (½ day)

1. Commit the lockfile fix that is sitting in the worktree: `build(deps): move @types/three to devDependencies in the lockfile`. Verify with `pnpm install --frozen-lockfile --offline`.
2. `git merge origin/main` (3 commits). Resolve conflicts with the `/resolving-merge-conflicts` skill; the license files most likely to conflict are `SettingsScreen.svelte`, `SettingsView.swift`, `SettingsScreen.kt`, `FullReset.swift`.
3. Run `just check`. Fix whatever the WIP left red (expect nothing beyond the lockfile; svelte-check was clean once `three` was installed).
4. Open `just tauri-dev`, activate the staging fixture license (any fixture pair from `tests/conformance/license.json` signed by staging, or a real staging key), open Settings, and **look at the coin**. Record a screenshot in `test-screenshots/`. This is the first time it runs.
5. Update MR !303's description: replace the "blocked on delivery" paragraph with the 2026-09-15 verification and point at this plan. Keep it Draft.

Verified line for the commit: `just check`, `pnpm install --frozen-lockfile --offline`.

### Phase 2 — copy and view-model, all three shells in one commit (1 day)

Copy is drift-registered, so the catalog, the three view-models and their three locks move together (M7, M17).

1. `languages/en.json`: apply §2. `pnpm run check:languages`.
2. `src/features/license/licenseCopy.ts`: replace `licenseRowText` with `licenseCardModel`; keep `licenseAmbientLabel` and switch it to `license.licensedSince` with `localizedAbsoluteDate(issuedAt)`. Rewrite `licenseCopy.test.ts` cases one for one: unlicensed model, licensed v2 with expiry, perpetual v2, v1 (since null, term perpetual, masked key present), expired, expired-without-dates guard, masked key shows only the last group, ambient label per state.
3. `apps/ios/Sources/License/LicenseCopy.swift` and `apps/ios/Tests/License/LicenseCopyTests.swift`: same function, same cases, using `localization.localizedAbsoluteDate`.
4. `apps/android/.../license/LicenseCopy.kt` and `androidTest/.../LicenseCopyTest.kt`: same. (Android's lock is instrumented because dates go through android.icu; keep it that way.)
5. `scripts/drift-registry.json`: rename and repoint the entry (§3). `just check-drift`.
6. Grep for every remaining `Supporter since`, `supporterSince`, `licensedPerpetual`, `licensedUndated` across `src/`, `apps/`, `docs/`, `tests/`, `.claude/` and fix all of them (M17). `docs/spec/list.md:161` is already stale ("beside the app version") and gets corrected here.

Verify: `just test-one src/features/license`, `just check-drift`, `pnpm run check:languages`, `just test-ios-native`, `just test-android-native-ui` (needs `just qa-claim android`).

### Phase 3 — Rust and TS contract: the key (½ day)

Apply §4. Verify: `cargo test -p futo-notes-tauri license`, `cargo test -p futo-notes-ffi`, `just test-rust-full`, `just check-command-reachability`, `just check-platform-discipline`.

### Phase 4 — desktop plate (1–1½ days)

Files: `src/features/license/LicenseSettingsSection.svelte` (rewrite the markup and styles), `SupporterCoin.svelte` / `supporterCoin.ts` (unchanged API: it fills its box), `SidebarLicenseFooter.svelte` (label text only, via `licenseAmbientLabel`), `src/styles/desktop-native.css` (cursor rules already exist).

Structure (`.license-plate` replaces `.settings-card` for this section only; the `settings-section` heading "License" stays):

```
section.settings-section
  h3.settings-section-title           License
  div.license-plate                   the card, gradient, 12px radius, 22px/24px padding, flex row, gap 24px
    div.license-well [aria-label]     184px circle, inset shadow, NO outline
      SupporterCoin (only when licensed, 160px)      celebrate={license.activations}
    div.license-fields
      span.license-badge (Unlicensed | Expired; none when licensed)
      div.license-eyebrow             Client license
      div.license-name                FUTO NOTES   (Barlow 700, uppercase, 0.02em)
      dl.license-rows
        Key            <button class=license-key aria-label=Show key>···· … 6UJV</button>  → click: full key + [Copy key]
        Licensed since <span>{since ?? ''}</span>
        Term           <span>{term}</span>
      [filled button: Buy a license | Renew]        only when not licensed / expired; the ONE filled button
      [key entry field + Activate + Cancel]          existing behavior, unchanged
      p.license-explanation                          explanation | explanationLicensed
      div.license-links                              Enter license key · Lost your key?  |  Remove license
```

Colors as component-scoped custom properties, redefined under `[data-theme='dark']` (the app's mechanism, `src/styles/theme.css`):

| token | light | dark |
|---|---|---|
| `--plate-a / --plate-b` | `#dfe4e8 / #cdd5dc` | `#2a3139 / #1c2228` |
| `--plate-ink` | `#1c2733` | `#e6ebef` |
| `--plate-ink-dim` | `#4f5d6a` | `#9aa6b1` |
| `--plate-rule` | `#a9b4be` | `#3d4650` |
| `--plate-accent` (gold) | `#b8860b` | `#ffbb00` |
| well shadow | `inset 0 2px 6px rgba(0,0,0,.28), inset 0 -1px 0 rgba(255,255,255,.35)` | same |

Rules:

- **No CSS `transition` on any theme-dependent property** of the plate (`just check-theme-single-pace` fails otherwise; see `docs/spec/app.md`).
- The filled button keeps `--color-primary` (the app orange); the gold accent is for rules, the badge border and link color inside the plate only.
- Layout must survive a narrow Settings pane: below ~520px the well stacks above the fields (media query on the settings container width or `flex-wrap`). Test at the minimum window width `just tauri-dev` allows.
- Copy uses `writeClipboardText` from the platform adapter (`src/lib/platform`), never a direct `@tauri-apps/plugin-clipboard-manager` import (platform discipline). Show `license.card.keyCopied` via `showGlobalToast`.
- Reveal state is component-local `$state`; it resets on unmount.
- The coin's `role="img"` label and the empty well's label are both catalog entries (§2).
- Keep `license.activations` driving `celebrate`; the tests for it already exist.

Tests: extend `license.svelte.test.ts` only if model behavior changes (it should not). Add a Playwright spec `tests/license-card.spec.ts` that mocks the platform license module to each of the three states plus v1 and asserts: badge text, since row blank for v1, masked key text, reveal shows the full key and the Copy control, Buy present only when not licensed, Remove only when licensed. Follow `src/AGENTS.md` for the mocking pattern. Add the spec to whatever CI job runs `tests/*.spec.ts` (`test:e2e:rest` picks up everything except the P0 spec; confirm with `pnpm run test:e2e:rest`) — a new test job would need `release:gate.needs` (M14), so prefer joining the existing one.

Verify: `just build`, `just test-one src/features/license`, `pnpm run test:e2e:smoke`, the new spec, `just check-theme-single-pace`, screenshots of all three states in light and dark via the dev app's webview bridge (`/verify`, desktop reference; never OS-level input, M24).

### Phase 5 — native plates (2 days: 1 iOS, 1 Android)

Static coin asset, one source: the flat SVG path in `SupporterCoin.svelte` (gold gradient disc with the FUTO diamond). Export it once to `apps/ios/Assets.xcassets/SupporterCoin.imageset/` (SVG, "Preserve Vector Data", single scale) and `apps/android/app/src/main/res/drawable/ic_supporter_coin.xml` (vector drawable; create the `drawable/` directory, none exists). Register the three copies in `scripts/drift-registry.json` as `supporter-coin-glyph`, `lockStatus: unlocked`, and say so in the commit.

**iOS** (`apps/ios/Sources/License/LicenseSettingsSection.swift`, tokens in `apps/ios/Sources/App/Theme.swift`):

- Replace the plain `Section` rows with a custom card view inside the same first `Section` of `SettingsView.swift` (keep it first: spec § States and copy). Use a `ZStack`/`HStack` with the plate gradient, the well as a `Circle().fill(...)` with an inner shadow (`.shadow` on an inset overlay), and `Image("SupporterCoin")` 160pt when licensed. Colors via `Color.adaptive(light:dark:)` as `Theme.swift` does.
- Rows from `licenseCardModel`; masked key is a `Button` with `accessibilityLabel("license.card.revealKey")`; reveal shows the full key in monospaced digits and a Copy button that writes `UIPasteboard.general.string` and shows the toast through the existing `showMessage` banner path in `LicenseModel`.
- Actions still come from Rust: `licenseRowActions(status:linkOut:)`; the Buy/Renew action renders as the one filled button, the rest as text buttons. `LICENSE_LINK_OUT` semantics unchanged.
- Accessibility identifiers keep their current names (`license-status`, `license-buy`, `license-enter-key`, `license-lost-key`, `license-remove`, `license-key-field`, `license-activate`, `license-cancel-entry`) so the QA playbooks keep working; add `license-key-masked`, `license-key-copy`.
- Tests: `LicenseSurfaceTests` gains "the card shows the masked key and reveals on tap" (view-model level; SwiftUI view tests are not worth the weight). `just test-ios-native`. Then drive it on the claimed simulator (`eval "$(just qa-claim ios)"`, `just ios-native`) through all three states with the staging fixture; screenshots to `test-screenshots/`.

**Android** (`apps/android/.../ui/LicenseSettingsSection.kt`, tokens `ui/theme/Color.kt`, `Type.kt`, `Shape.kt`):

- Replace the `SettingsGroup` rows with a `Card`-like `Box` (`RoundedCornerShape(FutoRadius.md)`, `Brush.verticalGradient`), the well as a `Box` with `CircleShape` and an inner-shadow approximation (two overlapping circles with alpha), `Image(painterResource(R.drawable.ic_supporter_coin))` 160dp when licensed. Keep it the first group of `SettingsScreen`.
- Masked key is a `TextButton` with `contentDescription` = `license.card.revealKey`; Copy uses `LocalClipboardManager.current.setText(...)` and the existing toast path in `LicenseModel`.
- Actions from `license.actions()` (Rust), Buy/Renew as the filled `Button`, others as `TextButton`. `BuildConfig.LICENSE_LINK_OUT` unchanged on both flavors.
- Keep the M1 behavior: while `license.view` is null the card renders its frame with no status.
- Tests: `LicenseSurfaceTest` gains the masked/reveal case; `LicenseLinkOutTest` still runs under both flavors. `just test-android-native`, `just test-android-native-ui`. Drive on the claimed emulator, both flavors (`FUTO_ANDROID_FLAVOR=play just android-native`), screenshots.

Both shells: `just lint-swift` for iOS; Kotlin formatting as the module already does.

### Phase 6 — spec and docs (½ day, same MR)

`docs/spec/license.md`:

- Rewrite § States and copy: the table becomes the card model (status badge, Key masked/revealable, Licensed since, Term, actions per state). Replace every "Supporter since {year}" with "Licensed since {date}". Record D2 explicitly: "with a v1 activation the Licensed since row is present and blank; nothing is invented." Record D4 and the copy action. Record D7's shorter thank-you.
- Coin paragraph: the coin is now on all three platforms as a static glyph; **only desktop turns**. Narrow the existing Gap ("the coin is desktop-only") to "the coin animates only on desktop; native shells show the static glyph" or close it if you consider the static coin sufficient — say which and why.
- Ambient label paragraph: "Licensed since {date}" wording; footer behavior otherwise unchanged.
- Add a line under Entering a key or States: the card shows the stored key masked to its last group; revealing and copying it is local UI, no rule.
- Update the platform authority refs (`→ path`) to the new function names.
- Leave the production-key Gap, the region-gating Gap, the revocation Gap and the license-sync Gap exactly as they are.

Also: `docs/spec/list.md` (footer line), `docs/spec/settings.md` (no wording change needed unless you moved the section), `crates/futo-notes-license/AGENTS.md` (its first paragraph says "Supporter since {year}" and "the supporter coin"), `docs/release/store-submission.md` (privacy blurb mentions "Supporter since"), `docs/adr/0004-…` (mentions the badge wording only in passing; leave unless wrong). Run `rg -n "Supporter since" .` at the end and expect only historical log lines in the spec's dated verification paragraphs.

Use `/spec-sync` to check the spec against what you actually observed on the devices in Phases 4–5.

### Phase 7 — release gate against staging (1 day, QA)

Re-run issue #160's criteria on one commit, all three clients, using `/verify` or `/mr-qa` on the MR. Minimum stories, each observed on screen and against storage (UserDefaults / `futo_prefs` / the desktop app data dir):

1. Unlicensed card: empty well, badge, Buy is the only filled button; Enter license key and Lost your key? as links.
2. Buy opens the **system browser** at `staging-pay2.futo.org/checkout/polar/futo-notes/futo-notes-license/checkout-ready?platform=<p>&success=redirect-to-organization-page`.
3. A real staging purchase (Stripe test card `4242 4242 4242 4242`, e-mail `justin+<unique>@futo.tech`, never `@example.*`) lands on the key page; Activate fires the deep link; the card flips to Licensed with the coin; desktop coin spins up once (`activations`).
4. Paste of each input shape (bare key online → one GET; `key/activation` offline; full `futonotes://` link offline); bare key offline shows the offline toast and stores nothing.
5. v1 license: since row blank, Term "Perpetual", footer label absent on desktop.
6. Masked key shows the last group; reveal shows the full key; Copy puts the exact normalized key on the clipboard.
7. Remove returns to Unlicensed; Full reset clears the license with everything else.
8. Android `play` flavor built with `LICENSE_LINK_OUT=false` hides Buy, Renew and Lost your key and keeps the field and deep link.
9. Dark and light on every platform; narrow desktop window.

Record results in the spec's dated verification block (as #156 and #160 did). Then close #161 and #160 with a note each, and take MR !303 out of Draft.

### Phase 8 — production readiness (outside this repo first; then one small commit)

Blocked on ops/lib-polar. **Stop and ask @justin before every step here** (root AGENTS.md §11 items 2 and 4).

1. A `futo-notes` org and a `futo-notes-license` product (non-recurring, one benefit attached) exist on `pay2.futo.org`. Prove with `GET /checkout/polar/futo-notes/futo-notes-license/info` and `/price`, **not** with the 200 the `checkout-ready` URL returns regardless.
2. Read the production key from the live endpoint `GET https://pay2.futo.org/checkout/polar/futo-notes/activation/public-key`. That endpoint is the authority (FUTOpay generates the pair at org creation; 1Password's copy is not deployed).
3. One commit: `PRODUCTION_PUBLIC_KEY_BASE64` in `crates/futo-notes-license/src/config.rs`, plus a pinned SHA-256 test modeled on `the_staging_key_is_the_real_staging_org_key`, plus the spec's production-key Gap rewritten as closed with the date and the DER SPKI hash. Nothing else changes; the staging-signed fixtures are unaffected.
4. `just tauri-build` a signed macOS bundle and prove the LaunchServices deep-link hop with a production license (the spec's last Gap). Needs a real production key to be minted for the test.
5. Review `docs/release/store-submission.md` once more: no "donate", no "free", screenshots show the new card.
6. Release all three platforms in the same release through `/release`. A human tags.

## 6. Verification chains (what "done" means per layer)

| Layer | Chain |
|---|---|
| Catalog | `pnpm run check:languages` |
| Rust contract | `cargo test -p futo-notes-tauri license`, `cargo test -p futo-notes-ffi`, `just test-rust-full`, `just check-command-reachability` |
| Desktop UI | `just build`, `just test-one src/features/license`, `pnpm run test:e2e:smoke`, `tests/license-card.spec.ts`, `just check-theme-single-pace`, screenshots via the webview bridge |
| iOS | `just build-rust-ios`, `just test-ios-native`, `just lint-swift`, driven on the claimed simulator |
| Android | `just build-rust-android`, `just test-android-native`, `just test-android-native-ui`, driven on the claimed emulator, both flavors |
| Drift | `just check-drift` |
| Everything | `just check` before every push; `just prepush` before taking the MR out of Draft |

## 7. Traps specific to this work

- Never OS-level input for desktop QA (M24); resolve the target with `scripts/qa-target.mjs` and drive the webview bridge. Never pattern-kill (M25).
- No screen-coordinate click injection, no UI scripting, no name-pattern process kills — the QA input-safety gate enumerates them so this doc does not have to. Claim devices with `just qa-claim`; release with `just qa-release`.
- The staging-signed native fixtures only verify on `.dev` builds. A release build shows Unlicensed for everything until Phase 8; that is correct (M3).
- Do not "tidy" `CHECKOUT_PRODUCT_SLUG` into `PRODUCT_SLUG` or vice versa (config.rs explains why).
- Do not add any licensed-only behavior. The card, the coin and the label are the whole reward.
- Do not bump `BRIDGE_VERSION`, touch the sync payload or `AppState` for this work; none of it is needed.
- `git stash` is shared across worktrees; use WIP commits.
- Regenerate UniFFI bindings after the `LicenseView` change before any native build (M9); `just *-native` does it, direct Xcode/Gradle does not.

## 8. Execution log (living — append only)

Each phase appends its own block here when it lands: what changed, the exact
commands run and their results, and anything the next phase must know. **Append
only** — parallel lanes write to this file, so never rewrite or reflow someone
else's block.

### Phase 1 — make the branch honest — DONE 2026-09-16

- `build(deps): move @types/three to devDependencies in the lockfile` (10ef63d9).
  `pnpm install --frozen-lockfile --offline` → green. This was the sole cause of
  pipeline 36505 being red on every job.
- `git merge origin/main` — clean, no conflicts (3 commits: the `just worktree`
  recipe and a papercuts entry). None of the predicted license-file conflicts
  materialised.
- `just check` → **green** (exit 0), after one fix: the QA input-safety gate
  failed on this very plan document, because §7 named three banned QA-input
  tools in a line that forbids them and the gate is deny-by-default on every
  instruction surface. Reworded to point at the gate instead of naming them
  (commit `docs(license): state the QA input prohibition without naming the
  tools`). Do not allowlist that pattern.
- Note for anyone running `just check` from a tool: piping it through `head`/
  `tail` reports the pipe's exit status, not the recipe's (M11). Redirect to a
  file and check `$?`.

### Phase 3 — Rust and TS contract: the key — DONE 2026-09-16

The stored key now crosses every boundary on the view record, so no shell reads
it back out of its own storage for display.

- `apps/tauri/src-tauri/src/license.rs` — `LicenseView` gains `pub key:
  Option<String>` (serialized as `key`; the record is `camelCase`, and a
  one-word field is its own camelCase). Filled in `view_of` from
  `details.key.clone()` for both Licensed and Expired, and `None` in
  `unlicensed_view()`. That covers all four build sites the plan listed for
  free: the status read (`current_view`), `license_enter_key` (`accept_input` →
  `view_of`), `license_remove` (→ `unlicensed_view`) and the pending-link drain
  (the parked result was built by `accept_input`).
- `crates/futo-notes-ffi/src/license/contract.rs` — the UniFFI `LicenseView`
  gains `pub key: Option<String>`, filled the same way in its `view_of`.
  **Deviation from §4, deliberate:** the plan said `license_evaluate` fills it
  from `stored.map(|p| p.key)`. It does not — it fills it from
  `LicenseDetails::key`, which is the crate's *normalized* key. `stored.map(…)`
  would have handed back the raw stored string for a pair that no longer
  verifies, i.e. a key on an **Unlicensed** view (a release build reading a
  staging license, M3), contradicting "`None` when Unlicensed" in the same
  paragraph. Using `details.key` also makes the key identical on the evaluate,
  enter-key and deep-link paths instead of only the first.
- `src/lib/platform/license.ts` — `LicenseView.key: string | null`, and
  `UNLICENSED` gets `key: null`. **The TS field is `key`.** No change was needed
  in `src/lib/platform/tauri/license.ts`: it only `invoke`s and casts, and
  asserts no shape. There is no contract test for it (the platform contract
  tests are `adapter.contract.test.ts` / `imageRendering.contract.test.ts`;
  neither touches license).
- `crates/futo-notes-license` untouched; no rule changed, no golden moved.

Tests (each written red first, then made green):

- `a_licensed_state_carries_the_normalized_key` and
  `an_unlicensed_view_carries_no_key` in `license.rs` — the suite is 17 tests
  now (15 before).
- `a_licensed_view_carries_the_normalized_key` (stores `"  <key lowercased>  "`
  and asserts the view carries the trimmed, uppercased form),
  `an_expired_view_keeps_its_key`, and `an_unlicensed_view_carries_no_key`
  (nothing stored, and a staging pair read by a release bundle id) in
  `contract.rs` — that lib is 32 tests now (29 before).

Commands:

```
cargo test -p futo-notes-tauri license   → ok. 17 passed; 0 failed (exit 0)
cargo test -p futo-notes-ffi             → ok. 32 + 8 + 4 + 3 passed; 0 failed (exit 0)
just test-rust-full                      → exit 0, 27 "test result: ok" lines, 0 failures
just check-command-reachability          → OK — 46 registered commands, 0 allowlisted dead (exit 0)
just check-platform-discipline           → OK — 10 allowlisted OS-glue files, 0 unsanctioned imports (exit 0)
just rust-format-check                   → exit 0 (after `cargo fmt --all`)
pnpm exec tsc --noEmit                   → exit 0
pnpm run check:svelte                    → 0 errors, 0 warnings (exit 0)
vitest run src/features/license src/lib/platform → 167 passed (exit 0)
```

What Phases 4 and 5 must know:

- **Bindings must be regenerated before any native build** (M9): `just
  build-rust-ios` / `just build-rust-android`. They are gitignored, so nothing
  in git changed for them.
- **Two native construction sites will stop compiling once the bindings are
  regenerated**, both owned by the Phase 2 copy lane, so this phase left them
  alone as briefed: `apps/ios/Tests/License/LicenseCopyTests.swift:17`
  (`LicenseView(status:issuedAtMillis:expiresAtMillis:)`) and
  `apps/android/app/src/androidTest/java/com/futo/notes/license/LicenseCopyTest.kt`
  (five `LicenseView(LicenseStatus.…, …, …)` calls). They each need the new
  `key` argument. Nothing in `Sources/`/`main/` constructs the record — every
  other native site only reads fields — so no production Swift or Kotlin
  changed.
- **Two TypeScript fixture literals are now structurally incomplete** and no
  gate catches it, because `tsconfig.json` excludes `src/**/*.test.ts`:
  `src/features/license/licenseCopy.test.ts` (4 `LicenseView` literals) and
  `src/features/license/license.svelte.test.ts` (2). `tsc`, `svelte-check`,
  `eslint` and `vitest` are all green as they stand; add `key` when those files
  are rewritten in Phases 2 and 4.
- The key arrives **already normalized** (trimmed, uppercased) on every
  platform, so a card that masks it to its last group can slice the string
  as-is. It is `null` — never `""` — when there is nothing to show.

### Phase 1.4 — first sighting of the coin — 2026-09-16

First real render of `SupporterCoin.svelte` (WIP `08a31503`) in the desktop
app. Driven through the Tauri MCP bridge on a `.dev` build
(`com.futo.notes.verify.s21.dev`), never OS-level input. Activated with the
staging-signed fixture pair from `apps/ios/Tests/License/LicenseFixture.swift`
(key `FN-AB12-...-RS78` + its v2 activation, the same pair used by the native
suites), entered as a `key/activation` pair via `license_enter_key` — this
verifies offline against the baked `STAGING_PUBLIC_KEY_BASE64`, no network
call. Both the raw Rust command and, for the activation-transition test, the
app's own live `license` model singleton (imported by its already-loaded
module URL, so `license.activations` genuinely incremented through the real
reactive path) were used.

**Verdict: WORKS.** The coin is not blank, not broken, and not a placeholder.

- **Renders**: `buildCoin()` succeeds — `supporter-coin-stage-live` class is
  present, `canvas.getContext('webgl2')` is live and `isContextLost() ===
  false`. Visually it is unambiguously a gold disc with the FUTO diamond
  punched through it (a real cutout — confirmed by seeing through it to the
  page background when the coin turns edge-on), sitting in a ~96×95 CSS-px
  circle inside the License card's ~104–122px-tall row. Screenshots:
  `test-screenshots/desktop-license-coin-light-3.png` (light),
  `desktop-license-coin-dark.png` (dark), `desktop-license-unlicensed.png`
  (pre-activation state — correctly shows no coin, "Buy a license").
- **Spins**: confirmed once with a clean two-frame capture 600ms apart while
  the window was genuinely visible/focused
  (`coin-visible-crop-a.png`→`coin-visible-crop-b.png`, non-empty pixel diff,
  edge-on→face-on rotation). Every other capture in this session — including
  several deliberate attempts at the celebrate-on-activation boost — came back
  pixel-identical, but `document.visibilityState`/`hasFocus()` were `hidden`/
  `false` at every one of those attempts: this is the documented single-display,
  multi-parallel-session confound (`references/desktop.md` "Parallel sessions
  steal focus back within seconds" — several other QA/dev sessions were live on
  this same Mac throughout), not a coin defect. WebKit suspends rAF while
  occluded, which is exactly what was observed. I could not get a
  discardable-free capture of the `celebrate()` fast-spin (`CELEBRATION_SPIN =
  16` vs base `1.25`) specifically, only of the base idle spin — but the
  activation transition itself is proven live (`license.activations` 0→1
  through the real model, `<SupporterCoin celebrate={license.activations}>` is
  correctly wired, no console/window errors during a clean single-activation
  cycle).
- **Light/dark**: both render correctly; dark theme keeps the same gold/near-
  black coin on the dark card, no contrast or clipping problems.
- **Console**: no three.js/WebGL errors in any clean run (console.error/warn
  and window `error`/`unhandledrejection` hooked for the whole session).
- **Caveat, not a coin bug**: mid-session, a parallel lane's concurrent edits
  to `LicenseSettingsSection.svelte`/`licenseCopy.ts`/`languages/en.json` in
  this same worktree (visible in `git status` throughout — Phase 2/3 work in
  flight) triggered one Vite HMR crash (`SyntaxError: Importing binding name
  'licenseRowText' is not found`, `Failed to reload
  .../LicenseSettingsSection.svelte`), which briefly showed the raw
  i18n key `license.supporterSince` instead of interpolated copy. A clean dev
  restart showed correct "Licensed since Jan 15, 2026" copy — this was HMR
  fallout from a moving working tree, not a product bug, and is not a Gap.

Commands/checks: manual bridge session only (no automated test added — this
was a first-look sighting, not a regression check). Screenshots under
`test-screenshots/` (gitignored, not committed — paths above).

Phase 4 should know: the coin itself is solid and ready to build the card
around. The one open question this pass couldn't close cleanly is whether the
celebrate boost is visually distinct enough from idle spin in practice —
worth a deliberate single-observer check (no parallel QA contention) before
sign-off, since this pass only proved idle spin and the activation-state
transition, not the two composed together on screen.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
