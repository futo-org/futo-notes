## Display backend _(Linux desktop)_

- Packaged Linux builds use native Wayland when the session provides it. The
  AppImage launch hook sets `GDK_BACKEND=wayland,x11` only when the user has not
  set `GDK_BACKEND`, replacing tauri-bundler's unconditional X11 export that
  opened the AppImage (and AUR packages derived from it) under XWayland (#14,
  upstream tauri#8541). A user-selected backend is preserved. Debian and RPM
  packages follow the system GTK backend selection. →
  `scripts/patch-appimage.mjs`, `scripts/patch-appimage.test.mjs`
- The AppImage strips its bundled `libwayland-client.so.0` so native Wayland
  uses the host library that matches host Mesa. WebKitGTK DMA-BUF rendering is
  disabled automatically when an NVIDIA DRM device or loaded NVIDIA kernel
  module is detected; Intel and AMD use the GPU renderer. An existing
  `WEBKIT_DISABLE_DMABUF_RENDERER` value is preserved, and
  `FUTO_NOTES_SOFTWARE_RENDER=1` forces the workaround when automatic detection
  misses while `FUTO_NOTES_SOFTWARE_RENDER=0` forces the GPU path despite NVIDIA
  detection. Diagnosis verified 2026-07-21 on CachyOS/niri: the unpatched
  AppImage connected through XWayland while the unpackaged binary connected to
  `wayland-1`. The hook rewrite, user override, and X11 fallback policy are
  guarded by `scripts/patch-appimage.test.mjs`. Packaged runtime verified
  2026-07-22 on CachyOS/niri via socket-peer inspection: unpatched AppImage →
  `@/tmp/.X11-unix/X1` (XWayland); patched AppImage → `/run/user/1000/wayland-1`
  with no EGL abort; `GDK_BACKEND=x11` override honored; with `WAYLAND_DISPLAY`
  unset the `wayland,x11` list falls back to X11 and launches. →
  `scripts/patch-appimage.mjs`, `apps/tauri/src-tauri/src/main.rs`,
  `apps/tauri/src-tauri/src/platform_integration.rs`
