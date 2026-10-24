# Native iOS checks from Linux

Use `just ios-remote` to run current source on a Mac without manually creating a checkout,
copying changed files, or constructing Xcode filters:

```bash
just ios-remote lint-swift
just ios-remote test-ios-native ThemeModeTests
just ios-remote test-ios-native-ui AppLaunchTests/testShellRendersWithoutWaitingForVaultBootstrap
just ios-remote test-ios-native-full
```

The native recipes own suite/class selection. A local `just check` proves the portable code;
it cannot run Swift or an iOS simulator. This command executes those missing checks on macOS.
The Linux runner in [remote testing](remote-testing.md) keeps its existing platform boundary.

## Host setup

Defaults match the maintainer's verified setup: SSH user is the local user, host is
`justins-macbook-pro`, and the source repository is `$HOME/Developer/futo-notes/futo-notes`.
Configure another Mac with `--host`, `--user`, and `--repo` before the recipe, or
`FUTO_IOS_REMOTE_HOST`, `FUTO_IOS_REMOTE_USER`, and `FUTO_IOS_REMOTE_REPO`.
The repository path is absolute or starts with `$HOME/` or `~/`.

```bash
just ios-remote --host another-mac --user developer --repo /Users/developer/notes test-ios-native ThemeModeTests
```

The Mac needs noninteractive SSH, Xcode/runtime, xcodegen, Python 3, Git, pnpm and the Node
version pinned by this checkout. The runner adds the pinned nvm directory, Homebrew,
Cargo and the user's bin directory to PATH. Missing prerequisites fail before copying source.
Use `tailscale status` and an explicit `ssh user@host true` to diagnose connectivity.

## Source and device isolation

Each local host/checkout gets one dedicated managed Mac worktree, created by `just wt new`.
Its path, local HEAD and immutable snapshot SHA-256 are printed. Unpublished commits travel
in a Git bundle. Tracked and untracked source files are captured; ignored outputs, caches
and local credentials are excluded. Edits after capture are for the next invocation.

A worktree-specific OS lock is held before source application and through builds, tests,
diagnostic collection and simulator release. A concurrent invocation exits 75 before
changing the source. Git metadata is updated with a mixed reset; source changes are applied
from an allowlisted archive, preserving generated caches and unrelated untracked files.
Only source files copied by earlier runs or present in the registered Git tree can be pruned.
Do not edit this managed checkout by hand; edit the Linux source and invoke the command again.

Tests claim a pooled simulator for that remote worktree and release the claim after the real
process exits. The local `SIM`, production paths and credentials are never forwarded.
`FUTO_IOS_FFI_PROFILE`, `FUTO_IOS_TEST_DIAGNOSTICS`, `IOS_TEXT_INPUT`, `IOS_STORY_FILTER`, and
`IOS_STORY_NO_RESTART` are forwarded literally. Cargo uses the remote worktree's own cache.
A green footer names the executed recipe and snapshot; a failed command keeps its exit code.

## Storage preflight

Native Rust builds inspect the actual target volume before compiling, using its closest
existing ancestor in a fresh worktree. The default minimum is 2 GiB; this is a floor, and a
cold build can need more. Set a positive `FUTO_IOS_MIN_FREE_GIB` for the planned workload.
The same preflight runs before the remote worktree's initial target clone.

A low-space error names the checked volume and target and points to `just wt gc --sizes`
for a dry-run inventory. Choose cleanup only after inspecting it. Shared Cargo caches,
production vaults and unrelated worktrees are never deleted by this command; expensive
cleanup still needs the approval required by the operating manual.
