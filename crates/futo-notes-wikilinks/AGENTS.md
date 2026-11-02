# futo-notes-wikilinks

Canonical wikilink scanning, resolution and rename rewriting, shared by the
note model and portable editor. Keep the shipped dependency tree independent
of filesystem, shells and network services so it remains usable in WASM.

The existing model reexports are public compatibility surface. Rule changes
follow `packages/editor/AGENTS.md`: Rust and the sanctioned TS mirror remain
locked by the hand-reviewed conformance fixtures and differential.

For a move, preserve all exports and update authority paths in the drift
registry, conformance README and behavioral spec. Run this crate's tests,
`cargo test -p futo-notes-model`, `just test-rust` and the editor/store consumers.
