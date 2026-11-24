# futo-notes-wikilinks

Canonical wikilink scanning, resolution and rename rewriting, shared by the
note model and portable editor. Keep the shipped dependency tree independent
of filesystem, shells and network services so it remains usable in WASM.

The existing model reexports are public compatibility surface. This crate is
the only implementation of the wikilink rules: there is no TypeScript copy and
no TS↔Rust differential for them. A rule change updates the hand-reviewed
`tests/conformance/wikilinks-*.json` goldens, which
`crates/futo-notes-model/tests/conformance.rs` asserts.

For a move, preserve all exports and update authority paths in the drift
registry, conformance README and behavioral spec. Run this crate's tests,
`cargo test -p futo-notes-model`, `just test-rust` and the editor/store consumers.
