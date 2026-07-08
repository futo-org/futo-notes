#!/usr/bin/env node
// Strip incompatible bundled libs from a Tauri AppImage so it boots on Mesa 26
// (CachyOS / Arch / Fedora 40+).
//
// Background: linuxdeploy copies `libwayland-client.so.0` from the build base
// into the AppImage. At runtime the *host* provides libEGL (Mesa 26). Mesa 26
// needs a libwayland-client whose ABI matches the host's libEGL, but the copy
// pulled from the Ubuntu build base doesn't — so
// `eglGetPlatformDisplay(EGL_PLATFORM_WAYLAND_KHR, …)` fails and WebKit aborts
// with "Could not create default EGL display: EGL_BAD_PARAMETER. Aborting…"
// before rendering anything. Reproduced against v1.2.0 on CachyOS (Mesa 26).
//
// Deleting the bundled copy lets the ld.so loader pick up the host's
// libwayland-client, which always matches the host's libEGL because they ship
// together. All distros we target (Ubuntu 22.04+, Debian 12+, Fedora 40+,
// Arch, CachyOS) provide a compatible libwayland-client in the default
// library path.
//
// This only applies to Linux AppImages. .deb / .rpm link against the host
// webkit2gtk + libwayland and never had this problem.
//
// Usage:
//   node scripts/patch-appimage-mesa26.mjs <path/to/FUTO-Notes-x.y.z-x86_64.AppImage>
//   node scripts/patch-appimage-mesa26.mjs --dir target/release/bundle/appimage

import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, readdirSync, statSync } from 'node:fs';
import { chmod, mkdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// Bundled libs that break on modern Mesa when mixed with host libEGL. We
// delete these from the AppDir so the host copies are used instead.
const LIBS_TO_STRIP = [
  'libwayland-client.so.0',
  // Keep the rest for now — only libwayland-client.so.0 is load-bearing for
  // the EGL_BAD_PARAMETER failure. If we see further breakage on newer Mesa,
  // extend this list (libwayland-egl.so.1, libwayland-cursor.so.0,
  // libwayland-server.so.0 are the next candidates).
];

function log(msg) {
  console.log(`[patch-appimage] ${msg}`);
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} → exit ${res.status}`);
  }
}

function findAppImage(dirPath) {
  const entries = readdirSync(dirPath)
    .filter((f) => f.toLowerCase().endsWith('.appimage'))
    .map((f) => join(dirPath, f));
  if (entries.length === 0) throw new Error(`no .AppImage in ${dirPath}`);
  if (entries.length > 1) {
    throw new Error(
      `multiple .AppImage files in ${dirPath}; pass one explicitly:\n  ${entries.join('\n  ')}`,
    );
  }
  return entries[0];
}

async function downloadAppimagetool() {
  // Ubuntu doesn't package appimagetool; fetch the upstream continuous build.
  const url =
    'https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage';
  const cacheDir = join(tmpdir(), 'futo-notes-appimagetool');
  await mkdir(cacheDir, { recursive: true });
  const target = join(cacheDir, 'appimagetool');
  if (existsSync(target)) return target;
  log(`downloading appimagetool from ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
  const out = createWriteStream(target);
  await new Promise((done, fail) => {
    const body = res.body;
    body.pipeTo(
      new WritableStream({
        write(chunk) {
          return new Promise((r, rj) => {
            out.write(chunk, (err) => (err ? rj(err) : r()));
          });
        },
        close() {
          out.end(done);
        },
        abort(err) {
          out.destroy(err);
          fail(err);
        },
      }),
    );
  });
  await chmod(target, 0o755);
  return target;
}

async function ensureAppimagetool() {
  const candidates = [process.env.APPIMAGETOOL].filter(Boolean);
  for (const dir of (process.env.PATH || '').split(':')) {
    if (dir) candidates.push(join(dir, 'appimagetool'));
  }
  candidates.push('/usr/local/bin/appimagetool', '/usr/bin/appimagetool');
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return downloadAppimagetool();
}

async function main() {
  const args = process.argv.slice(2);
  let targetPath = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--dir') {
      const dir = args[i + 1];
      if (!dir) throw new Error('--dir requires a path');
      targetPath = findAppImage(resolve(dir));
      i += 1;
    } else if (!args[i].startsWith('-')) {
      targetPath = resolve(args[i]);
    }
  }
  if (!targetPath) {
    console.error('usage: node scripts/patch-appimage-mesa26.mjs <appimage> | --dir <bundle_dir>');
    process.exit(2);
  }
  if (!existsSync(targetPath)) throw new Error(`not found: ${targetPath}`);

  log(`patching ${targetPath}`);
  const workDir = dirname(targetPath);
  const extractDir = join(workDir, 'squashfs-root');
  if (existsSync(extractDir)) await rm(extractDir, { recursive: true, force: true });

  await chmod(targetPath, 0o755);

  run(targetPath, ['--appimage-extract'], {
    cwd: workDir,
    stdio: 'pipe',
    env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' },
  });
  if (!existsSync(extractDir)) {
    throw new Error(`extraction did not produce ${extractDir}`);
  }

  let stripped = 0;
  for (const lib of LIBS_TO_STRIP) {
    const libPath = join(extractDir, 'usr', 'lib', lib);
    if (existsSync(libPath)) {
      await rm(libPath);
      stripped += 1;
      log(`removed usr/lib/${lib}`);
    } else {
      log(`skipped usr/lib/${lib} (not present)`);
    }
  }
  if (stripped === 0) {
    log('nothing to strip — leaving original AppImage in place');
    await rm(extractDir, { recursive: true, force: true });
    return;
  }

  const appimagetool = await ensureAppimagetool();
  log(`repacking with ${appimagetool}`);
  const tmpOut = `${targetPath}.patched`;
  if (existsSync(tmpOut)) await rm(tmpOut);
  // ARCH=x86_64 is required when running appimagetool without a .DirIcon arch hint.
  // APPIMAGE_EXTRACT_AND_RUN=1 lets appimagetool (itself an AppImage) work in
  // containers / sandboxes that don't have fusermount (e.g. ubuntu:22.04 CI image).
  run(appimagetool, [extractDir, tmpOut], {
    cwd: workDir,
    env: { ...process.env, ARCH: 'x86_64', APPIMAGE_EXTRACT_AND_RUN: '1' },
  });

  await rm(targetPath);
  await rm(extractDir, { recursive: true, force: true });
  // Rename .patched → original filename so downstream release jobs pick it up.
  await rename(tmpOut, targetPath);
  await chmod(targetPath, 0o755);
  log(`done: ${targetPath}`);
}

main().catch((err) => {
  console.error(`[patch-appimage] FAILED: ${err.message}`);
  process.exit(1);
});
