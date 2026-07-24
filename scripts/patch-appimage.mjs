#!/usr/bin/env node
// Patch Tauri AppImages for modern Wayland hosts (CachyOS / Arch / Fedora 40+).
//
// 1. linuxdeploy copies `libwayland-client.so.0` from the build base into the
// AppImage. At runtime the *host* provides libEGL (Mesa 26). Mesa 26 needs a
// libwayland-client whose ABI matches the host's libEGL, but the Ubuntu copy
// doesn't — so
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
// 2. tauri-bundler 2.9.4 generates an AppRun GTK hook that unconditionally
// exports GDK_BACKEND=x11 because of tauri-apps/tauri#8541. That puts AppImages
// under XWayland and overrides explicit user choices. Work item #14 verified
// that deb/rpm installs already follow the system GTK backend. Since the
// incompatible bundled Wayland library is removed above, prefer Wayland with
// an X11 fallback when the user has not selected a backend.
//
// This only applies to Linux AppImages. .deb / .rpm link against the host
// webkit2gtk + libwayland and never had this problem.
//
// Usage:
//   node scripts/patch-appimage.mjs <path/to/FUTO-Notes-x.y.z-x86_64.AppImage>
//   node scripts/patch-appimage.mjs --dir target/release/bundle/appimage

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const FORCED_GDK_BACKEND =
  'export GDK_BACKEND=x11 # Crash with Wayland backend on Wayland - We tested it without it and ended up with this: https://github.com/tauri-apps/tauri/issues/8541';
const PREFERRED_GDK_BACKEND =
  'if [ -z "${GDK_BACKEND+x}" ]; then export GDK_BACKEND=wayland,x11; fi';
const FORCED_GDK_BACKEND_PATTERN =
  /^[ \t]*(?:export[ \t]+)?GDK_BACKEND[ \t]*=[ \t]*(?:"x11"|'x11'|x11)[ \t]*(?:#.*)?$/gm;
const WAYLAND_CLIENT_LIBRARY_PATTERN = /^libwayland-client\.so(?:\.|$)/;
const APPIMAGETOOL_VERSION = '1.9.1';
const APPIMAGETOOL_SHA256 = 'ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0';
const APPIMAGETOOL_URL = `https://github.com/AppImage/appimagetool/releases/download/${APPIMAGETOOL_VERSION}/appimagetool-x86_64.AppImage`;

export function rewriteForcedGdkBackend(hookText) {
  if (FORCED_GDK_BACKEND_PATTERN.test(hookText)) {
    FORCED_GDK_BACKEND_PATTERN.lastIndex = 0;
    return {
      text: hookText.replaceAll(FORCED_GDK_BACKEND_PATTERN, PREFERRED_GDK_BACKEND),
      changed: true,
      notFound: false,
    };
  }
  if (hookText.includes(PREFERRED_GDK_BACKEND)) {
    return { text: hookText, changed: false, notFound: false };
  }
  return { text: hookText, changed: false, notFound: true };
}

export async function stripBundledWaylandClients(extractDir) {
  // Remove every bundled ABI/link name from the AppDir so a relocated copy
  // cannot silently defeat the host-library fallback.
  const removed = [];
  const pending = [extractDir];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (WAYLAND_CLIENT_LIBRARY_PATTERN.test(entry.name)) {
        await rm(path);
        removed.push(path);
      }
    }
  }
  return removed;
}

function log(msg) {
  console.log(`[patch-appimage] ${msg}`);
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} → exit ${res.status}`);
  }
}

function childEnvironment(environment, overrides = {}) {
  const child = { ...environment, ...overrides };
  delete child.TAURI_SIGNING_PRIVATE_KEY;
  delete child.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  return child;
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

export function verifySha256(bytes, expected) {
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) {
    throw new Error(`appimagetool checksum mismatch: expected ${expected}, received ${actual}`);
  }
}

async function ensureAppimagetool() {
  // Ubuntu doesn't package appimagetool. Use one immutable release asset and
  // verify its bytes before either caching or executing it.
  const cacheDir = join(tmpdir(), 'futo-notes-appimagetool');
  await mkdir(cacheDir, { recursive: true });
  const target = join(cacheDir, `appimagetool-${APPIMAGETOOL_VERSION}`);
  if (existsSync(target)) {
    const cached = await readFile(target);
    verifySha256(cached, APPIMAGETOOL_SHA256);
    return target;
  }

  log(`downloading pinned appimagetool ${APPIMAGETOOL_VERSION} from ${APPIMAGETOOL_URL}`);
  const res = await fetch(APPIMAGETOOL_URL, { redirect: 'follow' });
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  verifySha256(bytes, APPIMAGETOOL_SHA256);
  const download = `${target}.${process.pid}.download`;
  await writeFile(download, bytes);
  await chmod(download, 0o755);
  await rename(download, target);
  return target;
}

export async function patchAppImage(
  targetPath,
  { environment = process.env, ensureTool = ensureAppimagetool, execute = run } = {},
) {
  if (!existsSync(targetPath)) throw new Error(`not found: ${targetPath}`);

  log(`patching ${targetPath}`);
  const workDir = dirname(targetPath);
  const extractDir = join(workDir, 'squashfs-root');
  if (existsSync(extractDir)) await rm(extractDir, { recursive: true, force: true });

  await chmod(targetPath, 0o755);

  execute(targetPath, ['--appimage-extract'], {
    cwd: workDir,
    stdio: 'pipe',
    env: childEnvironment(environment, { APPIMAGE_EXTRACT_AND_RUN: '1' }),
  });
  if (!existsSync(extractDir)) {
    throw new Error(`extraction did not produce ${extractDir}`);
  }

  const stripped = await stripBundledWaylandClients(extractDir);
  for (const path of stripped) {
    log(`removed ${path.slice(extractDir.length + 1)}`);
  }
  if (stripped.length === 0) {
    log('no bundled libwayland-client copies found');
  }

  const gtkHookPath = join(extractDir, 'apprun-hooks', 'linuxdeploy-plugin-gtk.sh');
  if (!existsSync(gtkHookPath)) {
    throw new Error(
      `GTK launch hook missing at ${gtkHookPath}; expected line: ${FORCED_GDK_BACKEND}`,
    );
  }
  const gtkHook = await readFile(gtkHookPath, 'utf8');
  const rewrittenHook = rewriteForcedGdkBackend(gtkHook);
  if (rewrittenHook.notFound) {
    throw new Error(
      `GTK launch hook did not contain the expected forced backend line: ${FORCED_GDK_BACKEND}`,
    );
  }
  if (rewrittenHook.changed) {
    await writeFile(gtkHookPath, rewrittenHook.text);
    log('rewrote GTK launch hook to prefer Wayland and respect GDK_BACKEND');
  } else {
    log('GTK launch hook already prefers Wayland and respects GDK_BACKEND');
  }

  if (stripped.length === 0 && !rewrittenHook.changed) {
    log('AppImage already patched — leaving original in place');
    await rm(extractDir, { recursive: true, force: true });
    return;
  }

  const appimagetool = await ensureTool();
  log(`repacking with ${appimagetool}`);
  const tmpOut = `${targetPath}.patched`;
  if (existsSync(tmpOut)) await rm(tmpOut);
  // ARCH=x86_64 is required when running appimagetool without a .DirIcon arch hint.
  // APPIMAGE_EXTRACT_AND_RUN=1 lets appimagetool (itself an AppImage) work in
  // containers / sandboxes that don't have fusermount (e.g. ubuntu:22.04 CI image).
  execute(appimagetool, [extractDir, tmpOut], {
    cwd: workDir,
    env: childEnvironment(environment, {
      ARCH: 'x86_64',
      APPIMAGE_EXTRACT_AND_RUN: '1',
    }),
  });

  await rm(targetPath);
  await rm(extractDir, { recursive: true, force: true });
  // Rename .patched → original filename so downstream release jobs pick it up.
  await rename(tmpOut, targetPath);
  await chmod(targetPath, 0o755);
  log(`done: ${targetPath}`);
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
    console.error('usage: node scripts/patch-appimage.mjs <appimage> | --dir <bundle_dir>');
    process.exit(2);
  }
  await patchAppImage(targetPath);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[patch-appimage] FAILED: ${err.message}`);
    process.exit(1);
  });
}
