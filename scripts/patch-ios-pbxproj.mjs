#!/usr/bin/env node
// Patches the Tauri-generated Xcode project for CI builds on Xcode 26+.
//
// 1. Manual code signing (CI has cert + profile but no Apple ID)
// 2. Raise deployment target to 16.0
// 3. Add linker flags to suppress missing Swift compat library symbols
//    (Xcode 26 removed swiftCompatibility56/Concurrency/Packs shim
//    libraries, but libapp.a compiled by swift-rs still references them)

import { readFileSync, writeFileSync } from 'fs';

const pbxproj = process.argv[2];
if (!pbxproj) {
  console.error('Usage: node patch-ios-pbxproj.mjs <path/to/project.pbxproj>');
  process.exit(1);
}

let content = readFileSync(pbxproj, 'utf8');

// 1. Manual signing
content = content.replace(/DEVELOPMENT_TEAM = "";/g, 'DEVELOPMENT_TEAM = "2W7AC6T8T5";');
content = content.replace(
  /CODE_SIGN_IDENTITY = "iPhone Developer"/g,
  'CODE_SIGN_IDENTITY = "Apple Distribution"'
);

// 2. Deployment target
content = content.replace(
  /IPHONEOS_DEPLOYMENT_TARGET = 14\.0/g,
  'IPHONEOS_DEPLOYMENT_TARGET = 16.0'
);

// 3. Insert CODE_SIGN_STYLE, PROVISIONING_PROFILE_SPECIFIER, and OTHER_LDFLAGS
//    after each DEVELOPMENT_TEAM line
const ldflags = [
  '"-Wl,-U,__swift_FORCE_LOAD_$_swiftCompatibility56"',
  '"-Wl,-U,__swift_FORCE_LOAD_$_swiftCompatibilityConcurrency"',
  '"-Wl,-U,__swift_FORCE_LOAD_$_swiftCompatibilityPacks"',
].join(', ');

content = content.replace(
  /^(\s*DEVELOPMENT_TEAM = .*;\s*)$/gm,
  (match) =>
    match.trimEnd() +
    '\n\t\t\t\tCODE_SIGN_STYLE = Manual;' +
    '\n\t\t\t\tPROVISIONING_PROFILE_SPECIFIER = "FUTO Notes App Store";' +
    `\n\t\t\t\tOTHER_LDFLAGS = (${ldflags});`
);

writeFileSync(pbxproj, content);
console.log(`Patched ${pbxproj}`);

// Verify
const lines = readFileSync(pbxproj, 'utf8').split('\n');
const interesting = /CODE_SIGN_STYLE|DEVELOPMENT_TEAM|CODE_SIGN_IDENTITY|PROVISIONING_PROFILE|DEPLOYMENT_TARGET|OTHER_LDFLAGS/;
lines.filter(l => interesting.test(l)).slice(0, 30).forEach(l => console.log(l.trim()));
