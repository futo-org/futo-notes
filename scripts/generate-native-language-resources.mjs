import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const languagesDirectory = path.join(repositoryRoot, 'languages');
const androidOutputDirectory = path.join(
  repositoryRoot,
  'apps/android/app/build/generated/localization',
);
const iosResourcesDirectory = path.join(repositoryRoot, 'apps/ios/Resources');
const iosManifestPath = path.join(iosResourcesDirectory, '.generated-language-directories.json');
const iosCatalogsPath = path.join(iosResourcesDirectory, 'LanguageCatalogs.json');

function canonicalLanguageTag(languageTag) {
  try {
    return Intl.getCanonicalLocales(languageTag)[0] ?? null;
  } catch {
    return null;
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function flattenPlainMessages(messages) {
  const flattened = new Map();

  function visit(value, segments) {
    if (typeof value === 'string') {
      flattened.set(segments.join('.'), value);
      return;
    }
    if (!isRecord(value) || 'plural' in value || 'variants' in value) return;
    for (const [segment, child] of Object.entries(value)) visit(child, [...segments, segment]);
  }

  visit(messages, []);
  return flattened;
}

export function discoverNativeLanguageCatalogs(directory = languagesDirectory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'catalog.schema.json',
    )
    .flatMap((entry) => {
      const languageTag = entry.name.slice(0, -'.json'.length);
      if (canonicalLanguageTag(languageTag) !== languageTag) return [];
      try {
        const source = readFileSync(path.join(directory, entry.name), 'utf8');
        const value = JSON.parse(source);
        if (
          !isRecord(value) ||
          value.$schema !== './catalog.schema.json' ||
          !isRecord(value.language) ||
          typeof value.language.nativeName !== 'string' ||
          (value.language.direction !== 'ltr' && value.language.direction !== 'rtl') ||
          !Array.isArray(value.language.aliases) ||
          !isRecord(value.messages)
        ) {
          return [];
        }
        return [
          {
            languageTag,
            filePath: path.join(directory, entry.name),
            value,
            messages: flattenPlainMessages(value.messages),
          },
        ];
      } catch {
        return [];
      }
    })
    .sort((left, right) => left.languageTag.localeCompare(right.languageTag));
}

export function nativeResourceCatalogs(catalogs) {
  const resources = new Map();
  for (const catalog of catalogs) {
    const aliases = Array.isArray(catalog.value?.language?.aliases)
      ? catalog.value.language.aliases
      : [];
    for (const languageTag of [catalog.languageTag, ...aliases]) {
      if (typeof languageTag !== 'string' || canonicalLanguageTag(languageTag) !== languageTag)
        continue;
      if (!resources.has(languageTag)) resources.set(languageTag, { languageTag, catalog });
    }
  }
  return [...resources.values()].sort((left, right) =>
    left.languageTag.localeCompare(right.languageTag),
  );
}

export function androidLocaleConfig(catalogs) {
  const locales = nativeResourceCatalogs(catalogs)
    .map(({ languageTag }) => `    <locale android:name="${languageTag}" />`)
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>\n<locale-config xmlns:android="http://schemas.android.com/apk/res/android">\n${locales}\n</locale-config>\n`;
}

function androidString(value) {
  return value
    .replaceAll('\\', '\\\\')
    .replace(/^([@?])/, '\\$1')
    .replaceAll("'", "\\'")
    .replaceAll('"', '\\"')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function androidAppNameStrings(catalog, englishCatalog) {
  const displayName =
    catalog.messages.get('app.android.displayName') ??
    englishCatalog.messages.get('app.android.displayName');
  const debugDisplayName =
    catalog.messages.get('app.android.debugDisplayName') ??
    englishCatalog.messages.get('app.android.debugDisplayName');
  if (!displayName || !debugDisplayName) throw new Error('Missing English Android app name');
  return `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <string name="app_name">${androidString(displayName)}</string>\n    <string name="app_name_debug">${androidString(debugDisplayName)}</string>\n</resources>\n`;
}

function appleString(value) {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')
    .replaceAll('\t', '\\t');
}

export function iosInfoPlistStrings(catalog, englishCatalog, debug = false) {
  const entries = [
    ['CFBundleDisplayName', debug ? 'app.ios.debugDisplayName' : 'app.ios.displayName'],
    ['NSCameraUsageDescription', 'permissions.ios.cameraUsageDescription'],
    ['NSPhotoLibraryUsageDescription', 'permissions.ios.photoLibraryUsageDescription'],
  ];
  return `${entries
    .map(([propertyName, messagePath]) => {
      const value = catalog.messages.get(messagePath) ?? englishCatalog.messages.get(messagePath);
      if (!value) throw new Error(`Missing English native message ${messagePath}`);
      return `"${propertyName}" = "${appleString(value)}";`;
    })
    .join('\n')}\n`;
}

export function iosRuntimeCatalogs(catalogs) {
  return `${JSON.stringify(
    Object.fromEntries(catalogs.map((catalog) => [catalog.languageTag, catalog.value])),
    null,
    2,
  )}\n`;
}

function generateAndroidResources(catalogs) {
  const englishCatalog = catalogs.find((catalog) => catalog.languageTag === 'en');
  if (!englishCatalog) throw new Error('Cannot generate Android language metadata without en.json');
  rmSync(androidOutputDirectory, { recursive: true, force: true });
  const xmlDirectory = path.join(androidOutputDirectory, 'res/xml');
  const assetsDirectory = path.join(androidOutputDirectory, 'assets/languages');
  mkdirSync(xmlDirectory, { recursive: true });
  mkdirSync(assetsDirectory, { recursive: true });
  writeFileSync(path.join(xmlDirectory, 'locales_config.xml'), androidLocaleConfig(catalogs));
  for (const catalog of catalogs) {
    copyFileSync(catalog.filePath, path.join(assetsDirectory, `${catalog.languageTag}.json`));
  }
  for (const { languageTag, catalog } of nativeResourceCatalogs(catalogs)) {
    const valuesDirectoryName =
      languageTag === 'en' ? 'values' : `values-b+${languageTag.replaceAll('-', '+')}`;
    const valuesDirectory = path.join(androidOutputDirectory, 'res', valuesDirectoryName);
    mkdirSync(valuesDirectory, { recursive: true });
    writeFileSync(
      path.join(valuesDirectory, 'strings.xml'),
      androidAppNameStrings(catalog, englishCatalog),
    );
  }
}

function previousIosLanguageTags() {
  if (!existsSync(iosManifestPath)) return [];
  try {
    const value = JSON.parse(readFileSync(iosManifestPath, 'utf8'));
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function removePreviousIosResources() {
  for (const languageTag of previousIosLanguageTags()) {
    if (canonicalLanguageTag(languageTag) !== languageTag) continue;
    const directory = path.join(iosResourcesDirectory, `${languageTag}.lproj`);
    unlinkSync(path.join(directory, 'InfoPlist.strings'), { force: true });
    try {
      rmdirSync(directory);
    } catch {
      continue;
    }
  }
}

function generateIosResources(catalogs) {
  const englishCatalog = catalogs.find((catalog) => catalog.languageTag === 'en');
  if (!englishCatalog) throw new Error('Cannot generate iOS language metadata without en.json');
  removePreviousIosResources();
  const resources = nativeResourceCatalogs(catalogs);
  for (const { languageTag, catalog } of resources) {
    const directory = path.join(iosResourcesDirectory, `${languageTag}.lproj`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, 'InfoPlist.strings'),
      iosInfoPlistStrings(catalog, englishCatalog),
    );
  }
  writeFileSync(
    iosManifestPath,
    `${JSON.stringify(resources.map(({ languageTag }) => languageTag))}\n`,
  );
  writeFileSync(iosCatalogsPath, iosRuntimeCatalogs(catalogs));
}

function generateBuiltIosInfoPlistStrings(catalogs, outputDirectory, configuration) {
  const englishCatalog = catalogs.find((catalog) => catalog.languageTag === 'en');
  if (!englishCatalog) throw new Error('Cannot generate iOS language metadata without en.json');
  const debug = configuration === 'Debug';
  for (const { languageTag, catalog } of nativeResourceCatalogs(catalogs)) {
    const directory = path.join(outputDirectory, `${languageTag}.lproj`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, 'InfoPlist.strings'),
      iosInfoPlistStrings(catalog, englishCatalog, debug),
    );
  }
}

function run() {
  const catalogs = discoverNativeLanguageCatalogs();
  if (catalogs.length === 0) throw new Error('No valid language catalogs found');
  if (process.argv.includes('--android') || process.argv.includes('--all')) {
    generateAndroidResources(catalogs);
  }
  if (process.argv.includes('--ios') || process.argv.includes('--all')) {
    generateIosResources(catalogs);
  }
  const builtIosResourcesArgumentIndex = process.argv.indexOf('--ios-built-resources');
  if (builtIosResourcesArgumentIndex !== -1) {
    const outputDirectory = process.argv[builtIosResourcesArgumentIndex + 1];
    const configuration = process.argv[builtIosResourcesArgumentIndex + 2];
    if (!outputDirectory || !configuration) {
      throw new Error('--ios-built-resources requires an output directory and configuration');
    }
    generateBuiltIosInfoPlistStrings(catalogs, outputDirectory, configuration);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) run();
