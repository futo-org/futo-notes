# AGENTS.md — futo-notes-license

The single owner of every paid-client-license rule. Behavioral truth:
[`docs/spec/license.md`](../../docs/spec/license.md); the implementation spec is GitLab issue #149.

FUTO Notes is free to use. A license unlocks **nothing functional** — it removes the ambient
"Unlicensed" label and shows "Supporter since {year}". Never add a licensed-only feature, theme,
icon, or limit to this crate or to anything that reads it; a "cosmetic" feature non-payers would
want is a gate by another name.

## What lives here

| Module | Owns |
|---|---|
| `config.rs` | The baked-in constants: org and product slugs, deep-link scheme, key alphabet, support mailto, the two org public keys and the two pay2 hosts, and the `Environment` dev/prod split. `buy_url` and `activation_url` are both built from the selected environment, so neither is a single cross-environment constant. |
| `key.rs` | The FUTOpay license-key grammar and normalization. |
| `input.rs` | Recognising the three accepted input shapes, and deep-link parsing. |
| `activation.rs` | v1 and v2 activation parsing and RSA-SHA256 PKCS#1 v1.5 verification. |
| `state.rs` | `evaluate` — the Licensed / Expired / Invalid predicate, with the clock injected. |
| `enter.rs` | The atomic enter-a-key workflow and the one `ActivationTransport` call. |

Storage, the clock, HTTP, and user-facing copy are all outside. `AcceptedLicense::pair` is two
plain strings; where they live is the shell's business.

## Rules that are not negotiable

- **Zero network** outside `enter_license_key`, and only on the bare-key path: exactly one `GET`,
  no retry, no launch check, no polling, no background re-attempt. `enterKey` goldens whose
  transport is `"unavailable"` panic on any request, so a new network call fails loudly.
- **Both activation formats are accepted, and v2 is never removed** (decision 2026-09-10, issue
  #161). v1 is the bare base64url signature over the license-key string that `pay2.futo.org` issues
  today; v2 is the signed envelope. Accepting both is what lets the server move to v2 with **zero
  client release** — a shipped mobile app cannot be hot-fixed, so deleting the v2 path would make
  that migration a store submission. v2 semantics stay exactly as they were when a v2 activation
  arrives.
- **A v1 activation claims nothing beyond "this org signed this key".** No product, no
  `issued_at`, no `expires_at`; it is Licensed, perpetually. Never invent those fields — not
  `now`, not the activation-fetch time, not a default. `LicenseDetails` makes them `Option` so
  there is no place to put an invented value.
- **TRIPWIRE — v1 acceptance depends on the `futo-notes` org minting keys for exactly one
  product.** A v1 signature covers only the key string, so *any* v1 activation this org mints
  verifies here. A subscription product is coming under the same org and issues no license keys, so
  it does not trip this. **If any second product in the `futo-notes` org ever mints a license key,
  v1 acceptance must be dropped from `split_envelope`/`evaluate` and v2 becomes mandatory** — which
  is the other reason the v2 path stays. Same tripwire in docs/spec/license.md.
- **The signature is verified before the payload is parsed**, and the payload bytes are never
  re-serialized — what was signed is what arrived, so there is no canonical-JSON rule to get wrong
  on the client.
- **`expires_at` must be present in a v2 payload.** `null` is how a perpetual product says so; an
  absent field is a payload we do not understand, and reading it as perpetual would turn a server
  bug into a free forever-license. v1 is exempt because it has no payload at all — its perpetuity
  is the format, not a server's answer.
- **No dev/prod crossover** (AGENTS.md M3). Release builds verify against the production key and
  talk to `pay2.futo.org`; dev builds use the staging key and `staging-pay2.futo.org`. Never fetch
  a public key at runtime. **The Buy destination is part of that split**, not an exception: it was
  one constant pointing at a landing page, which meant a `.dev` build could only ever open
  production checkout. Anything that leaves the app for money takes a `LicenseConfig`.
- **`Environment::for_bundle_id` is the only selector**, and the `.dev` suffix is the split. Do not
  reintroduce a `cfg!(debug_assertions)` version: the native shells compile the FFI with
  `release-ffi` for their dev apps too, so a compile-profile test silently puts a `.dev` phone build
  on the production key. The mapping is pinned as fixture data, not just as a doc comment.
- **The org prefix is not ours to constrain.** The spec does not bound it and lib-polar takes it
  from server config, so the client's only bar is that the key stays one whitespace-free token. A
  length cap or an alphabet here means refusing a license the server really minted.
- **`InvalidReason` is diagnostic only.** Every reason renders as the one specified message. It
  exists so a golden proves the failure it was written to prove.

## The conformance fixture

`tests/conformance/license.json` is hand-reviewed: a human decided every `expected`.
`scripts/gen-license-fixture.mjs` fills in only what a reviewer cannot type — the two test-only RSA
key pairs and the `activation` string derived from each case's `sign` block. It never reads or
writes an `expected` value, which is the exact failure mode that got the previous fixture generator
deleted (`tests/conformance/README.md`, "What this replaces").

Adding a vector: write the case with its reviewed `expected`, run `node
scripts/gen-license-fixture.mjs`, then `just test-rust`. Changing a rule means changing the goldens
in the same commit and saying why in the message.

**The goldens are already the staleness guard — do not add apparatus for it.** A signature that
went stale against an edited payload fails verification, and verification runs before the key,
product and clock checks, so every signed vector except the ones that *expect*
`signatureMismatch` goes red on its own. That is `cargo test --workspace`, which is CI's hard gate.
`node scripts/gen-license-fixture.mjs --check` exists for a human who wants the answer in 50ms; it
is deliberately not in `just test-rust`, because a guard CI never runs is not a guard (M11), and a
second one that only restates a red test is weight without a job.

Red-proof anything you add: perturb the implementation (flip `>=` to `>` on the expiry compare,
drop the product check, reject `v1` again, verify a v1 signature over something other than the
normalized key) and the run must fail naming the vector. A golden that cannot go red is not a
golden (M11).

## Verification (required)

| What changed | Run |
|---|---|
| Anything in this crate | `just test-rust` |
| A dependency or the workspace | `just test-rust-full` |
| Before merge | `just check` |
