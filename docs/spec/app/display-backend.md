## Display backend _(Linux desktop)_

- Packaged Linux builds run under XWayland on a Wayland session: when the user
  has not set `GDK_BACKEND`, the app sets `GDK_BACKEND=x11,wayland` before GTK
  starts, so X11 is tried first and native Wayland is the fallback for a
  session with no X server. WebKitGTK is GTK3, which on native Wayland renders
  only at whole-number scales: at a 1.6× display it draws at 2× and the
  compositor shrinks the window, softening every glyph; under XWayland (KDE
  "apply scaling themselves") it draws at the true scale. A user-selected
  backend is preserved, so `GDK_BACKEND=wayland` runs native Wayland. The
  AppImage launch hook sets the same order, replacing tauri-bundler's
  unconditional `GDK_BACKEND=x11` export that ignored the user's choice
  (upstream tauri#8541). `just tauri-dev` matches (X11 by default,
  `FUTO_DEV_WAYLAND=1` for Wayland). → `apps/tauri/src-tauri/src/platform_integration.rs`,
  `scripts/patch-appimage.mjs`, `scripts/patch-appimage.test.mjs`, `scripts/tauri-dev.mjs`
- The AppImage strips its bundled `libwayland-client.so.0` so native Wayland
  (the fallback, or a user's choice) uses the host library that matches host Mesa. WebKitGTK DMA-BUF rendering is
  disabled automatically when an NVIDIA DRM device or loaded NVIDIA kernel
  module is detected; Intel and AMD use the GPU renderer. An existing
  `WEBKIT_DISABLE_DMABUF_RENDERER` value is preserved, and
  `FUTO_NOTES_SOFTWARE_RENDER=1` forces the workaround when automatic detection
  misses while `FUTO_NOTES_SOFTWARE_RENDER=0` forces the GPU path despite NVIDIA
  detection. The hook rewrite, user override, and fallback order are guarded
  by `scripts/patch-appimage.test.mjs`. The stripped library was verified
  2026-07-22 on CachyOS/niri via socket-peer inspection, under the earlier
  Wayland-first order: the patched AppImage connected to
  `/run/user/1000/wayland-1` with no EGL abort. → `scripts/patch-appimage.mjs`,
  `apps/tauri/src-tauri/src/platform_integration.rs`
