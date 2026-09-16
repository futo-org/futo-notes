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

### Phase 2 — copy and view-model — DONE 2026-09-16

The one-line `licenseRowText` is gone from all three shells; each now builds the
same five-field card model. Catalog, three view-models, three test locks and the
drift entry moved in one commit (M7, M17).

**Catalog as shipped** (`languages/en.json`, `messages.license`). Removed:
`licensed`, `licensedPerpetual`, `licensedUndated`, `expired`, `supporterSince`.
Changed: `explanationLicensed` → "Thank you for paying for FUTO Notes." Added:
`statusLicensed` "Licensed", `statusExpired` "Expired", `licensedSince`
"Licensed since {date}", and the `license.card.*` group exactly as §2 lists it
(`eyebrow`, `productName`, `keyLabel`, `sinceLabel`, `termLabel`,
`termPerpetual`, `termValidUntil`, `termExpired`, `revealKey`, `copyKey`,
`keyCopied`, `emptyWell`). `zh-Hans.json` has no `license` group at all, so
nothing to remove there. `pnpm run check:languages` validates catalogs only — it
never looks at call sites, so an entry Phases 4/5 have not wired up yet is fine.

**The model, per platform** (same five fields, same rules, platform-idiomatic
types):

| | desktop | iOS | Android |
|---|---|---|---|
| type | `interface LicenseCardModel` | `struct LicenseCardModel: Equatable` | `data class LicenseCardModel` |
| entry point | `licenseCardModel(view)` | `licenseCardModel(_ view:_ localization:)` | `licenseCardModel(view, localization)` |
| `status` | `LicenseStateName` | `LicenseStatus` | `LicenseStatus` |
| `badge` | `string \| null` | `String?` | `String?` |
| `since` | `string \| null` | `String?` | `String?` |
| `term` | `string` | `String` | `String` |
| `maskedKey` | `string \| null` | `String?` | `String?` |

`licenseAmbientLabel` stays desktop-only (the footer) and now reads
`license.licensedSince` with `localizedAbsoluteDate(issuedAt)` — full date, D3.
The native shells have no ambient label and gained none.

**Decisions the plan left open, taken here:**

- **`term` for Unlicensed is the empty string.** §3 types it non-null and lists
  only three licensed-ish values; an unlicensed device has no term, and
  "Perpetual" there would be a claim. The row renders blank exactly as the
  `since` row does under D2. Locked by a test on all three platforms.
- **The Expired-without-dates guard returns the *whole* Unlicensed card**
  (badge "Unlicensed", `since` null, `term` "", `maskedKey` null), not a
  half-built expired one. Identical on all three platforms and asserted by
  equality against the unlicensed model on iOS/Android.
- **The mask is built in code, not from a catalog entry**: it formats user data
  (the key), like a date. `7 × "····"` (four U+00B7 MIDDLE DOT) joined with
  single spaces, then `key.slice(-4)` / `key.suffix(4)` / `key.takeLast(4)` —
  `···· ···· ···· ···· ···· ···· ···· 6UJV`. Constants are private to each copy
  (`MASK_GROUP` / `licenseMaskGroup`, `MASKED_GROUPS` = 7,
  `LAST_GROUP_LENGTH` = 4). It never re-groups or re-cases the key: Phase 3
  guarantees it arrives normalized and `null`-never-`""`.

**Call sites touched that the plan did not predict** — all minimal,
keep-it-building edits, no restyling; Phases 4 and 5 own the real card:

- `src/features/license/LicenseSettingsSection.svelte` — imports
  `licenseCardModel` instead of `licenseRowText`; the status line renders
  `licenseCardModel(license.view).badge ?? localizedText('license.statusLicensed')`.
- `apps/ios/Sources/License/LicenseSettingsSection.swift` — same substitution,
  `accessibilityIdentifier("license-status")` unchanged.
- `apps/android/.../ui/LicenseSettingsSection.kt` — same substitution inside the
  existing `SettingsRow`.
- `src/lib/platform/license.ts`, `src/shared/localization/localization.ts` +
  `.test.ts`, `apps/ios/Sources/Localization/Localization.swift`,
  `apps/android/.../localization/Localization.kt` +
  `AndroidLocalizationRules.kt` — doc comments that cited "Supporter since
  {year}" (M17). **`localizedYear` now has no production caller on any
  platform**; it was left in place (it is a three-platform API with its own
  localization tests) and its comments no longer cite removed copy. Removing it
  is a separate decision for Phase 6 if anyone wants it.
- The four TS and five Kotlin/Swift `LicenseView` construction sites Phase 3
  flagged all carry `key` now: `licenseCopy.test.ts` (rewritten),
  `license.svelte.test.ts` (2 literals + the `UNLICENSED` mock),
  `LicenseCopyTests.swift`, `LicenseCopyTest.kt`.

**Drift registry**: `license-row-copy` → `license-card-copy`; description, the
three `copies[].pattern`s and the `scan.pattern` all point at
`licenseCardModel`; `lockStatus: partial` and the same three locks kept, with
the note rewritten to say what is and is not pinned (the five-field model and
the identical guard/mask are; byte-identical output is not, because the three
date formatters legitimately differ).

**Commands and results:**

```
pnpm run check:languages       → Validated 2 language catalogs. (exit 0)
just test-one src/features/license → 2 files, 32 tests passed (exit 0)
just check-drift               → OK — 17 concepts (7 locked, 5 partial, 5 unlocked) (exit 0)
just test-ios-native           → ** TEST SUCCEEDED ** — 166 tests in 29 suites,
                                 incl. all 7 "License copy" cases (exit 0)
just test-android-native-ui    → 43 tests, 1 failure (exit 1) — see below
just test-android-native       → BUILD SUCCESSFUL, both flavors (exit 0)
pnpm run lint                  → 0 errors, 4 pre-existing warnings (exit 0)
pnpm run format:check          → all files formatted (exit 0)
pnpm exec tsc --noEmit         → exit 0
pnpm run check:svelte          → 0 errors, 0 warnings (exit 0)
xcrun swift-format lint --strict (the three changed Swift files) → exit 0
```

**The one Android red is NOT this work.** `just test-android-native-ui` fails on
`com.futo.notes.ui.components.DialogImeDismissTest >
dialogFieldKeepsFocusAndKeyboardWhileImeShows`: "activity window never saw the
ime insets". All seven `LicenseCopyTest` cases pass in the same run. That
assertion is gated `if (Build.VERSION.SDK_INT >= 35)` and the pooled AVD
`just qa-claim android` hands out here is **API 36 / Android 16**, while the
test was written against CI's API 34 AVD where the branch is skipped — so on
this host the app really does not receive activity-window ime insets while a
dialog field owns the keyboard, which is either an Android 16 behavior change or
a genuine gap in the github#23 fix. It is a Compose-only test that constructs
its own `Dialog` + `OutlinedTextField` and never touches license code. A clean
control run was **impossible**: at `HEAD~1` the androidTest sources do not
compile at all, because Phase 3 deliberately left `LicenseCopyTest.kt`'s five
`LicenseView(...)` calls missing the new `key` argument — so there was no green
baseline on this branch to regress from. **Phase 5 and Phase 7 will hit this on
every API-36 pool device; it needs its own diagnosis and is not a license bug.**

**What Phases 4–6 must know:**

- `licenseRowText` no longer exists anywhere. Render from `licenseCardModel`;
  the three status-line call sites above are placeholders showing only `badge`
  and are meant to be replaced wholesale by the plate.
- The Licensed state has **no badge** (`badge == null`) — the coin in the well
  is the statement. A shell that wants the word "Licensed" reads
  `license.statusLicensed`.
- `since` is `null` for every v1 activation (D2). Render the row and leave the
  value empty; never substitute.
- Catalog entries added but **not yet used by any shell**:
  `license.card.eyebrow`, `productName`, `keyLabel`, `sinceLabel`, `termLabel`,
  `revealKey`, `copyKey`, `keyCopied`, `emptyWell`. Phases 4/5 wire them up.
- **Left deliberately untouched, still saying "Supporter since"** (each is
  another phase's file, per this phase's brief): `docs/spec/license.md`,
  `docs/spec/localization.md:238`, `docs/release/store-submission.md:17`,
  `crates/futo-notes-license/AGENTS.md:7`,
  `apps/tauri/src-tauri/src/license.rs` (4 doc comments),
  `src/features/license/SidebarLicenseFooter.svelte` (2 comments, lines 23 and
  74 — Phase 4 owns that file). `docs/spec/list.md`'s footer line WAS corrected
  here, to "Unlicensed" or "Licensed since {date}" and without the stale
  "beside the app version". Phase 6 should re-run
  `rg -n "Supporter since|licensedPerpetual|licensedUndated|supporterSince" .`
  and expect only its own historical verification paragraphs to remain.

### Side finding — the Android IME test red is not ours — 2026-09-16

`just test-android-native-ui` fails on `com.futo.notes.ui.components.DialogImeDismissTest >
dialogFieldKeepsFocusAndKeyboardWhileImeShows` ("activity window never saw the ime insets") often
enough that Phases 5 and 7 will both meet it. **Verdict: pre-existing, environmental, not a
regression — do not chase it, and do not weaken it to get green.**

Evidence: a clean control was built from `origin/main` (`24348b91`) in a throwaway worktree and the
class run 4× there and 4× on `feat/license`, on two different pooled API 36 devices — **8/8 passes**,
read from the JUnit XML rather than console scrollback. `DialogImeDismissTest.kt` and `ImeDismiss.kt`
are byte-identical between the two branches, and the test is a pure `createComposeRule()` test with
its own `Dialog` that never launches `MainActivity`, so nothing in the license work can reach it.

Two corrections to the first read of it:

- The `Build.VERSION.SDK_INT >= 35` branch is **not** dead code that CI never exercised. It was added
  deliberately (`c4db93a6` / `6a6f5ab2`) and verified green on API 35 **and** API 36 at the time.
- So this is not an API-level gap in the device pool, and there is no evidence Android 16 changed
  inset behavior.

Root cause is a fixed `Thread.sleep(1500)` budget in the test — chosen over the Compose test clock
because "the phantom hide fired as the IME's show animation settled". Under heavy parallel load on
this machine (many worktrees, emulators and builds at once) the IME is confirmed shown via `dumpsys`
while the activity window's inset visibility has not flipped yet when the assertion runs, which is
exactly the observed failure. The fix is to replace the fixed sleep with a bounded `waitUntil` poll
on `activityImeVisible`, mirroring the existing `imeShownInSystem()` poll. Filed as papercut
`pc_46cde2151a61` (tag `android`) — tooling friction, **not** a product bug or spec gap, because the
app's own behavior was never shown to be broken.

### Phase 4 — desktop plate — DONE 2026-09-16

The Steel Ledger plate replaces the status row in Settings → License. Two
commits: `feat(license): build the Steel Ledger plate on desktop` (e48650fb) and
`fix(license): stop the plate's key row collapsing into a 96px-tall label`
(daa0c5c7), the second found by looking at the real app rather than at a test.

**What shipped** (`src/features/license/LicenseSettingsSection.svelte`). The
structure is §5 Phase 4's, with one deviation noted below: `.license-plate`
(gradient, 12px radius, 22px/24px padding, wrapping flex row, gap 24px) →
`.license-well` (184px, inset shadow, no ring) + `.license-fields` (badge,
eyebrow, `FUTO NOTES`, `dl.license-rows`, the one filled Buy/Renew slab, the
existing key-entry field, the explanation, the links). Palette exactly as the
plan's table, as component-scoped custom properties redefined under
`:global([data-theme='dark']) .license-plate`, plus one token the table did not
list: `--plate-well` (`#c6ced6` / `#161b20`), so the recess reads as a hole
rather than only as a shadow. **Nothing on the plate transitions a
theme-dependent property**; the only `transition` is `transform` on the button
press.

`SidebarLicenseFooter.svelte` needed no logic change — `licenseAmbientLabel`
already said "Licensed since {date}" from Phase 2 — only its two comments that
still cited the removed "Supporter since {year}" copy.

**Deviations from §5 Phase 4, both deliberate:**

- **The Key row is stacked (label above value), not a two-column row.** Beside a
  184px well the fields column is ~304px and the label column 96px, leaving
  ~196px for a 39-character mask. Letting the row wrap "when it has to" was the
  first attempt and it overflowed the plate by 20px at the wrap boundary and
  32px at 300px of plate. Stacking that one row is unconditional and cannot
  overflow. The other two rows are the plain label/value pair the plan drew.
- **No `letter-spacing` on the key.** 0.04em put the mask at 308px in a 304px
  column — two lines for four pixels.

**Rules the plan set, and where each is enforced:** reveal is component-local
`$state` and resets on unmount (observed: closing and reopening Settings
re-masks); Copy goes through `getPlatformFS().writeClipboardText` (the
platform-discipline gate would reject the plugin import) and toasts
`license.card.keyCopied`; the filled Buy/Renew slab keeps `--color-primary` and
is the only filled button in every state (asserted in the spec); the gold accent
is the rules, the badge border and the in-plate links only; every string is an
existing §2 catalog entry read through `localizedText` — **no catalog entry was
added or changed in this phase**.

**Tests.** `license.svelte.test.ts` was not touched: no model behavior changed,
and Phase 2 had already added `key` to both of its `LicenseView` literals. New
`tests/license-card.spec.ts`, 5 cases: unlicensed / licensed v2 / licensed v1 /
expired / reveal+Copy. It mocks the platform license module by **fulfilling the
dev server's request for `/src/lib/platform/license.ts`** with a stand-in
module (`page.route('**/src/lib/platform/license.ts*')`) — there was no existing
Playwright mocking precedent in `tests/`, and this needs no product-code test
hook. The mock is proven effective by the licensed/expired cases, which the real
module (which answers Unlicensed for everything off Tauri) could never produce.
No CI change: `test:e2e:rest` is a `--grep-invert` over all specs, so the file
joins it automatically and `release:gate.needs` is untouched (M14).

**Verification, all from the worktree, exit status checked directly (M11):**

```
just build                                        → exit 0
just test-one src/features/license                → 2 files, 32 tests passed (exit 0)
pnpm run test:e2e:smoke                           → 2 passed (exit 0)
pnpm exec playwright test tests/license-card.spec.ts → 5 passed (exit 0)
just check-theme-single-pace                      → OK (exit 0)
just check-platform-discipline                    → OK — 10 allowlisted, 0 unsanctioned (exit 0)
pnpm run check:languages                          → Validated 2 language catalogs (exit 0)
pnpm run check:svelte                             → 0 errors, 0 warnings
pnpm run lint                                     → 0 errors, 4 pre-existing warnings
pnpm run format:check                             → exit 0
```

**Seen for real.** Driven on this worktree's dev Tauri build
(`com.futo.notes.verify.s21.dev`, `FUTO_NOTES_DATA_DIR=.tauri-data`) through the
MCP bridge's raw WebSocket on the port `scripts/qa-target.mjs port 9244`
verified as this worktree's own debug binary. No OS-level input at any point
(M24). Screenshots in `test-screenshots/` (gitignored, not committed):
`plate-{licensed,unlicensed,expired}-{light,dark}.png`,
`plate-licensed-revealed-light.png`, `plate-narrow-licensed-light.png`.

- **Licensed** (real staging fixture, entered as `key/activation` through the
  live model — verifies offline against `STAGING_PUBLIC_KEY_BASE64`): no badge,
  the coin turning in the well at a measured **160×160 inside 184×184**, WebGL2
  context live, `Key ···· … RS78`, `Licensed since Jan 15, 2026`,
  `Term Valid until Jan 15, 2029`, "Thank you for paying for FUTO Notes.",
  Remove license as the only link, **zero** filled buttons, footer
  "Licensed since Jan 15, 2026".
- **Unlicensed** (reached by clicking the real Remove): gold `UNLICENSED` badge,
  empty well labelled "No license", all three rows present and blank, one filled
  "Buy a license", Enter license key + Lost your key?, footer "Unlicensed".
- **Expired**: `EXPIRED` badge, `Licensed since Jan 2, 2024`,
  `Term Expired Jan 2, 2025`, filled "Renew", no Remove, footer "Unlicensed".
  **This state was reached by setting `license.view` on the live model, not by a
  real activation** — no staging-signed activation with a past expiry exists and
  the private key is not in this repo. Rust's expiry verdict has its own tests;
  only the rendering was observed here. Phase 7 cannot do better on desktop
  either.
- **Reveal and Copy**: the masked button (accessible name "Show key") reveals the
  full key and swaps in "Copy key"; clicking it toasted "License key copied" and
  the exact normalized key `FN-AB12-…-RS78` (42 chars) was on the system
  pasteboard afterwards. The app cannot read the clipboard back
  (`clipboard-manager:allow-read-text` is deliberately not granted), so the
  read-back was done outside the app. **Side effect worth knowing: this
  overwrites the machine's clipboard.**
- **Narrow**: the window cannot be resized from the webview
  (`core:window:allow-set-size` is not granted and was not added for QA), and the
  plate has no viewport media query — it reacts only to the width its parent
  gives it, so the Settings panel's `max-width` was constrained instead, which is
  the same input a narrow window supplies. Swept 600→320: **no horizontal
  overflow of the plate or the document at any width**; the well stacks above the
  fields from ~510px of plate down; the mask is one line everywhere except the
  ~520px band and below 340px, where it wraps cleanly.

**Celebrate spin — PROVEN, contention-free.** What Phase 1.4 could not close is
closed. The window was raised by launching a second copy of this worktree's own
debug binary (single-instance focus) and kept raised for the run; a per-`rAF`
sampler drew the coin canvas into a 48×48 scratch 2D canvas and summed the
per-frame pixel delta, with `document.visibilityState` recorded on every sample.
Activation was the real path (`license.enterKey(key/activation)` on the live
model → `ok: true`, state `licensed`, `activations` 0→1, 15ms in).

```
frames sampled 354   visible on 355/355 samples   canvas up at t+67ms
mean per-frame delta   0–500ms   67485
                     500–1000ms   35421
                       1–2s       13721
                       3–4s        7589   ← resting
```

An **8.9× decay** from the opening half-second to the resting band, which is
what `CELEBRATION_SPIN = 16` bleeding off at `SPIN_DECAY = 2.6` toward
`BASE_SPIN = 1.25` predicts. No sample was taken while the window was hidden, so
the Phase 1.4 occlusion confound does not apply. **There is no Gap here and none
should be recorded.**

**What Phase 5 should copy or avoid:**

- Copy the row model: label above value for the key, label beside value for the
  other two. Both native shells have the same 184px-well-versus-text squeeze.
- Copy "every row is present in every state, blank when there is no value". It
  is what makes Unlicensed and a v1 license look deliberate rather than broken.
- Avoid a stacked row that inherits a cross-axis basis — the SwiftUI/Compose
  equivalent of the `flex-basis` trap is a fixed label *width* that becomes a
  fixed *height* when the stack turns vertical.
- The masked key is 39 characters. Size the field for it, do not truncate it.

**What Phase 6 must write into the spec** (this phase saw it on screen):

- The Licensed state shows **no badge** on desktop; the coin in the well is the
  statement. Unlicensed and Expired wear the badge.
- The desktop card shows the stored key masked to its last group, reveals it on
  click, and offers Copy. Reveal is local UI with no rule and no persistence:
  leaving Settings re-masks (verified).
- The ambient footer reads "Licensed since Jan 15, 2026" when licensed with a
  date, "Unlicensed" when unlicensed **or expired**, and nothing at all for a v1
  license.
- "only desktop turns" is accurate and now measured: the coin idles at ~1.25
  rad/s and spins up ~13× on the activation that crosses into licensed, decaying
  back within ~2s.
- The Expired state remains **unobservable from a real activation** on every
  platform until FUTOpay mints an expiring product; say so if the spec's Expired
  lines are ever read as verified-on-device.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

### Phase 5 (Android) — native plate — DONE 2026-09-16

The Compose shell now draws the Steel Ledger plate. Two commits:
`feat(license): build the Steel Ledger plate on Android` (b5af9a4b) and
`fix(license): make the Android plate's well and ledger read on a phone`
(6e4bbac7) — the second is everything the emulator showed that no compile
could, and is the reason this block is worth reading.

**What replaced what.** `apps/android/.../ui/LicenseSettingsSection.kt` no
longer calls `SettingsGroup`. The section keeps the same `MicroLabel`
("LICENSE") every other Settings group has, and under it is one `Column`
clipped to `RoundedCornerShape(FutoRadius.md)` with a
`Brush.verticalGradient` of the two plate tones. It is still the FIRST thing
in `SettingsScreen`. Inside: the well, then the badge (null when Licensed),
the gold eyebrow, the uppercase product name, three ledger rows, the one
filled Buy/Renew button, the explanation paragraph, and the remaining
actions as gold text links. `license.actions()` still decides which controls
exist; `BuildConfig.LICENSE_LINK_OUT` is untouched (`true` on both flavors).

**Tokens.** `ui/theme/Color.kt` gained the six `plate*` fields on
`FutoColors` (light defaults + `darkFutoColors` overrides, values exactly as
the §5 Phase 4 table lists them) fed by a `FutoPalette` `Plate*Light/Dark`
block, plus a separate `FutoPlateWell` object holding the two shadow
colours. Those two are deliberately NOT in `FutoColors`: the depression is
geometry, not colour, and the CSS is likewise one declaration for both
themes, so there is nothing for a dark variant to override. `Type.kt` gained
`plateName` (Barlow 700, uppercased at the call site, `0.02.em` — the only
positive tracking in the ramp) and `plateKey` (`FontFamily.Monospace`,
11.sp). **`Shape.kt` was not touched**: `FutoRadius.md` is the plate and
`.pill` is the badge, and adding a token just to have touched the file would
have been noise.

**How the well and its inset shadow were approximated.** Compose has no
`box-shadow: inset`. The well is a `Box` of 184dp, `Modifier.clip(CircleShape)`
with **no fill and no ring** — the plate's own gradient shows through, which
is what the CSS does too — and a `drawBehind` that paints three passes:

1. `Brush.radialGradient(0.90f to Transparent, 1.0f to Shadow, radius = r)` —
   the blur, hugging the rim.
2. `Brush.verticalGradient(0.0f to Shadow, 0.06f to Transparent)` — the 2px
   downward offset, a short cast under the top edge only.
3. `Brush.verticalGradient(0.99f to Transparent, 1.0f to Highlight)` — the
   `inset 0 -1px 0` hairline of light along the bottom inside edge.

The plan suggested "two overlapping circles with alpha"; gradients are
strictly better and needed no extra fill token. **The numbers matter far
more than the technique.** The first version used `0.70f` and `0.30f`, which
are perfectly reasonable-looking constants and produced a thick grey band —
i.e. exactly the ring D1 forbids, and an empty state that read as a sphere.
A 6px blur on a 184px circle reaches about a twelfth of the radius; anything
wider stops reading as a depression. iOS should sanity-check its own inner
shadow against a screenshot for the same reason.

**The ledger rows had to stop being two columns.** Desktop's `dl` puts the
label beside the value. On a 360dp phone that leaves under 180dp for the
value, and the 39-character masked key wrapped mid-group across two lines
(with a stranded `78` for the revealed 42-character key) — it looked like a
rendering fault. Rows now **stack**: micro uppercase label, value beneath,
both at the plate's full width. That also survives whatever a translation
does to a label, and it keeps all three rows the same shape. With
`plateKey` at 11sp, both the mask and the full key fit one line at default
font scale; at large accessibility font scales they wrap, which is the
correct degradation.

**Reveal and copy.** The masked value IS the control: a `TextButton` whose
`Modifier.semantics { contentDescription = … }` sets `license.card.revealKey`
as its accessible name (verified in the a11y tree: "Show key" and the dotted
value land on ONE node, so it is one stop, not two). Revealed, the full key
is a plain `Text` with a `Copy key` `TextButton` under it;
`LocalClipboardManager.setText` plus a new `LicenseModel.announceKeyCopied()`
that routes `license.card.keyCopied` through the model's existing `announce`
path, so the M11 "a message is never lost" guard still covers it. Reveal is
`remember(view?.key) { mutableStateOf(false) }` — it re-masks both when the
card leaves composition and when the stored key changes.

**Tests.** `LicenseSurfaceTest` gained
`theCardMasksTheStoredKeyAndRevealsItOnTap` (it needed `@RunWith(AndroidJUnit4::class)`,
a `createComposeRule` and its own prefs file). It was red-proved against
HEAD's stopgap section — `Action performScrollTo() failed`, because no
masked key existed — and is green against the plate. `LicenseLinkOutTest` is
unchanged and still runs under both flavors.

**Commands (each redirected to a file, `$?` checked — never piped, M11):**

```
just build-rust-android      → exit 0
just test-android-native     → exit 0 (BUILD SUCCESSFUL, direct + play)
just test-android-native-ui  → exit 0 — 44 tests, 0 failures, 0 skipped
just check-theme-single-pace → exit 0
```

`DialogImeDismissTest > dialogFieldKeepsFocusAndKeyboardWhileImeShows`, the
red Phase 2 warned about, **passed in every run here** (JUnit XML read
directly, all 31 License cases green in the same run). A separate lane has
since pinned it as environmental — a fixed `Thread.sleep(1500)` losing under
parallel load, 8/8 green on a clean `origin/main` control — so it is not a
license bug and not an API-36 behavior change.

**What the device actually showed** (pooled emulator `futo-qa-2`,
API 36 / Android 16, `com.futo.notes.dev`, staging fixture pair):

| State | Light | Dark |
|---|---|---|
| Unlicensed | empty well reading as a shallow depression; UNLICENSED pill outlined in gold; blank Key/Licensed since/Term rows; "Buy a license" the one filled (ember) button; Enter license key · Lost your key? as gold links | same, gunmetal plate, gold legible on it |
| Licensed | coin in the well, its diamond cut-out showing the plate through it; **no badge**; `···· … RS78`; "Jan 15, 2026"; "Valid until Jan 15, 2029"; "Thank you for paying for FUTO Notes."; Remove license | same |
| Expired | empty well; EXPIRED pill; masked key kept; "Jan 15, 2026"; "Expired Jan 15, 2029"; **Renew** as the filled button | same |

Also observed on device: tapping the masked key revealed
`FN-AB12-…-RS78` with Copy key beneath it; Copy fired the
"License key copied" toast **and** Android 13+'s own clipboard preview chip,
which showed the exact normalized key — a free independent oracle for
story 6 of Phase 7. Leaving Settings and returning re-masked it. Remove
returned the plate to Unlicensed with the key gone.

**Reaching Expired on a device, since no expired fixture exists.** The
staging activation expires 2029-01-15 and re-minting needs the staging
private key. So: `settings put global auto_time 0`, `adb root`,
`date 020112002030.00`, relaunch — the same stored pair evaluates Expired,
and restoring the clock puts it back to Licensed (which also proves nothing
was corrupted). Phase 7 should use this rather than reporting Expired as
unreachable. Restore `auto_time 1` and `adb unroot` afterwards.

**Both flavors, on the device.** `FUTO_ANDROID_FLAVOR=play just android-native`
renders identically to `direct`, which is correct: `LICENSE_LINK_OUT` is
`true` on both today (D9), so **the play build DOES show Buy** — the brief
for this phase assumed otherwise. To exercise the consumption-only shape I
flipped the `play` flavor's `buildConfigField` to `false` locally, built,
installed and observed: Buy a license and Lost your key? both gone, "Enter
license key" kept, and the `futonotes://` deep link still activated the
device to Licensed with the full card. The flag was then reverted with
`git checkout --` and the honest `direct` build reinstalled; nothing about
the flavors changed in git.

**For Phase 6 (spec), from the one who saw it run:**

- Android renders the plate in all three states with a **static** coin; the
  well is present and empty in Unlicensed and Expired. The coin Gap should
  narrow to "the coin animates only on desktop", not close.
- The card's rows on mobile are **stacked**, not two-column. If the spec
  describes the card's layout at all, it must say the label/value pairing is
  the behavior and the arrangement is per-platform.
- The well's accessibility label is `license.card.emptyWell` ("No license")
  when not Licensed and `license.coinAccessibilityLabel` when Licensed, and
  it is **absent** while `license.view` is null — there is nothing truthful
  to call the well before the stored pair has been read (M1), and "No
  license" would be a claim.
- The masked key and its "Show key" accessible name are ONE accessibility
  node, and the QA identifiers the iOS bullet lists (`license-key-masked`,
  `license-key-copy`) have no Android counterpart: Android is driven by
  label, and the labels are the catalog strings.
- Expired is only reachable on Android by moving the device clock (above).

**One trap worth recording.** Mid-session the debug app was uninstalled from
the emulator I had claimed, by something outside this lane — `pm list
packages` showed it, then a minute later `dumpsys package` said "Unable to
find package". A screenshot taken in that window showed a different app
entirely and would have been read as a broken plate (M21). Reinstalling and
re-verifying with `just android-drive state` was the only honest way
through. Relatedly, `just android-drive key back` did **not** leave Settings
while the on-screen Back arrow did, and trusting the first would have
produced a false "the reveal does not reset" finding — suspect the tool
before the app.

Screenshots (gitignored, not committed), under `test-screenshots/`:
`android-license-unlicensed-light-2.png`, `-unlicensed-dark.png`,
`-licensed-light.png`, `android-license-licensed-dark-2.png`,
`android-license-key-revealed-dark-2.png`,
`android-license-key-copied-toast.png`, `android-license-expired-light.png`,
`-expired-dark.png`, `android-license-play-unlicensed-dark.png`,
`android-license-play-linkout-false.png` and
`android-license-play-linkout-false-licensed.png`.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
