# Rust sync timeouts

Moved here verbatim from `justfile-notes.md`.

`just test-sync` runs ordinary sync tests through pinned, checksum-verified nextest, then Cargo
for doctests (unsupported by nextest). `just test-rust-full` and Linux/macOS CI workspace runs
use the same bounded sync runner and retain Cargo for other crates. Four tests run concurrently;
SLOW is reported every 30s, TIMEOUT after 120s, with 5s termination grace. Server-only cases stay
ignored; `just test-sync-integration` runs those binaries serially and reports whether hosted
stand-in coverage ran.

First use installs `scripts/cargo-nextest-pin.json` through `ci/install-nextest.sh`;
`just install-nextest` installs separately without changing the Rust toolchain. The POSIX
installer supports Linux/macOS. Without a pinned archive, preinstall that exact version in
Cargo's bin directory or `NEXTEST_INSTALL_DIR`. On Windows the binary is `cargo-nextest.exe`
(normally `~/.cargo/bin/cargo-nextest.exe`). Missing/wrong versions fail before testing;
there is no fallback to unbounded Cargo. See nextest's [installation](https://nexte.st/docs/installation/pre-built-binaries/)
and [timeouts](https://nexte.st/docs/features/slow-tests/).

`just test-sync-timeout-proof` runs a healthy fixture beside an intentional deadlock under
repository policy; it succeeds only when nextest names the deadlock as TIMEOUT and exits nonzero.
