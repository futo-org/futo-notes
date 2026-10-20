## Entering a key

- One text field, labelled "License key". It accepts, after trimming
  whitespace, any of:
  1. a bare license key;
  2. `{key}/{activation}`;
  3. the full `futonotes://license/{key}/{activation}` URL.
     Recognition of the three shapes is one Rust function shared with the deep-link
     handler.
- Shapes 2 and 3 verify **fully offline** and never touch the network.
- **Paste and the deep link are the supported ways to put an activation in the
  field; hand-typing one is not.** _(ios)_ The system keyboard's smart-dash
  substitution turns the `--` inside a v2 activation into an en dash, and the
  app then correctly answers a corrupted signature with "This license key isn't
  valid". `.autocorrectionDisabled()` does not disable smart dashes and SwiftUI
  exposes no modifier that does. Both supported paths — a paste and the
  `futonotes://` link — activated the same pair on the simulator 2026-09-16, so
  this is a property of the input method rather than a gap in the surface.
- Shape 1 requires **one** request: `GET
{pay2}/api/v1/activate/{url-encoded key}` returns the v2 activation as plain
  text on 200, or 404 (`not found`, `not valid`, `revoked`). The app then
  verifies the pair exactly as for shape 2. Failures:
  - no connectivity / transport error → "Connect to the internet to activate
    this key" (the key is not stored);
  - 404 → "This license key isn't valid";
  - 200 but the pair fails verification → "This license key isn't valid".
    The request carries no identifiers beyond the key; there is no retry loop and
    no background re-attempt.
    The 200 branch was first seen from the real server on 2026-09-11, once a key
    existed to ask about (minted without a purchase through
    `/admin/createkey/futo-notes/futo-notes-license` — buying one still does not
    deliver a key, see the Gaps). _(ios)_ On a dev build, key field → the bare key
    alone → **Activate**: one `GET /api/v1/activate/{key}`, **200**, a **v1**
    activation, and the row flipped to the single word "Licensed" with **Remove
    license** as its only action; the stored activation is byte-for-byte the 342
    chars the endpoint returned, and Remove put the device back to Unlicensed with
    both preference keys gone. A server-minted key carries **no org prefix** — the
    `futo-notes` org's `prefix` column is empty — and is eight groups of four from
    the restricted alphabet, so the shipped grammar takes it unchanged.
- The key field is reachable only in the **Unlicensed** and **Expired** states:
  the Licensed card's only action is **Remove license**
  (`license_row_actions`), so there is no "Enter license key" while a license is
  stored. Replacing a license therefore happens through the **deep link**, which
  replaces without confirmation, or by removing the old one first — not by
  re-entering into the field. Verified on all three clients 2026-09-10 (#160);
  recorded because the absent field is easy to misread as a missing affordance.
  → `crates/futo-notes-ffi/src/license/contract.rs` `license_row_actions`
- On success the pair replaces any stored license, state flips to Licensed (or
  Expired, if the key is already past `expires_at` — still stored, with the
  Expired copy shown), and a toast confirms "License activated". Entry is
  atomic: verify-then-store happens in Rust as one call (§4.6). _(desktop)_ That
  call is `license_enter_key`; the shell hands over the raw text and receives the
  new state with its outcome, so it never sequences activate-then-verify and
  never re-reads the status afterwards. →
  `license::license_enter_key`, `src/lib/platform/license.ts`,
  `src/features/license/license.svelte.ts`
  _(ios)_ The same one call is `licenseEnterKey(input:bundleId:)`, async because
  the bare-key path makes the one request; the shell persists the returned pair
  and renders the returned state, and never asks again. →
  `crates/futo-notes-ffi/src/license/contract.rs`,
  `apps/ios/Sources/License/LicenseModel.swift`
  _(android)_ The same one call is `licenseEnterKey(input, bundleId)`, from a
  coroutine so the bare-key request never touches the main thread; the shell
  persists the returned pair and renders the returned state. →
  `apps/android/app/src/main/java/com/futo/notes/license/LicenseModel.kt`,
  `LicenseModelTest` "aPastedPairActivatesOffline", "aPastedLinkActivatesOffline",
  "anUnrecognisablePasteStoresNothing"
