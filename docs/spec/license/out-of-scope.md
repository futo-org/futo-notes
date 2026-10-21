## Out of scope

- The **server product** is independent: its own Polar product, its own key
  semantics, no shared entitlement with this license. The same customer e-mail
  may exist in Polar for both; nothing in the client relies on that.
- Per-region pricing, currencies, and tax are the storefront's business.

> **Gap:** License sync — the license is entered per device. Carrying it in the
> E2EE sync payload so one entry licenses every synced device is **deferred**
> (plan M6, decision D28 2026-10-16), not canceled. It touches the sync payload
> (AGENTS.md §11.6) and must be its own change. Until then a license reaches
> another device by entering the key the card reveals (or the deep link) on that
> device.

> **Gap:** The `platform` and `from` attribution the Buy URL carries is not
> recorded by the server. Checked against `~/Developer/lib-polar` 2026-10-15
> (read-only). On `main` and the deployed storefront, `checkout-ready` accepts
> only `success`: `platform` and `from` are both dropped, and the checkout
> page posts `metadata: null` to Polar. The unmerged branch
> `feat/futo-notes-v2-activation` forwards `platform` (whitelisted to
> `desktop|ios|android|web`, anything else dropped) into the Polar checkout as
> `metadata.platform`; no branch reads `from`. The `pay.futo.tech/futo-notes`
> product landing page redirects to `checkout-ready` carrying `platform` only,
> so `from` would be lost there too even after a lib-polar change. `from` is
> therefore sent but never recorded until lib-polar forwards a second
> attribution field (suggested: `metadata.from`, whitelisted
> `license-card|app-icon`, in both the landing redirect and `checkout-ready`).
> Nothing about the purchase depends on either; this closes when lib-polar
> deploys, with no client change.

> **Gap:** No in-Play purchase path — Play users must obtain a license outside the app. A Play Billing SKU or companion app (the FUTO
> Keyboard pattern) is deliberately not built.

> **Gap:** No in-app restore by e-mail — lost keys go to support@futo.tech; the
> newer futopay Android library's restore page is not adopted.

A **real purchase delivers a license key end to end**, verified 2026-09-15 on
the native Android app against `staging-pay2.futo.org`: system-browser checkout
with a real email domain, Stripe test card `4242 4242 4242 4242`, payment
succeeded, key delivered (`7QTY-X1FG-2CQ5-1KW1-5GWR-DVA7-976D-6UJV`), the
`futonotes://license/{key}/{activation}` link activated the app, and
`android-drive state` plus the Settings UI confirmed `LICENSED`. → screenshot
ledger in `test-screenshots/`

The same real-purchase path was independently re-verified on the native iOS
app 2026-09-15 against `staging-pay2.futo.org`, on commit `0e986457` (the
`success=redirect-to-organization-page` fix): Buy opened
`.../checkout-ready?platform=ios&success=redirect-to-organization-page`
(confirmed from the Safari address bar) and a real Stripe test-card purchase
(`justin+e2e-ios-<id>@futo.tech`) landed on
`https://staging-pay2.futo.org/checkout-success?license_key=...&state=granted`
— the HTML key page with an Activate button — not the raw
`/api/checkout-status/...` JSON a pre-fix build on this same worktree had
shown for the identical flow one run earlier. Tapping Activate fired the
`futonotes://license/{key}/{activation}` deep link, Safari's "Open in FUTO
Notes Dev?" prompt handed off to the app, and Settings showed a "License
activated" toast with the row reading `Licensed`; force-quitting and
relaunching confirmed the state persisted. → 49-shot ledger in
`test-screenshots/ios-retest-*.png`

> This closes a Gap open since 2026-09-10/11, when two server-side faults —
> neither a client bug — blocked every purchase: the Polar product initially
> carried no benefit (`_confirm_polar_checkout` requires exactly one benefit
> grant before `create_key_func` runs; a custom benefit was attached 2026-09-10),
> and Polar's sandbox then stopped creating benefit grants at all for **any**
> product (a control purchase on futo-music, previously reliable, also produced
> none). Polar webhooks to staging FUTOpay were also rejected 403 `Invalid
webhook signature` the whole time (`polar_sdk._webhooks.validate_event`
> base64-encodes the secret before HMAC; a Standard-Webhooks signature decodes it
> first), so the webhook fulfillment path was dead too. None of that reproduced on
> 2026-09-15's purchase — this is one verified success, not proof either fault is
> permanently fixed on Polar's side; re-verify if purchases start failing again.
>
> _A separate, resolved trap for anyone testing this by hand or by agent:_ Polar
> validates `customer_email` for deliverability before it will create a checkout
> at all, and rejects any `@example.com`/`@example.org`/`@test`/`@localhost`
> address (null-MX by design) or a domain with no DNS record, with a 422 that
> `create-checkout` flattens into the same 200-wrapped
> `{"status_code":502,"detail":"Polar rejected the checkout request"}` above —
> indistinguishable from the real server-side faults without checking the email.
> Confirmed 2026-09-15: 22/22 `@example.com` attempts failed, 15/15 real-domain
> attempts (`@gmail.com`, `@futo.org`, `@mailinator.com`) succeeded, interleaved
> from one IP within seconds — ruling out headers, cookies, and rate limiting.
> **Use `justin+<unique-id>@futo.tech` for test purchases**, never an
> `@example.*` address.

The **release gate for the License card** was re-run 2026-09-16 on one commit
across all three clients, each story observed on screen _and_ against storage
(the desktop app data dir, UserDefaults, `futo_prefs`). All three verdicts were
SHIP.

- _(desktop)_ Unlicensed card, the checkout URL, all four input shapes, a v1
  license, mask/reveal/copy, Remove, Full reset, and dark/light plus a narrow
  pane. The bare-key-offline case was driven by relaunching the dev process
  under a scoped `HTTPS_PROXY=http://127.0.0.1:1` — the offline toast appeared
  and no `license.json` was written. Copy was read back with `pbpaste` from
  outside the app, which is the only way: the app deliberately holds no
  clipboard-read permission.
- _(ios)_ A **fresh real staging purchase on this commit** — Stripe test card,
  `justin+…@futo.tech`, key `D58B-…-3684` minted, the HTML key page, Activate
  firing the deep link, and the pair landing in UserDefaults. The Buy URL was
  read verbatim from Safari's address bar. The simulator happened to still hold
  a **v1** license at launch, giving a live D2 reading: "Licensed since" present
  and blank, Term "Perpetual".
- _(android)_ A second independent real staging purchase (key `2FFB-…-89J5`),
  plus the one thing no other platform can do — **Expired rendered from a real
  stored license**, by moving the emulator clock past the fixture's 2029 expiry
  (`auto_time 0`, `adb root`, relaunch). The card showed the EXPIRED badge, an
  empty well, the masked key, "Licensed since Jan 15, 2026", "Term: Expired
  Jan 15, 2029" and **Renew** as the filled button. Restoring the clock
  re-evaluated the same stored pair back to Licensed, proving the clock move
  corrupted nothing. The `play` flavor's consumption-only shape was proven by
  flipping `LICENSE_LINK_OUT` locally and reverting it — both flavors still ship
  it `true` (D9).

> Three results were **not** obtained, and are recorded here rather than left to
> be rediscovered as failures. _(ios)_ the bare-key-**offline** case: a simulator
> proxies the host's network and has no Wi-Fi toggle, and host-level networking
> was deliberately left alone because two sibling legs were mid-purchase against
> the same host. _(desktop)_ the OS browser actually painting the Buy URL: the
> URL and the `openExternalUrl` code path were both proven, but confirming the
> browser tab would have needed UI scripting, which is forbidden (M24).
> _(desktop)_ Full reset's native confirm sheet is not reachable from the webview
> bridge, so the identical code path (`resetAllNotes()` → `deleteAllNotes()` →
> `clearLicense()`) was invoked instead.

> _Two false failures that were caught and refuted during that pass, recorded so
> the next one does not re-report them:_ _(ios)_ after Remove, `futo.license.
activation` lingers in UserDefaults for a few seconds after `futo.license.key`
> has gone — that is `NSUserDefaults` write coalescing, not a storage bug; both
> are clear on a re-read. _(android)_ `adb shell input text` silently truncates
> at roughly 250 characters, so entering the 584-character v2 fixture by hand
> needs chunking — an untruncated single call produces an activation failure
> that looks exactly like a rejected key.

> **Gap:** No revocation check — refunded or revoked keys stay valid on
> activated devices because the license module makes no background requests.
> An opportunistic re-check on explicit user action only would be the
> compatible way to add one.

> **Closed 2026-09-22:** the **production** org public key is real.
> `PRODUCTION_PUBLIC_KEY_BASE64` is the key
> `GET pay2.futo.org/checkout/polar/futo-notes/activation/public-key` serves (DER
> SPKI SHA-256 `2034d795…aa68`, pinned by
> `the_production_key_is_the_real_production_org_key`); on that date the 1Password
> `prod-polar-orgs-futo-notes-pubk`/`-privk` pair matched it, unlike staging's. No
> production-signed activation is committed anywhere — a v1 activation is a working
> license. The production org and product exist too: `/info` and `/price` on
> `pay2.futo.org/checkout/polar/futo-notes/futo-notes-license/` answer with
> "FUTO Notes License", non-recurring. → `crates/futo-notes-license/src/config.rs`
>
> `FUTO_LICENSE_ENV=staging|production`, set on the build that compiles the
> license crate, forces either org regardless of bundle id (a `.dev` app can buy on
> production, a release bundle on staging); unset, the `.dev` split decides. It is
> a QA knob, never set by CI or a store build, and the FFI contract tests that pin
> the bundle-id split fail under it by design — run the test suites unflagged.
>
> `STAGING_PUBLIC_KEY_BASE64` is the key the staging deployment actually signs
> with (DER SPKI SHA-256 `fca4b6a4…29a23`, pinned by
> `the_staging_key_is_the_real_staging_org_key`), and the fixture license every
> dev build is driven with is signed by it. From 2026-09-10 to 2026-09-11 it was a
> _different_ real key (`ca4a8698…31514`, the 1Password
> `staging-polar-orgs-futo-notes-privk` pair), which **no deployment has ever
> held**. FUTOpay generates an org's pair itself in `initialize_organizations` when
> the org row is first inserted and never replaces it, and no branch of lib-polar
> reads `manifest-inventory`'s `POLAR__ORGS__FUTO_NOTES__PRIVATE_KEY` outside its
> test suite (lib-polar issue #1). **The authority for either environment's key is
> therefore the live endpoint** — which is what FUTO Music bakes for both of its
> environments too. Re-mint the staging-signed fixtures whenever it moves.

> **Closed 2026-09-24:** a production purchase delivers a key end to end. Driven on
> the iOS simulator with a fresh Release install (`com.futo.notes`, no
> `FUTO_LICENSE_ENV`): Buy → `pay2.futo.org` checkout in Safari → Polar, coupon
> `TESTINPROD` ($14.99 → $0) → "Get for free" → FUTOpay's key page after ~20 s of
> "Waiting confirmation" → ACTIVATE → "Open in FUTO Notes" → the card reads
> Licensed ("License activated" toast), and still does after a force-quit and
> relaunch. On 2026-09-22 the same flow ended on raw JSON (`Too many benefit grant
> check attempts`) because the production Polar benefit was `visibility: private`,
> which Polar omits from a checkout's `product.benefits` and lib-polar's
> `checkout_session_check` then refuses. A 200 from `checkout-ready` or a
> `succeeded` Polar checkout still proves nothing about delivery; only the key page
> does.
>
> FUTOpay's key page itself is not laid out for a phone: on a 402 pt viewport it
> scrolls sideways, clips the key and the instruction text at the right edge, and
> shows a blank logo box and a broken-image `?`. The key and ACTIVATE still work.
> That page belongs to FUTOpay, not this client.

> **Gap:** _(ios, android)_ The card has a fourth, unspecified state: _not yet
> known_. The spec gives it three, while desktop initializes to Unlicensed before
> its asynchronous read lands. On both native shells a preference read and an RSA
> verify are work M1 keeps off the thread that paints the shell, so the card
> renders its frame with no status until the answer lands — _(android)_ the well
> carries no accessibility label at all in that window, because neither "No
> license" nor the coin's label would yet be true. The window is one
> background hop during startup and closes long before Settings can normally be
> opened; it is recorded rather than blessed, and the line to reconcile is
> whether the spec should name a loading state for all three clients. → iOS and
> Android `LicenseModel.view` (nullable until `load()`),
> `LicenseSettingsSection.swift`, `LicenseSettingsSection.kt`

> **Gap:** _(desktop, ios, android)_ The spec names the key field but none of the
> controls around it, so each shell supplies them: an **Activate** button (the
> keyboard's Done/Return also submits), a **Cancel** that closes the field, and a
> placeholder naming the three accepted shapes. A text field with no submit is
> not operable, so these are additions rather than choices — but they are
> unspecified copy, and this is the line to reconcile if the spec later names
> them. All three shells use the same four catalog entries
> (`license.keyLabel`, `keyPlaceholder`, `activate`, `cancelEntry`), so the
> addition is at least identical on all of them.

> **Gap:** _(desktop, macOS)_ The `futonotes` scheme is declared once in
> `tauri.conf.json`, but only Linux and Windows re-register it at runtime
> (`register_all`). macOS learns the scheme from the bundle's generated
> `CFBundleURLTypes`, which an unbundled `cargo tauri dev` binary never gets, so
> the OS → app hop is unverified there: QA drove the plugin's own
> `deep-link://new-url` event, which exercises everything from `on_open_url`
> inward but not LaunchServices. The #160 gate added the second half of the
> reason, read from the dependency rather than inferred: the single-instance
> argv route cannot cover macOS either, because
> `tauri-plugin-deep-link`'s `handle_cli_arguments` wraps its whole body in
> `if cfg!(windows) || cfg!(target_os = "linux")` — it is a **no-op** on macOS,
> so `license::handle_single_instance_arguments` can never fire there. Two
> second-launch attempts with the link as argv exited 0 through the
> single-instance socket and changed nothing, which is the specified outcome of
> a no-op and not a bug in this repo's code. Proving it needs a signed bundle from
> `just tauri-build`, and a production bundle verifies against the production
> key — so a staging license cannot demo it end to end until the **production**
> key lands (see the production-key gap above).
