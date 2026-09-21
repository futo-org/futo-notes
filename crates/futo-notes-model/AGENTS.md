# AGENTS.md — futo-notes-model

The note domain: deterministic decisions about filenames, folders, tags, previews, IDs, and
wikilinks. **This crate never touches a user's note tree** — no `std::fs`, no vault paths. Durable
behavior belongs to `futo-notes-store`; low-level primitives (`sanitize_title`, `validate_title`,
path safety, atomic writes, hashing) belong to `futo-notes-core` and are re-exported here, not
re-ported. `src/lib.rs` is the public facade and says which rule lives where.

Consumers: `futo-notes-store`, which is how Tauri desktop reaches these rules — the desktop crate
does not depend on this one directly (`apps/tauri/src-tauri/Cargo.toml`) — and native iOS and
Android through the UniFFI facade in `futo-notes-ffi`.

## The rule that governs every change here

This is the canonical side of the one permitted TypeScript duplication (AGENTS.md M6/M7). The hot
path in `packages/editor/` mirrors part of this surface so the editor can answer per keystroke, and
`tests/conformance/*.json` plus the generated differential pin the two together bit-for-bit.

Changing a rule means: edit Rust **and** the TS mirror, update the hand-reviewed goldens, and run
both consumers. `packages/editor/AGENTS.md` owns that procedure. A Rust-only edit that passes
`cargo test` has not been verified.

`examples/title_rule_oracle.rs` is the Rust side of the differential — the harness shells out to it,
so keep its stdin/stdout protocol stable.

## Dependencies

`scripts/check-rust-dependency-boundaries.mjs` forbids `tantivy` and the ONNX runtime crates
(`ort`, `ort-sys`) anywhere in this crate's shipped dependency tree. A search or ML dependency here
would drag the whole engine into every native binary. That gate runs only in CI's Rust workspace
job — no `just check` fires it — so run `node scripts/check-rust-dependency-boundaries.mjs` by hand
after touching a `Cargo.toml`.

## Verification (required)

```bash
cargo test -p futo-notes-model    # unit + the conformance goldens
just test-rust                    # goldens + the TS↔Rust title differential
```

Any rule change also needs `pnpm run test:editor:full` and, for anything reaching a note's identity
on disk, `cargo test -p futo-notes-store`.
