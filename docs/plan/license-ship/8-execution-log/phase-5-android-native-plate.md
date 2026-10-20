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
