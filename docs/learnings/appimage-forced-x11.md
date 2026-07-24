# AppImage forced-X11 packaging divergence

Date: 2026-07-21

## Summary

The shipped AppImage opened under XWayland on an Arch/CachyOS Wayland session,
while local development and Fedora RPM installs opened with native Wayland. An
AUR package reproduced the problem because it repackaged the AppImage; the AUR
recipe was not the source of the backend choice.

The class of bug is launch-environment divergence: a generated packaging hook
changed process environment before the application started, while development
recipes explicitly selected Wayland and therefore never exercised the shipped
default.

## Root cause

tauri-bundler 2.9.4 vendors `linuxdeploy-plugin-gtk.sh`. During AppImage
creation, that plugin writes `apprun-hooks/linuxdeploy-plugin-gtk.sh` with an
unconditional `export GDK_BACKEND=x11`, citing tauri#8541. The hook runs before
the FUTO Notes binary, forces GTK onto X11, and overwrites a user-provided
`GDK_BACKEND`.

Nothing in tao, wry, Tauri, or the FUTO Notes Rust process setup independently
forced X11. A clean debug-binary launch used the session's Wayland socket, and
deb/rpm packages used system GTK's native Wayland selection. Fedora appeared
different because the reported install was an RPM and therefore had no
AppImage launch hook.

The upstream X11 force avoided an EGL/libwayland mismatch seen in generic
AppImages. FUTO Notes already fixes that failure in its post-bundle pass by
removing the Ubuntu-build-base `libwayland-client.so.0`; the host then supplies
matching libwayland and Mesa libEGL libraries. The forced backend could safely
be relaxed only because both changes ship in the same AppImage patch pass.

## Why development did not reproduce it

The `tauri-dev` and `tauri-prod` recipes explicitly export
`WINIT_UNIX_BACKEND=wayland` and `GDK_BACKEND=wayland`. Test launch helpers do
the same for determinism. Those exports are appropriate for development, but
they bypass GTK's default selection and completely mask environment changes
made only by a packaged launcher.

When a packaged application behaves differently from a development binary,
compare the entire launch chain before changing application code: desktop
files, AppRun, generated hooks, wrappers, sandbox launchers, and package-manager
scripts can all mutate environment or library lookup paths.

## Diagnosis method

Backend logs and environment variables are hints, not proof. The decisive check
was the running process's Unix-socket peers:

1. Launch the binary or AppImage with `GDK_BACKEND` removed and record its PID.
2. Map its `socket:[inode]` file descriptors under `/proc/<pid>/fd` to Unix
   sockets reported by `ss -xap`.
3. A peer at `/run/user/<uid>/wayland-*` proves a native Wayland connection; a
   peer at `@/tmp/.X11-unix/X*` proves X11/XWayland.
4. Repeat with the unpackaged binary and every shipped package format before
   assigning ownership to application code or to a downstream package.

After isolating the problem to the AppImage, searching the cargo registry for
`GDK_BACKEND` found the forced export in tauri-bundler's vendored
`linuxdeploy-plugin-gtk.sh`. Inspecting the extracted AppImage confirmed the
same line in `apprun-hooks/linuxdeploy-plugin-gtk.sh`.

## Fix and guardrails

`scripts/patch-appimage.mjs` now rewrites the exact generated line to set
`GDK_BACKEND=wayland,x11` only when the variable is unset. This prefers native
Wayland, retains X11 fallback when Wayland cannot connect, and restores explicit
user control.

The rewrite is a pure, unit-tested function. An absent hook or an unrecognized
forced-backend line fails the build instead of silently shipping XWayland after
a future tauri-bundler change. The release builder also fails if the patch
script is missing. Repacking still precedes updater signing, so the detached
`.sig` remains the last touch on artifact bytes.

## Lessons

- Test packaged launchers, not only the underlying executable, for display,
  sandbox, library, and environment behavior.
- A downstream package that republishes an upstream artifact also republishes
  that artifact's launch hooks and bundled-library decisions.
- Search generated packaging inputs in dependency registries when runtime code
  contains no owner for an observed environment value.
- Turn post-bundle assumptions into loud assertions; a successful build that
  skipped its required patch is not a successful release build.
