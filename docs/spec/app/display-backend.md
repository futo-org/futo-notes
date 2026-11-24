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
- Under XWayland the app draws at the compositor's display scale even when the
  desktop publishes the wrong one to X11 apps (KDE with "apply scaling
  themselves" can publish 96 DPI on a 1.6× display, which drew the app at 1×).
  Before GTK draws, the app compares the scale X11 would give (GTK's window
  scale × font DPI ÷ 96) with the largest display scale the compositor reports
  (xdg-output logical size against the current mode) and, when they differ by
  2% or more, starts itself again with `GDK_DPI_SCALE` making up the
  difference. A user-set `GDK_SCALE` or `GDK_DPI_SCALE` turns this off. Under
  any X11 display the configured window size and minimum are CSS sizes, so
  they grow by the font-DPI factor: the first window at 1.6× is 1200×800 CSS
  pixels. One scale serves every display, as for any X11 app.
  Verified 2026-11-24 on KDE Plasma 6, one 3840×2160 display at 1.6× publishing
  96 DPI: `devicePixelRatio` 1.5999959707260132, a fresh window 1200×800 CSS
  pixels. → `apps/tauri/src-tauri/src/platform_integration/xwayland_scale.rs`,
  `apps/tauri/src-tauri/src/platform_integration.rs`
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
