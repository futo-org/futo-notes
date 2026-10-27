# Native iOS checks from Linux

Use `just ios-remote` to run current source on a Mac without manually creating a checkout,
copying changed files, or constructing Xcode filters:

```bash
just ios-remote lint-swift
just ios-remote test-ios-native ThemeModeTests
just ios-remote test-ios-native-ui AppLaunchTests/testShellRendersWithoutWaitingForVaultBootstrap
just ios-remote test-ios-native-full
```

Recipes, selectors and prerequisites: [iOS manual](../apps/ios/AGENTS.md).
`just ios-remote --help` lists supported recipes, host/user/repository defaults and overrides.
The Mac needs noninteractive SSH and the checkout's pinned Node; the runner adds its nvm,
Homebrew, Cargo and user-bin paths, and checks prerequisites before copying source.
Use `tailscale status` and `ssh user@host true` for connectivity; portable checks stay on
[the Linux runner](remote-testing.md).

## Source and device isolation

Each local host/checkout gets one dedicated managed Mac worktree, created by
`just wt new <name> --no-target`, with its own cold Cargo cache.
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
The same preflight runs before creating the remote worktree.

A low-space error names the checked volume and target and points to `just wt gc --sizes`
for a dry-run inventory. Choose cleanup only after inspecting it. Shared Cargo caches,
production vaults and unrelated worktrees are never deleted by this command; expensive
cleanup still needs the approval required by the operating manual.
