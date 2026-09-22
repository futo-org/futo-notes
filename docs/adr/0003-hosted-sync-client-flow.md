# Hosted sync is set up once, in the app, and never asks again

The hosted service signs people in with "Log in with FUTO" (OIDC through Zitadel, brokered by
the server's Login Hand-off) and keeps vault encryption under a separate vault password
(server ADR 0005). The client turns that into one flow that a person finishes without leaving
the app on mobile: log in, subscribe if the account has no vault yet, choose or unlock the
vault, save the recovery key, sync. After that the device holds everything it needs and never
asks for a password again. The same code ships on desktop, iOS, and Android in the same
release, behind a build-time flag that is off for store builds until launch.

## Decisions

1. **Browser surface.** The Login Hand-off URL, the Polar checkout, and the Polar customer
   portal open in a platform auth sheet on mobile (`ASWebAuthenticationSession`, Chrome Custom
   Tabs) and the system browser on desktop. The app polls the server for the outcome, so no URL
   scheme, universal link, or return deep link exists. Embedded WebViews were rejected: isolated
   cookies make every login a typed one and identity providers block them.
2. **Hosted address is baked in.** `notes-sync.futo.org` is a build constant (debug builds keep
   an override). The sync screen leads with "Log in with FUTO"; "Use my own server" reveals
   today's URL and password fields. The app still probes the capability endpoint, so a self-hosted
   server in OIDC mode gets the hand-off too. For the internal MVP the name is DNS'd at the
   staging load balancer, so launch needs no client release for the hostname. Internal builds
   (debug, TestFlight dogfood, Android prerelease, desktop internal) bake the staging name
   (`staging-notes-sync.futo.org`) via `FUTO_HOSTED_SERVER_BAKED` instead; store builds keep the
   production name, so launch still needs no client release (C3, D1).
3. **One wizard, step derived from server facts.** After login the step is chosen by
   `GET /api/billing` and whether the vault has key material — never from a stored wizard
   position, so quitting halfway and reopening lands on the right screen. Two shapes exist:
   - *No vault yet*: login → subscribe → choose vault password → recovery key → sync. Subscribe
     cannot be skipped because `PUT /api/collections/{id}/key` is an entitlement-gated write.
   - *Vault exists*: login → unlock (vault password, QR from an unlocked device, or recovery key)
     → sync. No subscribe step; a lapsed subscription surfaces as a banner on the first refused
     write, because reads are never gated.
   The recovery key is shown once, on a fresh vault, cannot be skipped, and is never re-shown.
4. **What the device keeps.** The 32-byte vault key and the session token go in the OS secret
   store, keyed per notes root. The vault password is never stored. A device set up by password,
   by QR, or by recovery key is indistinguishable afterwards, and a vault-password change on one
   device touches no other. Self-hosted password mode keeps today's behaviour (password stored,
   login derives the key).
5. **QR pairing, new device shows the code.** The new device, already logged in, generates a
   one-time X25519 keypair and a pairing id and shows them plus its device name as a QR. The
   unlocked device scans, shows one confirm sheet naming the new device ("Give this device access
   to your notes?"), encrypts the vault key to the public key, and posts the ciphertext to an
   account-scoped relay on the server; the new device polls and decrypts. Desktops can show a
   code, phones can scan one, so laptop-as-new-device works without a camera. The one case with
   no camera on the scanning side (desktop unlocked, phone new) falls back to typing the vault
   password. No verification code beyond the confirm sheet: the screens are side by side.
6. **Recovery key format.** 128 bits of entropy as Crockford base32 with a check character,
   seven groups of four. Case-insensitive, no `0/O` or `1/I` ambiguity, a typo is caught before
   any unwrap. HKDF derives the wrap key; no slow KDF is needed at that entropy. The save screen
   offers Copy, Save file (desktop) or Share (mobile), and a checkbox "I've saved my recovery
   key" that enables Continue. No type-back. The screen says plainly that FUTO cannot recover the
   vault without it.
7. **Vault password rules.** Argon2id, 64 MiB memory, 3 passes, 1 lane, wraps the key for the
   hosted envelope. `key_kdf` grows an `argon2id` variant; `pbkdf2-sha256` envelopes written by v1
   clients still unwrap. Minimum 12 characters, a strength meter, no composition rules. This
   password is the only thing between an operator holding the envelope and the vault, which is
   why it is stronger than a login password.
8. **Subscription surface is read-only.** One account card on the sync screen: email,
   subscription state in words ("Active", "Payment failed, sync pauses on 22 Sep", "Expired"),
   storage used against the quota, and "Manage subscription" opening the Polar portal. A `402
   subscription_required` turns the sync-status line into "Sync paused" with a Subscribe button
   that opens checkout; `507 quota_exceeded` becomes "Vault is full" with the portal button. The
   app writes no billing state; Polar's portal owns invoices, cancellation, and cards.
9. **Sign out is one action.** It calls the server logout, deletes token and vault key from the
   secret store, and demotes sync state exactly as disconnect does today. No locked-but-signed-in
   halfway state. Self-hosted keeps its current desktop pair (Forget password, Reset connection).
10. **Change vault password / New recovery key** live in the account card and ask for no current
    secret: the device already holds the key, and a QR-paired device never had the password.
    Each re-wraps its envelope and PUTs. Generating a new recovery key invalidates the old one.
11. **Rust owns the sequence.** A `HostedSetup` state machine in `futo-notes-sync`, projected
    through UniFFI and Tauri, exposes the steps (`begin_sign_in → url`, `await_sign_in`,
    `billing_status`, `begin_checkout → url`, `create_vault(password) → recovery_key`,
    `unlock_with_password`, `unlock_with_recovery_key`, `begin_pairing → qr_payload`,
    `complete_pairing(scanned)`, `await_pairing`). Shells own only what Rust cannot: open a URL in
    the auth sheet, render a QR from a payload string, run a camera scanner that returns a
    string. Every user-visible string is a `languages/en.json` entry.
12. **Tests drive the real flow** against the server's stand-in test mode for Zitadel and Polar,
    shipped in the release binary the pin points at. `window.__testSync` gains `connectHosted()`;
    native legs use the debug hooks. The relay is tested end to end with a string standing in
    for the camera.
13. **Build-time flag.** On for debug, TestFlight internal, and the internal Android track; off
    for store releases until launch, where the sync screen is exactly today's self-hosted UI.

## Consequences

- **Server work this decides, owned in the server repo:** app sessions minted through the
  hand-off slide to 90 days from their last authenticated request (today every session is a
  fixed 7 days with no renewal route, which would bounce every device into a browser weekly); an
  account-scoped pairing relay (create with public key and device name, post ciphertext, poll,
  short expiry, single use); `PUT /api/collections/{id}/key` accepting a re-wrap from an unlocked
  client with 409 only on a stale `key_updated_at`; the recovery-envelope columns from ADR 0005;
  and the stand-in test mode. None of it can be exercised on CI until a server release carrying
  these ships and `scripts/sync-server-pin.json` is bumped (`"standinMode": true` alongside the
  version). Locally it can: `FUTO_NOTES_E2EE_SERVER_REPO=<checkout>
  FUTO_NOTES_E2EE_SERVER_STANDIN=1 just test-sync-integration` runs the hosted scenarios against
  a server built from the unreleased branch.
- The client handles `invalid_session` on hosted by showing "log in again", not by treating it
  as a vault reset; sync state survives. `docs/spec/sync.md`'s "reauthenticates transparently
  from the saved password" line applies to password mode only.
- Two unlock models coexist in one codebase: password mode derives the key from the login
  password; hosted holds a separate key. `connect(password)` splits into authenticate and
  unlock.
- New per-shell surface that did not exist before: an auth-sheet opener, a QR renderer, a camera
  scanner with its permission string, and secret-store entries for the key and token. Native
  shells stop re-logging-in with a stored password on cold start.
- Losing every device and the recovery key makes the vault unrecoverable. The product says so at
  the recovery-key screen, not only here.

Origin: grilling, 2026-09-15, following server ADR 0005 (`futo-notes-server-hosted/docs/adr/
0005-vault-encryption-is-separate-from-account-authentication.md`). Vocabulary: the server
repo's CONTEXT.md (Vault Password, Recovery Key, Login Hand-off, Entitlement, Grace Period).
