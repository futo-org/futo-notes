#!/usr/bin/env node
// Patches the Tauri-generated build.gradle.kts to enable release signing
// via keystore.properties. Run after `cargo tauri android init`.

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const gradlePath = resolve(
  process.argv[2] || 'apps/tauri/src-tauri/gen/android/app/build.gradle.kts'
);

let content = readFileSync(gradlePath, 'utf8');

// Add imports at the top if missing
const missingImports = [];
if (!content.includes('java.util.Properties')) {
  missingImports.push('import java.util.Properties');
}
if (!content.includes('java.io.FileInputStream')) {
  missingImports.push('import java.io.FileInputStream');
}
if (missingImports.length > 0) {
  content = missingImports.join('\n') + '\n' + content;
}

// Add signingConfigs block before buildTypes
const signingBlock = `    signingConfigs {
        create("release") {
            val keystorePropertiesFile = rootProject.file("keystore.properties")
            val keystoreProperties = Properties()
            if (keystorePropertiesFile.exists()) {
                keystoreProperties.load(FileInputStream(keystorePropertiesFile))
            }
            keyAlias = keystoreProperties["keyAlias"] as String
            keyPassword = keystoreProperties["password"] as String
            storeFile = file(keystoreProperties["storeFile"] as String)
            storePassword = keystoreProperties["password"] as String
        }
    }

`;

if (!content.includes('signingConfigs')) {
  content = content.replace(/(\n(\s*)buildTypes\s*\{)/, '\n' + signingBlock + '$1');
}

// Wire up the release buildType to use the signing config
if (!content.includes('signingConfigs.getByName("release")')) {
  content = content.replace(
    /(getByName\("release"\)\s*\{)/,
    '$1\n            signingConfig = signingConfigs.getByName("release")'
  );
}

writeFileSync(gradlePath, content);
console.log(`Patched ${gradlePath} with release signing config`);
