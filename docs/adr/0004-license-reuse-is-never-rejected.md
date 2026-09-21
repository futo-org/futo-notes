# A license is never rejected for reuse, and nothing counts devices

We wanted to know whether one license covers all of a buyer's devices. Investigating rather than
deciding showed the question was already answered by the implementation on both sides. The
client verifies entirely offline — once a device holds a license pair it never contacts a
server again — so it cannot count devices even in principle. On the server, FUTOpay stores
`max_activations` on products (defaulting to 1) and ships a
`validate_activation_limits(current_count, max_activations)` helper that raises "Maximum
activations reached" — but that helper has **zero callers**, and the activate endpoint hands
out the stored activation on every request with no counting. We decided to keep it that way and
to state it plainly in the spec while saying nothing about scope in shipped copy.

## Consequences

- **The spec is precise; the product copy is silent.** The spec records that no device or
  activation count exists anywhere and that a key is never rejected for reuse. Shipped copy
  says nothing about how many devices a license covers, in either direction — no "one licence
  per person", no "covers all your devices". Ambiguity is a deliberate stance in the copy and a
  bug in the spec, and they must not be confused.
- **`max_activations` is inert, and that is load-bearing.** A populated column beside a dormant
  enforcement helper reads like an oversight. Wiring it up would break every multi-device buyer,
  and would do so asymmetrically: pasting an e-mailed license pair would keep working while
  typing the same bare key on a second device would start failing, because only the activation
  fetch passes through the server. Anyone tidying that helper up must treat it as a breaking
  change to FUTO Notes.
- **A cap would buy almost nothing.** Anyone sharing a key can share the activation beside it,
  which no server-side limit can reach. The enforcement cost lands on honest buyers with more
  than one device.
- The stakes are a cosmetic badge. Combined with no revocation check, a refunded or shared
  license keeps working — already accepted elsewhere in the spec as the price of offline-first.

Origin: grilling session, 2026-09-10. Vocabulary in CONTEXT.md (activation vs. activation
fetch, license pair).
