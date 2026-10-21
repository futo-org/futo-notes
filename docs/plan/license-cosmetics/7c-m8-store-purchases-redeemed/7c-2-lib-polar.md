### 7c.2 lib-polar (read-only study; nothing there was changed)

**How keys are minted today.** A Polar `order.paid` webhook (`api/public/webhooks.py`,
`POST /webhook/polar/{org_slug}`) or the buyer's status poll both funnel into
`issue_session_license` (`utils/org_tools.py`), serialized by `app_session_issue_lock`, which
confirms the purchase with Polar and calls `create_key_func`. `create_key_func(db, org_slug,
product_slug, customer_email)` is the reusable core and is already what the admin route
`/admin/createkey/{org}/{product}` calls: it generates a key + activation with the org's RSA
key, inserts a `used_license_keys` row (public schema) and a `license_activations` row (org
schema, keyed by `license_key`). `GET /api/v1/activate/{key}` then serves the stored
activation (`api/public/pages.py`). Data model: `organizations` (signing key pair),
`futopay_products` (per org; already has an unused-for-this `apple_store_url`),
`used_license_keys`, `license_activations`, `app_sessions`. Tables and missing columns are
created at startup from the model lists (`_PUBLIC_TABLES` / `_ORGANIZATION_TABLES` in
`db_manager.py`), so a new table needs no migration script.

**New endpoint.** `POST /api/v1/redeem/apple/{org_slug}`, body `{"signed_transaction": "<jws>"}`,
in a new `api/public/apple.py` bound from `bind_public_api` (`api/public/__init__.py`). Steps:
verify, check the product mapping, then under a lock (or an `INSERT ... ON CONFLICT DO
NOTHING` on the primary key, then re-read) look up `original_transaction_id`; if absent call
`create_key_func(db, org, product, customer_email="apple:<originalTransactionId>")`, store the
mapping, and return the key plus the activation the activation table holds. Idempotent and
race-safe because the mapping row is the single source; two concurrent first redemptions must
yield one key, mirroring `app_session_issue_lock`.

**Storage.** New public table `apple_transactions`: `original_transaction_id` PRIMARY KEY,
`license_key`, `org_slug`, `product_id`, `apple_product_id`, `bundle_id`, `environment`
(`Production`/`Sandbox`), `first_transaction_id`, `t_created`, `t_last_redeemed`,
`redeem_count`. Add a `DatabaseManager` getter/insert next to `get_used_license_key`.

**Verification with Apple's library** (`pip install app-store-server-library`, Python 3.8+;
this server is 3.12). API as read 2026-10-16:
`SignedDataVerifier(root_certificates: List[bytes], enable_online_checks: bool, environment,
bundle_id, app_apple_id=None)`, then `verify_and_decode_signed_transaction(signed_transaction)
-> JWSTransactionDecodedPayload`; failures raise `VerificationException` carrying a
`VerificationStatus` (`INVALID_APP_IDENTIFIER`, `INVALID_ENVIRONMENT`, `INVALID_CHAIN`,
`INVALID_CERTIFICATE`, `INVALID_CHAIN_LENGTH`, `VERIFICATION_FAILURE`,
`RETRYABLE_VERIFICATION_FAILURE`). In that method the library checks `bundleId` and
`environment` equality; it does **not** check `app_apple_id` there, but the constructor requires
`app_apple_id` when `environment == PRODUCTION`. Consequences for us:

- **Roots**: all three Apple roots (Apple Root CA, G2, G3; decided, § 9 Q8) as DER files in the
  repo (README: download from Apple PKI, "provide these certificates as an array"). The
  root-to-trust question is closed; the chain, role and date rules are the library's, not ours.
- **A verifier is per environment**: build one for Production (needs the numeric App Store app
  id) and one for Sandbox, and try Production then Sandbox, or read the unverified `environment`
  claim only to choose which verifier to try, never to skip verification.
- **Never construct a verifier for `XCODE` or `LOCAL_TESTING`**: for those the library returns
  the payload **without checking the signature** (its `_decode_signed_object` skips verification
  and leaves the environment check to the caller). Only `PRODUCTION` and `SANDBOX` are ever
  configured, and a test asserts it.
- **`enable_online_checks`**: `True` makes the library call Apple's OCSP responder per
  verification (30 s timeout, `RETRYABLE_VERIFICATION_FAILURE` on network trouble) and use the
  current date for certificate validity; `False` validates against the transaction's signed
  date and makes no outbound call. Refunds are out of scope (@justin 2026-10-16), so recommend
  `False`: no new availability dependency on Apple's OCSP host. Not revisited unless refunds return.
- **Claims we check ourselves** after the library: `productId` equals the configured Apple
  product id, `type` is non-consumable, `inAppOwnershipType == PURCHASED` (reject family-shared),
  and bundle id as configured. `revocationDate` is ignored (refunds are not a concern); it can
  be turned into a 4xx later with one line.
- **App Store Server API keys are not needed.** We verify a JWS Apple already signed; no call to
  Apple's API. Keys (and a JWT signer) would only be needed to fetch transaction history,
  look up a refund, or send test notifications, all out of scope.

**Config / secrets.** No new secret. Non-secret config: `APPLE__BUNDLE_ID` (`com.futo.notes`),
`APPLE__APP_APPLE_ID` (numeric, from App Store Connect), `APPLE__ROOT_CERT_DIR`,
`APPLE__ACCEPT_SANDBOX`, and a per-product map from the Apple product id to the FUTOpay
org/product slug in the same `.env` style the v2 branch uses
(`POLAR__ORGS__FUTO_NOTES__PRODUCTS__FUTO_NOTES__APPLE_PRODUCT_ID`). The org signing key is the
existing one (no new key; the memory note on org keys applies: the deployed key, not 1Password,
is the authority).

**Staging vs production.** The deployments split exactly as today (`staging-pay2` mints with the
staging org key, `pay2` with the production key), and the client's `Environment` already picks
host + key together (no dev/prod crossover). Two facts shape this:

1. A `.dev` bundle has no App Store Connect record, so it can only buy through an Xcode StoreKit
   configuration, whose transactions are `XCODE`-environment and **unverifiable by the server by
   design**. So `.dev` builds cannot exercise the real endpoint end to end. Real Sandbox
   purchases come from a **TestFlight build of `com.futo.notes`**, and TestFlight/App Review
   purchases are Sandbox transactions in the *release* binary, which talks to **production**
   FUTOpay. So the production deployment must accept Sandbox transactions (this is the server
   half of Q7), or the reviewer's purchase fails.
2. The staging path remains testable through the existing `FUTO_LICENSE_ENV=staging` compile
   flag on a TestFlight build of the release bundle: staging FUTOpay is configured with the
   release bundle id and accepts Sandbox only.

**Sandbox abuse, and the recommended containment.** A Sandbox JWS is a real Apple signature, and
TestFlight purchases are free, so on a production server that accepts Sandbox, anyone who can
install our TestFlight build can mint production keys. The stakes are a cosmetic (and ADR-0004
already accepts reuse), but it is unbounded. Options: (a) accept it, flag the row
`environment=Sandbox` so keys can be audited; (b) mint Sandbox redemptions as **v2 activations
with a short `expires_at`** (needs the v2 branch; the client already verifies v2 and shows
Expired); (c) refuse Sandbox in production and give the reviewer a review-only build (a second
binary: rejected by Q7 as written). Recommendation: (b) if v2 lands first, else (a).

**Is the v2 branch a prerequisite? No.** `create_key_func` on `main` mints v1, which the client
accepts today. The branch (`feat/futo-notes-v2-activation`, last commit 2026-09-09, 63 commits
behind `main`, merge-base `fac91ab0`) adds per-product `activation_format`/`license_term_months`
and `issue_activation`. It helps (a real `issued_at` for the card, the product bound into the
signature, short-expiry Sandbox keys) and it hardens the v1 tripwire (`crates/futo-notes-license/
AGENTS.md`), but redemption through v1 is correct. If both are wanted, land v2 first: the
redeem endpoint then calls the same `mint_license_key_pair` the branch introduces. Verified by
reading the diff only; I did not run either branch.

**Rate limiting / abuse.** lib-polar has no rate-limit machinery (grep for slowapi / rate-limit
finds only an unused `RateLimitError` class). Verification is a local ECDSA + chain check with
`enable_online_checks=False`, so garbage bodies are cheap to reject; a mint needs a valid Apple
signature and happens once per `originalTransactionId`. A JWS is a bearer proof: replay returns
the same key, exactly ADR-0004's stance. Add a body-size cap and a per-IP limit at the reverse
proxy rather than in the app (not verified what fronts pay2; ask the lib-polar owner).

**Tests (lib-polar).** No Apple dependency in CI: tests mint a throwaway CA, leaf and ES256 JWS
and pass the throwaway CA as the verifier's `root_certificates` (the library takes whatever
roots it is given). Cases: valid mint, replay returns the same key, concurrent first
redemptions yield one row, wrong bundle, wrong product, wrong environment, family-shared,
tampered payload, chain to an unknown root, `alg` not ES256, Xcode-environment payload rejected
(proves we never configure it), Sandbox refused when `ACCEPT_SANDBOX` is off. One golden from a
real TestFlight transaction (captured once, checked in with its date; its leaf will have expired
so the test pins the effective date by running with online checks off, as production does).
Existing test style: plain `test_*.py` under `pylib/futopay_server/tests/`, runnable without a
database for the pure-function ones (see `test_activation_v2.py` on the branch).

**Deploy.** The table is created on next startup; add the dependency to `pyproject.toml` and the
`server.Dockerfile` image; set the `.env` variables on staging and production; ship the Apple
root files with the image. **Hard ordering**: production FUTOpay must be live with the endpoint
and Sandbox acceptance **before** an App Store submission, because App Review exercises it.

#### lib-polar task list

| # | Task | Size | Files |
|---|---|---|---|
| L1 | Dependency + Apple roots + config (`APPLE__*`, product map), `AppleVerifier` wrapper: per-environment verifiers, claim checks, never XCODE/LOCAL_TESTING, mapped exceptions | S-M | `pyproject.toml`, `server.Dockerfile`, new `licensing/apple.py`, new `licensing/apple_roots/*.cer`, `common.py` (config), `env.example` |
| L2 | `apple_transactions` table + manager getter/insert, race-safe first-redeem | S-M | `database/dto.py`, `database/db_manager.py` (`_PUBLIC_TABLES`) |
| L3 | `POST /api/v1/redeem/apple/{org}` route: verify, map, mint via `create_key_func` (or v2 `mint_license_key_pair`), idempotent, JSON response, error codes (200/400/403/404/409/503) | M | new `api/public/apple.py`, `api/public/__init__.py`, reuse `utils/org_tools.py` |
| L4 | Tests with a throwaway CA (+ one real golden) | M | `tests/test_apple_redeem.py`, `tests/conformance/` |
| L5 | Sandbox policy: acceptance flag, row flag, optional short-expiry v2 | S (L if v2 not yet landed) | `api/public/apple.py`, branch `feat/futo-notes-v2-activation` |
| L6 | Deploy: staging then production, App Store Connect ids, proxy limit, README section | S | `README.md`, deployment repo (not read) |

Whole lib-polar side: **M** (about a week of focused work including tests; L5's v2 dependency is
the only thing that could widen it).
