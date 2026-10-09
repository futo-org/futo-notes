# Store Submission Reference — Native iOS & Android

Console-ready answers for the App Store and Google Play submission forms, plus
the review-notes copy. This reflects FUTO Notes' actual data behavior:

- **No FUTO-hosted cloud.** Sync is **opt-in** and connects to a **server the
  user self-hosts** (futo-notes-server). The user enters the server URL; the
  app only _logs in_ (`/api/auth/password/login`) — there is **no in-app account
  creation**.
- **E2EE.** Note content is encrypted on-device (PBKDF2-HMAC-SHA256 +
  AES-256-GCM) before upload; the server stores opaque blobs.
- **The only data FUTO itself receives** is **optional crash diagnostics** sent
  to `notes-crashlog.futo.org` (default on, opt-out in Settings).
- Notes live locally in the app's Documents container. No ads, no analytics, no
  tracking, no third-party data-collection SDKs.
- **An optional paid client license** (docs/spec/license.md) gates **nothing**:
  it removes an "Unlicensed" label and shows a coin and the masked key on a card in Settings.
  iOS offers web checkout only for the US App Store storefront; Android `direct`
  offers it worldwide, while Android `play` accepts keys and deep links only.
  The only network call it can make is **one** activation request to
  `pay2.futo.org`, and only when the user explicitly enters a bare key.

> ⚠️ These answers rest on the self-hosted, no-FUTO-cloud model above. If FUTO
> ever ships a hosted sync service, revisit account-deletion (Apple 5.1.1(v) /
> Play account-deletion policy) and the data-collection declarations.

---

## Apple App Store

### App Privacy (App Store Connect → App Privacy)

**Data collected by the developer:**

| Data type                                                                      | Linked to identity | Used for tracking | Purpose           |
| ------------------------------------------------------------------------------ | ------------------ | ----------------- | ----------------- |
| Diagnostics → **Crash Data**                                                   | No                 | No                | App Functionality |
| Diagnostics → **Other Diagnostic Data** (device model, OS version, session id) | No                 | No                | App Functionality |

Everything else → **Data Not Collected**, because:

- Note content and login email/password are transmitted **only to the user's
  own self-hosted server**, end-to-end encrypted; FUTO neither receives nor
  stores them. They are not "collected by the developer."
- No identifiers, usage data, location, or contacts are gathered.
- **Purchases**: the license is bought on the web, so the app receives no
  purchase history, receipt, or customer identity. The one case where anything
  leaves the device is a user typing a bare license key: the app then sends
  that key — and nothing else, no device or user identifier — to
  `pay2.futo.org` to fetch its signed activation. Pasting a key/activation pair
  or opening a `futonotes://` link sends nothing at all; verification is a local
  signature check.
  > ⚠️ **Confirm before first submission:** decide with FUTO's compliance owner
  > whether that single key-for-activation exchange must be declared (Apple
  > "Purchases", Play "Financial info → Purchase history"). The argument for
  > **Data Not Collected** is that the key is user-supplied, unlinked to
  > identity, never stored server-side against a device, and sent only on an
  > explicit user action — but this is a judgment call, not a fact, and it is
  > the one declaration this feature changes.

Mirror this in `Resources/PrivacyInfo.xcprivacy` (already committed): crash +
other-diagnostic data, not linked, not tracking; required-reason APIs declared
(UserDefaults `CA92.1`, file-timestamp `C617.1`, disk-space `E174.1`).

### Export compliance

`ITSAppUsesNonExemptEncryption = NO` is set in `project.yml`. Basis: the app
uses only **standard** cryptography (AES-256-GCM, PBKDF2, TLS) and qualifies for
the exemption under category 5D992.c.

> ✅ **Confirm before first submission:** verify with FUTO's compliance owner
> that no annual self-classification report / ERN to the U.S. BIS is required
> for the E2EE feature. If one is, the answer stays "uses exemption" but you
> must file the report.

### App Review notes (paste into "Notes" for the reviewer)

```
FUTO Notes is an offline-first Markdown notes app. All features work fully
offline with no account.

Sync is OPTIONAL and end-to-end encrypted. There is NO FUTO-operated cloud
service: sync connects to a server the user hosts themselves (futo-notes-server,
open source). The app only logs in to a user-provided server URL — it does not
create accounts.

Because there is no developer-operated account service, account/data deletion is
handled by the user on their own server. In-app, Settings → Full reset erases
all local notes and disconnects sync.

To review sync (optional): we can provide a temporary test server URL +
credentials on request. Otherwise the app is fully functional offline without
signing in.

The FUTO Notes license unlocks no features or content; every function of the
app is available without it. The License card records that the user supports
FUTO. Outside the US App Store storefront, the app offers no purchase or link;
users may enter a key bought elsewhere. On the US storefront, "Buy a license"
opens the default browser to our website under guideline 3.1.1(a). The app
verifies a pasted key/activation pair offline. Entering a bare key makes one
HTTPS request to retrieve its signed activation.
```

The remaining iOS review risk is the key field outside the US under guideline
3.1.1. If Apple rejects it, ADR-0005 selects a non-consumable IAP at the same
price as the fallback; do not silently change the license behavior.

### Other listing requirements

- No buying, price, or website copy in any listing locale; listing text is not storefront-specific.
- Privacy policy URL (required) — see "Privacy policy" below.
- Screenshots per required device sizes; app icon already in the asset catalog
  (alpha removed).

### CI/CD submission (automated end to end)

A stable tag submits the build to App Store review with no console step:

- `publish:ios` uploads the IPA to TestFlight (`xcrun altool`, on the macOS
  Cirrus runner).
- `publish:ios:appstore` then runs `scripts/submit-appstore.mjs` **on Linux** —
  everything past the upload is the App Store Connect REST API, so it does not
  occupy the single macOS runner. It waits for Apple to finish processing the
  build (5-30 minutes is normal), creates the App Store version, attaches that
  exact build, writes "What's New" from `release-notes/<tag>.md`, and submits
  for review with `releaseType: AFTER_APPROVAL` — so an approved version goes
  live by itself.

It is safe to retry. Every step reuses what is already there: an existing
version row still in an editable state, an open review submission, the
localization Apple created with the version. A timeout is not a failed release —
the binary is already in TestFlight — and the job says so.

It **refuses** to touch a version that is already `IN_REVIEW`,
`READY_FOR_DISTRIBUTION`, or otherwise past preparation, rather than overwriting
a submission someone made by hand.

What it deliberately does not automate, because these change rarely and a script
that rewrites them every release is a way to ship a wrong listing: screenshots,
description, keywords, promotional text, age rating, pricing, and the App
Privacy answers above. Those stay console work, and the sections above are the
answers to give.

Beyond what `publish:ios` already needs, the ASC API key must have **App
Manager** access — the weaker TestFlight-upload role cannot create an App Store
version.

### Release notes

`release-notes/v<X.Y.Z>.md` is the single source for both stores' release notes;
`release-notes/README.md` owns the format. The file must exist **on the tagged
commit**, so write it in the release MR — committing it afterwards means
re-tagging. Check it before tagging:

```bash
just release-notes-check v1.7.2
```

---

## Google Play

### Data safety form

- **Does your app collect or share any of the required user data types?** → Yes
  (crash diagnostics only).
- **Data collected:**
  - **App activity / Diagnostics → Crash logs** — Collected, **not** shared,
    processed off-device (sent to `notes-crashlog.futo.org`). Optional
    (user can opt out in Settings). Not linked to a user identity.
  - **Diagnostics → Other** (device model, OS, session id) — same treatment.
- **Data NOT collected by the developer:** note content, email, files — these go
  only to the user's self-hosted server, E2EE; FUTO does not receive them.
- **Is all data encrypted in transit?** → Yes (HTTPS; note content additionally
  E2EE before upload).
- **Do you provide a way for users to request data deletion?** → Yes. Explain:
  in-app _Settings → Full reset_ deletes all local data; sync data lives on the
  user's own self-hosted server which the user controls/deletes directly. FUTO
  operates no account service. Crash diagnostics are anonymous and not tied to a
  user account.

### Paid client license (Play)

The `play` flavor accepts keys and deep links only. It has no checkout,
Buy/Renew, or Lost-your-key link and requires no External Content Links
enrollment. The `direct` flavor offers checkout in a Custom Tab.

- Do not describe the license as a donation, buying, pricing, or the website in
  any Play listing locale. Listing text is shown across storefronts.
- _(F-Droid, `direct` flavor)_ Offline verification adds no anti-feature, but
  the single activation request to pay2.futo.org may earn a
  **Tethered/NonFreeNet** label. Accepted.

### Account deletion policy

The app does **not** offer in-app account creation (sync is login-only to a
self-hosted server), so the in-app-delete / deletion-URL requirement does not
apply to a FUTO-operated account. Document the self-hosted model in the store
listing and the Data Safety form as above. If Play review pushes back, the
fallback is a public deletion-request page (see Privacy policy host).

### Other listing requirements

- Privacy policy URL (required).
- 512×512 app icon + 1024×500 feature graphic + phone screenshots (console
  uploads, not in the repo).
- Target API 35 ✓ (set in `build.gradle.kts`).
- Upload an **AAB** of the `play` flavor (`./gradlew :app:bundlePlayRelease`),
  not an APK. The `direct` flavor is the sideload/F-Droid APK and never goes to
  Play; both carry the same `applicationId` and signing key, so a user can move
  between them (see `apps/android/AGENTS.md`, "Distribution flavors").

### CI/CD publishing (automated end to end)

A stable tag (`vX.Y.Z`) builds, uploads, and **releases to production** with no
console step, using FUTO's shared `publish_playstore.py` uploader (the same one
grayjay uses — Android Publisher API v3 with a resumable chunked upload,
transient-error retry, and staged-rollout support):

- `build:android-native` builds a signed `direct` APK **and** `play` AAB on tags.
- `check:release-notes` fails the pipeline in its first minute if
  `release-notes/<tag>.md` is missing or too long for either store.
- `release:gate` blocks the release if any test job (or artifact) is missing.
- `publish:android` (gated by `release:gate`) builds the
  `google-api-python-client` venv (`scripts/venv-playstore.sh`) and runs
  `scripts/publish_playstore.py --package com.futo.notes --aab <…> --track
production --status completed --release-notes-file <…>`. It consumes the
  prebuilt AAB — no Rust rebuild.

Two CI variables change that behavior without editing `.gitlab-ci.yml`, which
is what to reach for when a release should not go straight to everyone:

| Variable       | Effect                                                                      |
| -------------- | --------------------------------------------------------------------------- |
| `PLAY_TRACK`   | `internal`, `alpha`, `beta` instead of the `production` default             |
| `PLAY_ROLLOUT` | A fraction (`0.1`) — publishes as a staged rollout rather than to all users |

Play can still review an update after the publish job succeeds: v1.8.0 was
rejected 28 minutes after submission over the All-files-access permission
declaration. A green `publish:android` means Play accepted the release, not that
it is live — watch Play Console's Publishing overview for a rejection.

**One-time setup required before the first tag pipeline can publish:**

1. **Create the app in Play Console** (`com.futo.notes`) and complete the
   content declarations (Data Safety, content rating, target audience). The
   Play API cannot create the app listing — only upload releases to it.
2. **Enroll in Play App Signing** (default on first upload). Your existing
   `futo-notes-release.keystore` is the **upload key**.
3. **Create a Google Cloud service account** with the Play Android Publisher
   API enabled, then in Play Console → _Users & permissions_ grant it
   **"Release to production"** for FUTO Notes (or admin). Download its JSON key.
   "Release to testing tracks" is not enough: the upload succeeds, then the
   commit fails with HTTP 403 `PERMISSION_DENIED`.
4. **Set these GitLab CI/CD variables** (masked + protected):
   - `PLAY_SERVICE_ACCOUNT_JSON` — base64 of the service-account JSON
     (`base64 -i service-account.json | pbcopy`)
   - `KEYSTORE_BASE64` — base64 of `futo-notes-release.keystore`
   - `KEYSTORE_PASSWORD` — the keystore password
   - `KEY_ALIAS` — the signing key alias

Without `PLAY_SERVICE_ACCOUNT_JSON` the `publish:android` job fails fast;
without the `KEYSTORE_*` vars the AAB is unsigned and Play rejects it.

> First release only: even after the AAB lands on the internal track via the
> API, testers won't see it until the Console declarations above are complete.

---

## Privacy policy (host at a public URL; link from both stores)

Suggested content outline:

```
FUTO Notes — Privacy Policy

FUTO Notes is offline-first. Your notes are stored on your device.

Sync (optional): If you enable sync, your notes are end-to-end encrypted on your
device and uploaded to a server YOU host and control. FUTO does not operate a
notes server and does not receive or store your notes, email, or password.
Deleting your data: erase local data via Settings → Full reset; delete synced
data on your own server.

Crash reports (optional, on by default, disable in Settings): if a crash occurs,
the app may send a diagnostic report (error, stack trace, app version, device
model, OS version, a random session id, and any note you choose to add) to
notes-crashlog.futo.org to help us fix bugs. These reports are not linked to
your identity and are not used for tracking or advertising.

Feedback (optional, only when you send it): Settings -> Send feedback lets you
send us a bug report, feature request or comment. Only what you type, any
screenshots you attach, and your app version, platform, OS version and device
model are sent to notes-crashlog.futo.org. No account is required, your notes
are never included, and we cannot reply to individual messages.

License (optional): FUTO Notes asks you to pay for it, and nothing in the app
enforces that. If you buy a license, you buy it on our website, not in the app. The app stores your license key on your device
and checks it offline. If you type in a license key on its own, the app makes a
single request to pay2.futo.org containing only that key, so it can fetch the
matching activation; it sends no name, email, device id, or other identifier,
and it makes no other licensing request at any time.

We do not use analytics, advertising, or third-party tracking.

Contact: <email/URL for data questions or deletion requests>
```

> Fill in the contact line and host this page (e.g. on notes.futo.org). Both
> stores reject submissions without a reachable privacy-policy URL.
