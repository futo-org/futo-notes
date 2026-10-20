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
