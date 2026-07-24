import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  patchAppImage,
  rewriteForcedGdkBackend,
  stripBundledWaylandClients,
  verifySha256,
} from './patch-appimage.mjs';

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

  it('rewrites quoted and whitespace-varied forced X11 assignments', () => {
    const variants = [
      'GDK_BACKEND = "x11"',
      "export GDK_BACKEND='x11'",
      '  export   GDK_BACKEND = x11  # generated hook',
    ].join('\n');

    const result = rewriteForcedGdkBackend(variants);

    expect(result.changed).toBe(true);
    expect(result.notFound).toBe(false);
    expect(result.text).not.toMatch(/GDK_BACKEND\s*=\s*["']?x11["']?/);
    expect(result.text.split(PREFERRED_GDK_BACKEND)).toHaveLength(4);
  });
});

describe('stripBundledWaylandClients', () => {
  it('removes every bundled client library regardless of AppDir location', async () => {
    const root = await mkdtemp(join(tmpdir(), 'futo-appimage-test-'));
    const paths = [
      join(root, 'usr/lib/libwayland-client.so.0'),
      join(root, 'usr/lib/x86_64-linux-gnu/libwayland-client.so.0.22.0'),
      join(root, 'lib/libwayland-client.so.0'),
    ];
    try {
      for (const path of paths) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, 'bundled');
      }

      const removed = await stripBundledWaylandClients(root);

      expect(removed.sort()).toEqual(paths.sort());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('AppImage patch orchestration', () => {
  it('extracts, rewrites, strips, and repacks without exposing signing secrets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'futo-appimage-flow-test-'));
    const target = join(root, 'FUTO-Notes.AppImage');
    const childEnvironments = [];
    try {
      await writeFile(target, 'unpatched');

      await patchAppImage(target, {
        environment: {
          PATH: '/usr/bin',
          TAURI_SIGNING_PRIVATE_KEY: 'production-secret',
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'production-password',
        },
        ensureTool: async () => '/pinned/appimagetool',
        execute(command, args, options) {
          childEnvironments.push(options.env);
          if (command === target) {
            const hook = join(root, 'squashfs-root/apprun-hooks/linuxdeploy-plugin-gtk.sh');
            const library = join(root, 'squashfs-root/usr/lib/libwayland-client.so.0');
            mkdirSync(dirname(hook), { recursive: true });
            mkdirSync(dirname(library), { recursive: true });
            writeFileSync(hook, TAURI_BUNDLER_GTK_HOOK);
            writeFileSync(library, 'bundled');
            return;
          }

          expect(command).toBe('/pinned/appimagetool');
          const extractDir = args[0];
          const hook = readFileSync(
            join(extractDir, 'apprun-hooks/linuxdeploy-plugin-gtk.sh'),
            'utf8',
          );
          expect(hook).toContain(PREFERRED_GDK_BACKEND);
          expect(hook).not.toContain(FORCED_GDK_BACKEND);
          expect(existsSync(join(extractDir, 'usr/lib/libwayland-client.so.0'))).toBe(false);
          writeFileSync(args[1], 'repacked');
        },
      });

      expect(readFileSync(target, 'utf8')).toBe('repacked');
      expect(childEnvironments).toHaveLength(2);
      for (const environment of childEnvironments) {
        expect(environment.PATH).toBe('/usr/bin');
        expect(environment.TAURI_SIGNING_PRIVATE_KEY).toBeUndefined();
        expect(environment.TAURI_SIGNING_PRIVATE_KEY_PASSWORD).toBeUndefined();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects tool bytes that do not match the pinned checksum', () => {
    expect(() => verifySha256(Buffer.from('downloaded bytes'), '0'.repeat(64))).toThrow(
      /appimagetool checksum mismatch/,
    );
  });
});
