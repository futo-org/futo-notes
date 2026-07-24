import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TAURI_CONF = resolve(ROOT, 'apps', 'tauri', 'src-tauri', 'tauri.conf.json');
export const TAURI_CARGO_TOML = resolve(ROOT, 'apps', 'tauri', 'src-tauri', 'Cargo.toml');

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function assertSemver(version) {
  if (typeof version !== 'string' || !SEMVER_RE.test(version)) {
    throw new Error(
      `invalid desktop version: ${JSON.stringify(version)} (expected semver like 1.6.0)`,
    );
  }
}

export function readTauriConfigVersion(confPath = TAURI_CONF) {
  return JSON.parse(readFileSync(confPath, 'utf8')).version;
}

export function resolveCiDesktopVersion(commitTag, confPath = TAURI_CONF) {
  const version = commitTag ? commitTag.replace(/^v/, '') : readTauriConfigVersion(confPath);
  assertSemver(version);
  return version;
}

export function setTauriConfigVersion(version, confPath = TAURI_CONF) {
  assertSemver(version);
  const conf = JSON.parse(readFileSync(confPath, 'utf8'));
  if (conf.version === version) return false;
  conf.version = version;
  writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n');
  return true;
}

function packageSectionBounds(toml, cargoPath) {
  const lines = toml.split(/(?<=\n)/);
  let offset = 0;
  let start = -1;
  let end = toml.length;
  for (const line of lines) {
    if (start === -1) {
      if (/^\[package\]\s*$/.test(line.trimEnd())) start = offset;
    } else if (/^\[/.test(line)) {
      end = offset;
      break;
    }
    offset += line.length;
  }
  if (start === -1) throw new Error(`could not find [package] section in ${cargoPath}`);
  return { start, end };
}

export function readTauriCargoVersion(cargoPath = TAURI_CARGO_TOML) {
  const toml = readFileSync(cargoPath, 'utf8');
  const { start, end } = packageSectionBounds(toml, cargoPath);
  const version = toml.slice(start, end).match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
  if (!version) throw new Error(`could not read [package] version from ${cargoPath}`);
  return version;
}

export function setTauriCargoVersion(version, cargoPath = TAURI_CARGO_TOML) {
  assertSemver(version);
  const toml = readFileSync(cargoPath, 'utf8');
  const { start, end } = packageSectionBounds(toml, cargoPath);
  const packageSection = toml.slice(start, end);
  let replaced = false;
  const nextPackageSection = packageSection.replace(
    /^version\s*=\s*"([^"]+)"\s*$/m,
    (line, current) => {
      replaced = true;
      return current === version ? line : `version = "${version}"`;
    },
  );
  if (!replaced) throw new Error(`could not find [package] version in ${cargoPath}`);
  if (nextPackageSection === packageSection) return false;
  writeFileSync(cargoPath, toml.slice(0, start) + nextPackageSection + toml.slice(end));
  return true;
}

export function readDesktopVersions(paths = {}) {
  return {
    tauriConfig: readTauriConfigVersion(paths.confPath),
    cargoPackage: readTauriCargoVersion(paths.cargoPath),
  };
}

export function setDesktopVersion(version, paths = {}) {
  assertSemver(version);
  return {
    tauriConfig: setTauriConfigVersion(version, paths.confPath),
    cargoPackage: setTauriCargoVersion(version, paths.cargoPath),
  };
}

export function restoreDesktopVersions(versions, paths = {}) {
  setTauriConfigVersion(versions.tauriConfig, paths.confPath);
  setTauriCargoVersion(versions.cargoPackage, paths.cargoPath);
}

function main(argv) {
  if (argv[0] === '--resolve-ci') {
    process.stdout.write(resolveCiDesktopVersion(argv[1] ?? ''));
    return;
  }
  const version = argv[0];
  if (!version) {
    process.stderr.write('usage: node scripts/desktop-version.mjs <semver>\n');
    process.exit(1);
  }
  setDesktopVersion(version);
  process.stdout.write(`stamped desktop version ${version} in tauri.conf.json and Cargo.toml\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
