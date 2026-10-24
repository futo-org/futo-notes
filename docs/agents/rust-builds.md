# Rust build and lockfile troubleshooting

Use the owning crate manual and `just` recipes for verification. Cargo's package cache and
build-directory locks protect concurrent writes; a waiter is not evidence that its owner hung.

## A parallel check waits for the build directory

`Blocking waiting for file lock on build directory` means another Cargo invocation owns the
selected target directory. Wait for that invocation, or run the independent Rust check with a
separate target:

```bash
CARGO_TARGET_DIR="$PWD/target/parallel-review" just test-rust-full
```

Choose a task-specific child path and keep it for the task. Worktrees created with `just wt new`
already have separate target directories unless an exported `CARGO_TARGET_DIR` overrides them.
Do not stop another task's process to obtain its lock. This override is for Rust test/build
recipes; app QA launchers can require the repository's ordinary `target/debug` path.

A disposable smoke held a Cargo build script at an explicit gate: a second check named the shared
build lock, while a third check using a separate target completed with both original processes
still live. Releasing the gate let both shared-target processes exit successfully.

## Pin the ICU provider before its constrained locale core

Cargo's conservative package update keeps other locked packages unless their constraints require
an update. If `icu_provider` is locked to 2.3.0, it requires `icu_locale_core = "^2.3.0"`; trying
to pin the locale core to 2.2.0 first fails. For that specific downgrade, the working order is:

```bash
cargo tree -i icu_locale_core
cargo update -p icu_provider --precise 2.2.0
cargo update -p icu_locale_core --precise 2.2.0
```

Inspect the reverse dependency tree and the resolver error for other parents constraining the
core. Adjust those parents compatibly before retrying; do not loosen their declared requirements
or update unrelated packages to silence the conflict. These versions reproduce the historical
report; the repository currently already locks both packages to 2.2.0. Review the lockfile diff and
run the owning verification chain after any dependency change.

The order above was exercised in a disposable two-dependency crate: the leaf-first attempt failed
with `icu_provider v2.3.0` named, then provider-first and locale-core-second both succeeded. The
repository's manifests and lockfile were unchanged. See Cargo's
[package update rules](https://doc.rust-lang.org/cargo/commands/cargo-update.html).
