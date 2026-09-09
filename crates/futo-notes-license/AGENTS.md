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
| `config.rs` | The baked-in constants: product slug, deep-link scheme, key alphabet, buy URL, support mailto, the two org public keys and the two pay2 hosts, and the `Environment` dev/prod split. |
| `key.rs` | The FUTOpay license-key grammar and normalization. |
| `input.rs` | Recognising the three accepted input shapes, and deep-link parsing. |
| `activation.rs` | v2 activation parsing and RSA-SHA256 PKCS#1 v1.5 verification. |
| `state.rs` | `evaluate` — the Licensed / Expired / Invalid predicate, with the clock injected. |
| `enter.rs` | The atomic enter-a-key workflow and the one `ActivationTransport` call. |

Storage, the clock, HTTP, and user-facing copy are all outside. `AcceptedLicense::pair` is two
plain strings; where they live is the shell's business.

## Rules that are not negotiable

- **Zero network** outside `enter_license_key`, and only on the bare-key path: exactly one `GET`,
  no retry, no launch check, no polling, no background re-attempt. `enterKey` goldens whose
  transport is `"unavailable"` panic on any request, so a new network call fails loudly.
- **v1 activations are rejected.** The Grayjay-era bare signature carries no product and no
  expiry. Other FUTO apps keep accepting v1; this one does not.
- **The signature is verified before the payload is parsed**, and the payload bytes are never
  re-serialized — what was signed is what arrived, so there is no canonical-JSON rule to get wrong
  on the client.
- **`expires_at` must be present.** `null` is how a perpetual product says so; an absent field is a
  payload we do not understand, and reading it as perpetual would turn a server bug into a free
  forever-license.
- **No dev/prod crossover** (AGENTS.md M3). Release builds verify against the production key and
  talk to `pay2.futo.org`; dev builds use the staging key and `staging-pay2.futo.org`. Never fetch
  a public key at runtime.
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
drop the product check, accept `v1`) and the run must fail naming the vector. A golden that cannot
go red is not a golden (M11).

## Verification (required)

| What changed | Run |
|---|---|
| Anything in this crate | `just test-rust` |
| A dependency or the workspace | `just test-rust-full` |
| Before merge | `just check` |
