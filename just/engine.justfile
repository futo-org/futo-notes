# Shared Rust editor benchmarks, independent of a native shell.

# Engine keystroke cost on this machine (synthetic slow shapes, or Markdown files given).
engine-keys *args:
  cargo run --release -q -p futo-notes-store --example editor_keys -- {{args}}

# Engine hill-climb queue on CI's serial runner: `push <name>` | `results [prefix]`.
engine-climb *args:
  node scripts/engine-climb.mjs {{args}}

