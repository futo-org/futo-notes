# Store Submission Reference — Native iOS & Android

Console-ready answers for the App Store and Google Play submission forms, plus
the review-notes copy. This reflects FUTO Notes' actual data behavior:

- **No FUTO-hosted cloud.** Sync is **opt-in** and connects to a **server the
  user self-hosts** (futo-notes-server). The user enters the server URL; the
  app only *logs in* (`/api/auth/password/login`) — there is **no in-app account
  creation**.
- **E2EE.** Note content is encrypted on-device (PBKDF2-HMAC-SHA256 +
  AES-256-GCM) before upload; the server stores opaque blobs.
- **The only data FUTO itself receives** is **optional crash diagnostics** sent
  to `notes-crashlog.futo.org` (default on, opt-out in Settings).
- Notes live locally in the app's Documents container. No ads, no analytics, no
  tracking, no third-party data-collection SDKs.
- **An optional paid client license** (docs/spec/license.md) gates **nothing**:
  it removes an "Unlicensed" label and shows a "Supporter since {year}" badge.
  It is bought on the web, never in-app — there is no IAP and no Play Billing.
  The only network call it can make is **one** activation request to
  `pay2.futo.org`, and only when the user explicitly enters a bare key.

> ⚠️ These answers rest on the self-hosted, no-FUTO-cloud model above. If FUTO
> ever ships a hosted sync service, revisit account-deletion (Apple 5.1.1(v) /
> Play account-deletion policy) and the data-collection declarations.

---

## Apple App Store

### App Privacy (App Store Connect → App Privacy)

**Data collected by the developer:**

| Data type | Linked to identity | Used for tracking | Purpose |
|---|---|---|---|
| Diagnostics → **Crash Data** | No | No | App Functionality |
| Diagnostics → **Other Diagnostic Data** (device model, OS version, session id) | No | No | App Functionality |

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

FUTO Notes is free and fully functional with no account and no purchase. Every
feature behaves identically whether or not a license is bought. A user may
optionally buy a LICENSE on the web at pay.futo.tech; it unlocks NO
functionality, removing only an "Unlicensed" label and showing a "Supporter
since <year>" badge. There is no paywall, no trial, and no feature, theme, or
capacity behind it. Settings shows a link that opens the system browser to that
page, plus a field where a user who already bought a license pastes their key.
Verification is an offline signature check against a key compiled into the app;
a user who pastes only a bare key causes exactly one HTTPS request to
pay2.futo.org to fetch the matching signed activation, and no other licensing
request is ever made.
```

> ⚠️ **This is the review risk on iOS, and it is deliberate** (docs/spec/license.md,
> "Store posture"). Guideline **3.1.1** names license keys as a forbidden unlock
> mechanism, and **3.1.3(b)** permits honoring a web-bought license only where an
> IAP twin also exists. FUTO ships the full surface — key field, deep link, and
> the Buy link — **worldwide with no IAP twin**, and accepts the risk. If Apple
> objects, the response is a flag flip, not a redesign: set
> `LICENSE_LINK_OUT_DISABLED` (apps/ios/project.yml) to hide Buy, Renew and
> Lost-your-key while keeping the key field and deep link — the consumption-only
> shape. Do not quietly add an IAP or remove the feature without re-reading that
> spec section first.

### Other listing requirements
- Privacy policy URL (required) — see "Privacy policy" below.
- Screenshots per required device sizes; app icon already in the asset catalog
  (alpha removed).

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
  in-app *Settings → Full reset* deletes all local data; sync data lives on the
  user's own self-hosted server which the user controls/deletes directly. FUTO
  operates no account service. Crash diagnostics are anonymous and not tied to a
  user account.

### Paid client license (Play)

A `play` build that merely accepts a pasted key is explicitly permitted
(consumption-only, 0%, no enrollment). This build ships more than that: it also
shows a **Buy link out to pay.futo.tech**, which needs the External Content
Links / billing-choice programs, and Google enforces **after** publication.
`LICENSE_LINK_OUT` is a `buildConfigField` on the `play` flavor
(apps/android/app/build.gradle.kts); flipping it to `false` for `play` alone
hides Buy, Renew and Lost-your-key and leaves the compliant consumption-only
shape, with the key field and deep link intact. That is the response to a
takedown — see docs/spec/license.md, "Store posture".

- Do **not** describe the license as a donation in the listing (Play treats
  donations differently, and FUTO is not a nonprofit).
- Do **not** put a price in the listing's app description as if it were an
  in-app product; the price lives only on the web storefront.
- *(F-Droid, `direct` flavor)* Offline verification adds no anti-feature, but
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

### CI/CD publishing (automated)

A tag pipeline now builds and uploads the AAB to the Google Play **internal
testing** track automatically, using FUTO's shared `publish_playstore.py`
uploader (the same one grayjay uses — Android Publisher API v3 with a resumable
chunked upload, transient-error retry, and staged-rollout support):

- `build:android-native` builds a signed `direct` APK **and** `play` AAB on tags.
- `release:gate` blocks the release if any test job (or artifact) is missing.
- `publish:android` (gated by `release:gate`) builds the
  `google-api-python-client` venv (`scripts/venv-playstore.sh`) and runs
  `scripts/publish_playstore.py --package com.futo.notes --aab <…> --track
  internal --status completed`. It consumes the prebuilt AAB — no Rust rebuild.

To go live later, change the `--track internal` flag in the `publish:android`
job to `--track production` (optionally `--status inProgress --rollout 0.1`
for a staged rollout). Keep early releases on `internal`.

**One-time setup required before the first tag pipeline can publish:**

1. **Create the app in Play Console** (`com.futo.notes`) and complete the
   content declarations (Data Safety, content rating, target audience). The
   Play API cannot create the app listing — only upload releases to it.
2. **Enroll in Play App Signing** (default on first upload). Your existing
   `futo-notes-release.keystore` is the **upload key**.
3. **Create a Google Cloud service account** with the Play Android Publisher
   API enabled, then in Play Console → *Users & permissions* grant it
   **"Release to testing tracks"** (or admin). Download its JSON key.
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

License (optional): FUTO Notes is free to use. If you buy a license, you buy it
on our website, not in the app. The app stores your license key on your device
and checks it offline. If you type in a license key on its own, the app makes a
single request to pay2.futo.org containing only that key, so it can fetch the
matching activation; it sends no name, email, device id, or other identifier,
and it makes no other licensing request at any time.

We do not use analytics, advertising, or third-party tracking.

Contact: <email/URL for data questions or deletion requests>
```

> Fill in the contact line and host this page (e.g. on notes.futo.org). Both
> stores reject submissions without a reachable privacy-policy URL.
