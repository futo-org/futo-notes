# License — Spec

FUTO Notes asks the user to pay for it, and nothing in the app enforces that.
A user may **buy a license** for the client. Nothing that works is gated
behind it: a license includes only **purely cosmetic** choices (today the app
icon, see [What a license includes](license/what-a-license-includes.md#what-a-license-includes)), removes the
ambient **Unlicensed** label — leaving nothing in its place, because a paid license says nothing outside Settings — and turns the
License card into a plate carrying the FUTO coin in its well and the stored key,
masked.
Unpaid is a fully working app, but the product never calls itself "free to use"
— see § States and copy. This is the Grayjay / FUTO Keyboard / Immich model
("unregistered HyperCam 2"), sold through FUTOpay (Polar underneath). The server
product is a separate, later product with no shared semantics; see
[Out of scope](license/out-of-scope.md#out-of-scope).

Design decisions recorded 2026-09-09 (spec-first). All three clients implemented
the original full surface as of 2026-09-09, each driven on its own dev build against a
staging-signed fixture license: all three states, all three input shapes (the
bare key only as far as its 404 — see the Gaps), the deep link, Buy, Remove and
Full reset. _(android)_ Both distribution flavors were driven, and the
consumption-only shape was driven too, by building `play` with
`LICENSE_LINK_OUT=false`.

Re-verified end to end by the #156 release gate on 2026-09-09, all three clients
driven again on one commit rather than one per landing: desktop through the dev
build's webview bridge, iOS on a pooled simulator, Android on a pooled emulator
across both flavors. Every row state, every input shape, the OS deep link and its
two rejection paths, Remove, Renew and persistence were observed on screen and
checked against `languages/en.json` verbatim; storage claims were confirmed in
UserDefaults / `futo_prefs` / the desktop app data dir rather than from the UI
alone. Two things stayed unproven and are recorded in the Gaps below, not here:
the bare key's 200 branch (no key minted yet — #155) and, on macOS only, the
LaunchServices hop into an unbundled dev binary.

Re-run again by the #160 release gate on 2026-09-10, on the commit that merges
`origin/main` into the license branch — so the merged full-reset path (main's
writer-admission + throwing-reset rewrite) was exercised for real on every
client rather than reasoned about. Desktop through the dev build's webview
bridge, iOS on a pooled simulator, Android on a pooled emulator across **both**
flavors plus a fourth build made by flipping `LICENSE_LINK_OUT=false`, which
confirmed the Play-compliant consumption-only shape is one gradle line away and
still fully usable by key field and deep link. New this round: the v1 activation
end to end on all three clients (row reads the single word "Licensed", desktop's
ambient label removes its element rather than blanking it), Expired driven for
real on Android by moving the device clock against the v2 fixture, and the
cold-start deep link measured frame by frame instead of screenshotted. Two
purchases were carried through the real staging checkout; both succeeded at
Polar and neither produced a key — see the bare-key Gap, which now records the
cause. Still unproven, and recorded in the Gaps rather than here: the bare key's
200 branch, and the macOS LaunchServices hop.

2026-09-11 closed the bare key's 200 branch and re-pointed the staging key. The
baked `STAGING_PUBLIC_KEY_BASE64` had been the 1Password pair, which **no
deployment has ever held** — FUTOpay generates an org's key itself at org
creation and never reads the `POLAR__ORGS__*__PRIVATE_KEY` the manifest injects
(lib-polar issue #1) — so every license staging could mint would have verified
as Invalid. The constant is now the key staging actually signs with, proven by
re-signing a server-minted license key with the deployed private half and
reproducing the server's activation byte for byte, and every staging-signed
fixture was re-minted against it. A real staging-minted license was then driven
on iOS through both entry paths: the bare key over the network (200, "Licensed")
and the OS deep link, plus Remove back to Unlicensed. What still does not work is
**buying** one — see the purchase-delivery Gap.

2026-09-16 replaced the one-line License row with the **License card** on all
three clients (ship plan f0968f51, since removed), each driven on the commit that
shipped it. _(desktop)_ Unlicensed, Licensed and the reveal/copy path through
the dev build's webview bridge: the coin measured 160×160 inside the 184×184
well, Copy put the exact 42-character normalized key on the pasteboard, and
leaving Settings re-masked it. The celebrate spin is **measured**, not assumed —
354 sampled frames, the canvas visible on all 355 samples, mean per-frame pixel
delta decaying 8.9× from the opening half-second to rest, which is what
`CELEBRATION_SPIN` decaying toward `BASE_SPIN` predicts. _(ios)_ Unlicensed and
Licensed in both themes on a pooled simulator, the reveal (`xcrun simctl
pbpaste` returned that same normalized key, nothing else), and a v1 license
showing "Licensed since" present and blank with the term "Perpetual".
_(android)_ All three states × light and dark × both distribution flavors on a
pooled emulator, with Android's own clipboard chip showing the exact key after
Copy.

2026-09-18 brought the two native plates up to the desktop design — the eight
items the "native plates are two rounds behind desktop" Gap listed, closed
together. _(android)_ Driven on a pooled emulator across **both** distribution
flavors: Unlicensed as an ask with no card chrome and no well, Licensed with the
coin and Key as its whole ledger, and Expired reached for real by moving the
device clock to 2030 against the v2 staging fixture. The tap queue was measured
from 20 fps screenrecord frames: one tap keeps the coin turning fast for ~1.15 s,
eight taps for ~2.5 s, against a flat baseline. _(ios)_ Driven on a pooled
simulator through `LicensePlateTests`, because this Mac's Xcode 27 ships no
Simulator.app and a simulator with no window silently swallows every `axe` tap
while still answering `describe-ui` — XCUITest injects events into the app
process and is unaffected. All three plate states, the OS deep link, the reveal
(no Copy control) and Remove. The coin's color was checked against a build of
the preceding commit rather than eyeballed: with Reduce Motion holding it at one
angle, before and after are the same gold, and a dark-faced screenshot taken
mid-spin is the coin's own back.

A coin BURST — 120 little coins thrown across the plate on activation, ported
from FUTOpay's checkout page — shipped on all three clients that same day and
came straight back out (@justin 2026-09-18): seen running, it was clutter on a
card whose whole job is to be read. The coin in the well is the only thing a
purchase adds to the card itself; what else it includes is
[What a license includes](license/what-a-license-includes.md#what-a-license-includes).

**Expired was reached from a stored license only on Android**, by moving the
emulator clock forward against the v2 staging fixture. _(ios)_ It has never been
rendered on an iPhone: the only staging-signed fixture expires 2029 and a
simulator's clock cannot be moved (`xcrun simctl` has no time subcommand), so
the Expired card is covered there by `LicenseCopyTests` and the
`licenseRowActions` golden alone. _(desktop)_ Its Expired card was rendered from
an **injected** `license.view`, not from a real activation — no staging-signed
activation with a past expiry exists and the private key is not in this repo.
Rust's expiry verdict has its own tests either way; what is unproven is the two
shells' rendering of it. Minting one expired staging activation into the shared
fixture would close that on all three platforms at once.

- [Principles](license/principles.md)
- [What a license includes](license/what-a-license-includes.md)
- [The license](license/the-license.md)
- [Getting a license](license/getting-a-license.md)
- [Entering a key](license/entering-a-key.md)
- [Deep link](license/deep-link.md)
- [States and copy](license/states-and-copy.md)
- [Store posture (deliberate, recorded 2026-09-09, revised 2026-09-24)](license/store-posture.md)
- [Out of scope](license/out-of-scope.md)
