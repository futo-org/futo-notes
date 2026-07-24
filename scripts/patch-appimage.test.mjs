import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  appimagetoolExecutionPath,
  cleanAppImageOutput,
  ensureAppimagetool,
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

  it('does not accept the preferred command when it appears only in a comment', () => {
    const hook = [
      '#! /usr/bin/env bash',
      `# expected replacement: ${PREFERRED_GDK_BACKEND}`,
      'export GDK_BACKEND=wayland',
    ].join('\n');

    expect(rewriteForcedGdkBackend(hook)).toEqual({
      text: hook,
      changed: false,
      notFound: true,
    });
  });

  it('rejects an extra active backend assignment beside the preferred command', () => {
    const hook = [PREFERRED_GDK_BACKEND, 'export GDK_BACKEND=wayland'].join('\n');

    expect(rewriteForcedGdkBackend(hook)).toEqual({
      text: hook,
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

describe('preferred backend command', () => {
  function executePreferredBackend(environment) {
    return spawnSync('bash', ['-c', `${PREFERRED_GDK_BACKEND}; printf "%s" "$GDK_BACKEND"`], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, ...environment },
    });
  }

  it('prefers Wayland with X11 fallback when the user did not select a backend', () => {
    const result = executePreferredBackend({});

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('wayland,x11');
  });

  it('preserves a user-selected backend', () => {
    const result = executePreferredBackend({ GDK_BACKEND: 'x11' });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('x11');
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

  it('keeps the original artifact when extracted-directory cleanup fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'futo-appimage-cleanup-failure-test-'));
    const target = join(root, 'FUTO-Notes.AppImage');
    const extractDir = join(root, 'squashfs-root');
    let hasRepacked = false;
    try {
      await writeFile(target, 'unpatched');

      await expect(
        patchAppImage(target, {
          ensureTool: async () => '/pinned/appimagetool',
          execute(command, args) {
            if (command === target) {
              const hook = join(extractDir, 'apprun-hooks/linuxdeploy-plugin-gtk.sh');
              const library = join(extractDir, 'usr/lib/libwayland-client.so.0');
              mkdirSync(dirname(hook), { recursive: true });
              mkdirSync(dirname(library), { recursive: true });
              writeFileSync(hook, TAURI_BUNDLER_GTK_HOOK);
              writeFileSync(library, 'bundled');
              return;
            }

            writeFileSync(args[1], 'repacked');
            hasRepacked = true;
          },
          async removePath(path, options) {
            if (path === extractDir && hasRepacked) {
              throw new Error('injected cleanup failure');
            }
            await rm(path, options);
          },
        }),
      ).rejects.toThrow(/injected cleanup failure/);

      expect(readFileSync(target, 'utf8')).toBe('unpatched');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects tool bytes that do not match the pinned checksum', () => {
    expect(() => verifySha256(Buffer.from('downloaded bytes'), '0'.repeat(64))).toThrow(
      /appimagetool checksum mismatch/,
    );
  });

  it('opens verified tool bytes once and reuses only a checksum-valid cache entry', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'futo-appimagetool-cache-test-'));
    const bytes = Buffer.from('verified appimagetool fixture');
    const expectedSha256 = createHash('sha256').update(bytes).digest('hex');
    let downloads = 0;
    const fetchImpl = async () => {
      downloads += 1;
      return {
        ok: true,
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    };
    const options = {
      cacheDir,
      expectedSha256,
      fetchImpl,
      toolName: 'appimagetool-test',
      url: 'https://example.invalid/appimagetool',
    };
    try {
      const downloaded = await ensureAppimagetool(options);
      await downloaded.close();
      const cached = await ensureAppimagetool({
        ...options,
        fetchImpl: async () => {
          throw new Error('valid cache should not redownload');
        },
      });
      await cached.close();
      expect(downloads).toBe(1);

      await writeFile(join(cacheDir, 'appimagetool-test'), 'tampered');
      await expect(ensureAppimagetool(options)).rejects.toThrow(/appimagetool checksum mismatch/);
      expect(downloads).toBe(1);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'linux')(
    'executes the verified open tool descriptor instead of reopening its pathname',
    async () => {
      const cacheDir = await mkdtemp(join(tmpdir(), 'futo-appimagetool-execution-test-'));
      const bytes = await readFile('/bin/true');
      const expectedSha256 = createHash('sha256').update(bytes).digest('hex');
      try {
        const tool = await ensureAppimagetool({
          cacheDir,
          expectedSha256,
          fetchImpl: async () => ({
            ok: true,
            arrayBuffer: async () =>
              bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          }),
          toolName: 'verified-tool',
          url: 'https://example.invalid/verified-tool',
        });
        try {
          const result = spawnSync(appimagetoolExecutionPath(tool));
          expect(result.status, result.stderr?.toString()).toBe(0);
        } finally {
          await tool.close();
        }
      } finally {
        await rm(cacheDir, { recursive: true, force: true });
      }
    },
  );

  it('removes cached AppImage output before a new bundle build', async () => {
    const root = await mkdtemp(join(tmpdir(), 'futo-appimage-output-test-'));
    const output = join(root, 'target/release/bundle/appimage');
    try {
      await mkdir(output, { recursive: true });
      await writeFile(join(output, 'FUTO-Notes-old.AppImage'), 'stale');

      await cleanAppImageOutput(output);

      expect(existsSync(output)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses to clean a directory broader than the generated AppImage output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'futo-appimage-clean-safety-test-'));
    try {
      await expect(cleanAppImageOutput(root)).rejects.toThrow(
        /refusing to clean non-AppImage output directory/,
      );
      expect(existsSync(root)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
