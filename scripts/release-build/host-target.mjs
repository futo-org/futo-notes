// Which bundle, output directory and file suffix the host OS produces as its updater artifact.
import { join } from 'node:path';

import { ROOT, die } from './profiles.mjs';

// ── Per-OS updater artifact shape ────────────────────────────────────────────
// The updater artifact is NOT always the installer you distribute: Linux ships
// the AppImage (deb/rpm self-update via the system repo); macOS the app.tar.gz
// (not the .dmg); Windows the NSIS setup.exe.
export function hostTarget(platform = process.platform, arch = process.arch) {
  const a = arch === 'arm64' ? 'aarch64' : 'x86_64';
  switch (platform) {
    case 'linux':
      // x86_64 only — we don't ship a linux-aarch64 AppImage (and that key isn't
      // in the manifest's KNOWN_PLATFORMS).
      return {
        platform: 'linux-x86_64',
        bundle: 'appimage',
        dir: join(ROOT, 'target', 'release', 'bundle', 'appimage'),
        suffix: '.AppImage',
        patchAppImage: true,
      };
    case 'darwin':
      return {
        platform: `darwin-${a}`,
        bundle: 'app',
        dir: join(ROOT, 'target', 'release', 'bundle', 'macos'),
        suffix: '.app.tar.gz',
        patchAppImage: false,
      };
    case 'win32':
      return {
        platform: `windows-${a}`,
        bundle: 'nsis',
        dir: join(ROOT, 'target', 'release', 'bundle', 'nsis'),
        suffix: '-setup.exe',
        patchAppImage: false,
      };
    default:
      return die(`unsupported platform: ${platform}`);
  }
}
