# License purchase and storefront gate on iOS

## Why a person, not a test

The simulator tests lock the StoreKit country decision, rendered controls, browser handoff,
and activation deep link. A person with the signed TestFlight build must still confirm the
App Store storefront on a real device, the production checkout, and the return from Safari.

## Setup

- Use a TestFlight build containing the store-compliance change. Record its version and build
  number from TestFlight. A build from before this change cannot prove this story.
- For the TestFlight run, use a spare device with no important FUTO Notes data. TestFlight
  uses the production `com.futo.notes` app container; installing it over an existing copy
  may reuse that copy's notes and settings. The available US phone has important production
  app data, so do not install a candidate TestFlight build, remove its production license,
  or clear that app's data on this phone. Apply the same rule to the non-US tester.
- A Debug device build is a separate, preliminary route on the available US phone:
  `com.futo.notes.dev` has its own notes and keychain, and normal Debug builds use staging
  checkout. The phone already has FUTO Notes Dev 1.7.1 build 1; confirm its data may be
  updated before installing over it. A Debug run can prove the physical storefront and
  browser handoff, but it does not prove the TestFlight binary or production purchase.
- For the US run, use a US App Store storefront. For the non-US run, use an account whose
  App Store storefront is outside the US. Record the country; physical location alone does
  not establish the storefront that StoreKit reports.
- Use a unique test email for checkout. The plan specifies the production coupon
  `TESTINPROD`. Keep the resulting license key, activation link, email, and payment details
  out of screenshots and this document.

## The story

### Preliminary US Debug device check

With the Dev app's data cleared for updating, build and install using `just ios-native-device`
on the connected iPhone. Record the Dev build and the country the tester's App Store account
uses. Without a `-FUTOLicenseStorefront` launch argument, open **Settings → License** and
check that Buy appears for the US storefront. Tap Buy and confirm the default browser opens
staging checkout. Return to the Dev app without buying. Keep this result separate from the
TestFlight and production-purchase results below.

### US TestFlight device

1. Open **Settings → License** while unlicensed. Expect **Buy a license**, **I already paid**,
   and **Lost your key?**, with the ordinary purchase explanation.
2. Tap **Buy a license**. Expect the default browser to open the production checkout. Record
   whether this is Safari or another configured default browser; an in-app web view is a failure.
3. Complete one real production purchase using the test coupon. From the delivered key page,
   tap **ACTIVATE**. Expect FUTO Notes to return and show **Licensed** with the masked key.
4. Force quit and reopen FUTO Notes. Expect the license to remain **Licensed**. In the report,
   record only whether checkout, delivery, activation, and persistence passed. Do not record
   the key or activation URL.

### Non-US TestFlight device

1. Open **Settings → License** while unlicensed. Expect the key-only explanation, **I already
   paid**, and no **Buy a license**, **Renew**, **Lost your key?**, purchase headline, website,
   or payment prompt. Wait briefly and check again so a late storefront update is covered.
2. Enter a test license through **I already paid**. Expect **Licensed**. If a production
   key/activation pair is available, paste the pair to exercise offline verification without
   contacting the activation endpoint. Do not send the key in the QA report.
3. If a separate test activation link is available, open it from outside the app with FUTO
   Notes closed. Expect the app to open and show **Licensed**. This checks the cold-start
   deep link separately from the key field.

If a step differs, record the build number, storefront country, screen, and observed result.
Put any behavioral divergence in `docs/spec/license.md` as a `> **Gap:**` note.

## Last run — 2026-09-25, local simulator

On claimed simulator `futo-qa-5` (iOS 27.0), `just ios-native` built, installed, and launched
the Debug `com.futo.notes.dev` app with the default staging license environment. The
`LicensePlateTests` USA and FRA/unknown UI tests then passed (2 tests, 0 failures): USA
exposed Buy and opened Safari; FRA and unknown showed the key-only plate and accepted a
staging activation deep link. The automation session for AXe timed out even after a
simulator reboot, but `simctl` captured the rendered app and XCUITest completed the
license-screen interactions. No physical phone install occurred.

The previous 2026-09-24 Release UI test compared the unforced plate with
`Storefront.current` and passed. That simulator reported `USA` without a signed-in App Store
account, so its Release plate correctly showed Buy. Neither run was a TestFlight install.

### Not proven by this run

- The storefront reported by either physical TestFlight device.
- A purchase through this build's production browser checkout and return to the app.
- Activation and persistence with the production key on the non-US TestFlight build.
- The available US phone is not a TestFlight QA target because its production app data is
  important; no TestFlight install or production license change was made on it during this run.
- The preliminary physical Debug run was not attempted; the tester chose simulator QA.
