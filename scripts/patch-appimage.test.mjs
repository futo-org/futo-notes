import { describe, expect, it } from 'vitest';

import { rewriteForcedGdkBackend } from './patch-appimage.mjs';

const FORCED_GDK_BACKEND =
  'export GDK_BACKEND=x11 # Crash with Wayland backend on Wayland - We tested it without it and ended up with this: https://github.com/tauri-apps/tauri/issues/8541';
const PREFERRED_GDK_BACKEND =
  'if [ -z "${GDK_BACKEND+x}" ]; then export GDK_BACKEND=wayland,x11; fi';
const TAURI_BUNDLER_GTK_HOOK =
  [
    '#! /usr/bin/env bash',
    '',
    'gsettings get org.gnome.desktop.interface gtk-theme 2> /dev/null | grep -qi "dark" && GTK_THEME_VARIANT="dark" || GTK_THEME_VARIANT="light"',
    'APPIMAGE_GTK_THEME="${APPIMAGE_GTK_THEME:-"Adwaita:$GTK_THEME_VARIANT"}" # Allow user to override theme (discouraged)',
    '',
    'export APPDIR="${APPDIR:-"$(dirname "$(realpath "$0")")"}" # Workaround to run extracted AppImage',
    'export GTK_DATA_PREFIX="$APPDIR"',
    'export GTK_THEME="$APPIMAGE_GTK_THEME" # Custom themes are broken',
    FORCED_GDK_BACKEND,
    'export XDG_DATA_DIRS="$APPDIR/usr/share:/usr/share:$XDG_DATA_DIRS" # g_get_system_data_dirs() from GLib',
  ].join('\n') + '\n';

describe('rewriteForcedGdkBackend', () => {
  it('replaces tauri-bundler forced X11 with a user-respecting Wayland preference', () => {
    const result = rewriteForcedGdkBackend(TAURI_BUNDLER_GTK_HOOK);

    expect(result).toEqual({
      text: TAURI_BUNDLER_GTK_HOOK.replace(FORCED_GDK_BACKEND, PREFERRED_GDK_BACKEND),
      changed: true,
      notFound: false,
    });
  });

  it('rewrites every forced line when the hook contains duplicates', () => {
    const duplicated = TAURI_BUNDLER_GTK_HOOK + '\n' + FORCED_GDK_BACKEND + '\n';

    const result = rewriteForcedGdkBackend(duplicated);

    expect(result.changed).toBe(true);
    expect(result.text).not.toContain(FORCED_GDK_BACKEND);
    expect(result.text.split(PREFERRED_GDK_BACKEND).length - 1).toBe(2);
  });

  it('leaves an already-rewritten hook byte-identical', () => {
    const rewrittenHook = TAURI_BUNDLER_GTK_HOOK.replace(FORCED_GDK_BACKEND, PREFERRED_GDK_BACKEND);

    expect(rewriteForcedGdkBackend(rewrittenHook)).toEqual({
      text: rewrittenHook,
      changed: false,
      notFound: false,
    });
  });

  it('reports an unrecognized hook so packaging can fail loudly', () => {
    const unrecognizedHook = '#! /usr/bin/env bash\nexport GTK_THEME="$APPIMAGE_GTK_THEME"\n';

    expect(rewriteForcedGdkBackend(unrecognizedHook)).toEqual({
      text: unrecognizedHook,
      changed: false,
      notFound: true,
    });
  });
});
