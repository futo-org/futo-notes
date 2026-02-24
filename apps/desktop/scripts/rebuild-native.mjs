/**
 * Rebuild native modules (better-sqlite3, sqlite-vec) for Electron.
 *
 * Problem: In npm workspaces, native modules are hoisted to the root
 * node_modules/. The server needs them compiled for Node.js, the desktop
 * needs them compiled for Electron. They can't share one binary.
 *
 * Solution: Copy the native modules into apps/desktop/node_modules/ and
 * rebuild them there for Electron using node-gyp. The desktop's Electron
 * process resolves from its local node_modules/ first (Node module
 * resolution order), so it picks up the Electron-compatible binary.
 * The server continues using the root copy compiled for Node.js.
 */
import { execSync } from 'child_process';
import { cpSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopDir = join(__dirname, '..');
const rootDir = join(desktopDir, '..', '..');
const localModules = join(desktopDir, 'node_modules');

// Read Electron version from package.json
const pkg = JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf8'));
const electronVersion = pkg.devDependencies.electron.replace(/^\^/, '');

const nativeModules = ['better-sqlite3', 'sqlite-vec'];

mkdirSync(localModules, { recursive: true });

for (const mod of nativeModules) {
  const src = join(rootDir, 'node_modules', mod);
  const dest = join(localModules, mod);

  if (!existsSync(src)) {
    console.log(`  skip ${mod} (not in root node_modules)`);
    continue;
  }

  // Copy the module to local node_modules
  cpSync(src, dest, { recursive: true, dereference: true });

  // Check if it has native code to rebuild
  const binding = join(dest, 'binding.gyp');
  if (!existsSync(binding)) {
    console.log(`  ${mod} copied (no native code)`);
    continue;
  }

  // Rebuild for Electron
  console.log(`  ${mod} rebuilding for Electron ${electronVersion}...`);
  try {
    execSync(
      `npx node-gyp rebuild --target=${electronVersion} --dist-url=https://electronjs.org/headers --runtime=electron`,
      { cwd: dest, stdio: 'pipe' },
    );
    console.log(`  ${mod} rebuilt OK`);
  } catch (err) {
    console.error(`  ${mod} rebuild FAILED:`, err.stderr?.toString().slice(-200));
    process.exit(1);
  }
}

console.log('Native modules ready for Electron.');
