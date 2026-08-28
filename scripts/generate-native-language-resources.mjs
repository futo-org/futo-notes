import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
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
const iosRuntimeSourcePath = path.join(
  repositoryRoot,
  'apps/ios/Sources/GeneratedLocalization/GeneratedLanguageCatalogs.swift',
);

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

function parseNativeLanguageCatalog(catalogPath) {
  let value;
  try {
    value = JSON.parse(readFileSync(catalogPath, 'utf8'));
  } catch (cause) {
    throw new Error(`${catalogPath}: catalog is not readable JSON`, { cause });
  }
  if (!isRecord(value)) throw new Error(`${catalogPath}: catalog root must be an object`);
  if (value.$schema !== './catalog.schema.json') {
    throw new Error(`${catalogPath}: $schema must be "./catalog.schema.json"`);
  }
  if (!isRecord(value.language)) throw new Error(`${catalogPath}: language must be an object`);
  if (typeof value.language.englishName !== 'string') {
    throw new Error(`${catalogPath}: language.englishName must be a string`);
  }
  if (typeof value.language.nativeName !== 'string') {
    throw new Error(`${catalogPath}: language.nativeName must be a string`);
  }
  if (value.language.direction !== 'ltr' && value.language.direction !== 'rtl') {
    throw new Error(`${catalogPath}: language.direction must be "ltr" or "rtl"`);
  }
  if (!Array.isArray(value.language.aliases)) {
    throw new Error(`${catalogPath}: language.aliases must be an array`);
  }
  if (!isRecord(value.messages)) throw new Error(`${catalogPath}: messages must be an object`);
  return value;
}

export function discoverNativeLanguageCatalogs(directory = languagesDirectory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'catalog.schema.json',
    )
    .map((entry) => {
      const languageTag = entry.name.slice(0, -'.json'.length);
      const catalogPath = path.join(directory, entry.name);
      const canonicalTag = canonicalLanguageTag(languageTag);
      if (canonicalTag !== languageTag) {
        throw new Error(
          canonicalTag === null
            ? `${catalogPath}: filename is not a valid BCP 47 language tag`
            : `${catalogPath}: filename must use the canonical language tag ${canonicalTag}`,
        );
      }
      const value = parseNativeLanguageCatalog(catalogPath);
      return {
        languageTag,
        value,
        messages: flattenPlainMessages(value.messages),
      };
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

function flattenRuntimeMessages(messages) {
  const flattened = [];

  function visit(value, segments) {
    const messagePath = segments.join('.');
    if (typeof value === 'string' || (isRecord(value) && 'plural' in value)) {
      flattened.push({ messagePath, value });
      return;
    }
    if (!isRecord(value)) return;
    for (const [segment, child] of Object.entries(value)) visit(child, [...segments, segment]);
  }

  visit(messages, []);
  return flattened;
}

function templateTokens(template) {
  const tokens = [];
  let text = '';
  let index = 0;

  function flushText() {
    if (!text) return;
    tokens.push({ kind: 'text', value: text });
    text = '';
  }

  while (index < template.length) {
    const character = template[index];
    const nextCharacter = template[index + 1];
    if (character === '{' && nextCharacter === '{') {
      text += '{';
      index += 2;
    } else if (character === '}' && nextCharacter === '}') {
      text += '}';
      index += 2;
    } else if (character !== '{') {
      text += character;
      index += 1;
    } else {
      const closingIndex = template.indexOf('}', index + 1);
      if (closingIndex === -1) throw new Error('Invalid localization template');
      flushText();
      tokens.push({ kind: 'placeholder', value: template.slice(index + 1, closingIndex) });
      index = closingIndex + 1;
    }
  }
  flushText();
  return tokens;
}

function chunked(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function kotlinString(value) {
  return JSON.stringify(value).replaceAll('$', '\\$');
}

function kotlinTokens(template) {
  return `listOf(${templateTokens(template)
    .map((token) =>
      token.kind === 'text'
        ? `TemplateToken.Text(${kotlinString(token.value)})`
        : `TemplateToken.Placeholder(${kotlinString(token.value)})`,
    )
    .join(', ')})`;
}

function kotlinMessage(value) {
  if (typeof value === 'string') return `CatalogMessage.Plain(${kotlinTokens(value)})`;
  const variants = Object.entries(value.variants)
    .map(([selector, template]) => `${kotlinString(selector)} to ${kotlinTokens(template)}`)
    .join(', ');
  return `CatalogMessage.Plural(${kotlinString(value.plural)}, mapOf(${variants}))`;
}

export function androidRuntimeCatalogSource(catalogs) {
  const catalogEntries = [];
  const messageFunctions = [];
  catalogs.forEach((catalog, catalogIndex) => {
    const messageChunks = chunked(flattenRuntimeMessages(catalog.value.messages), 40);
    const functionNames = messageChunks.map(
      (_, chunkIndex) => `catalog${catalogIndex}Messages${chunkIndex}`,
    );
    catalogEntries.push(
      `        RuntimeCatalog(\n` +
        `            tag = ${kotlinString(catalog.languageTag)},\n` +
        `            englishName = ${kotlinString(catalog.value.language.englishName)},\n` +
        `            nativeName = ${kotlinString(catalog.value.language.nativeName)},\n` +
        `            direction = ${kotlinString(catalog.value.language.direction)},\n` +
        `            aliases = listOf(${catalog.value.language.aliases.map(kotlinString).join(', ')}),\n` +
        `            messages = buildMap {\n${functionNames
          .map((functionName) => `                putAll(${functionName}())`)
          .join('\n')}\n` +
        `            },\n` +
        `        )`,
    );
    messageChunks.forEach((messageChunk, chunkIndex) => {
      const entries = messageChunk
        .map(
          ({ messagePath, value }) =>
            `        ${kotlinString(messagePath)} to ${kotlinMessage(value)}`,
        )
        .join(',\n');
      messageFunctions.push(
        `    private fun catalog${catalogIndex}Messages${chunkIndex}(): Map<String, CatalogMessage> = mapOf(\n${entries},\n    )`,
      );
    });
  });
  return (
    `package com.futo.notes.localization\n\n` +
    `internal object GeneratedLanguageCatalogs {\n` +
    `    val catalogs: List<RuntimeCatalog> = listOf(\n${catalogEntries.join(',\n')}\n    )\n\n` +
    `${messageFunctions.join('\n\n')}\n` +
    `}\n`
  );
}

function swiftString(value) {
  return JSON.stringify(value);
}

function swiftTokens(template) {
  return `[${templateTokens(template)
    .map((token) =>
      token.kind === 'text'
        ? `.text(${swiftString(token.value)})`
        : `.placeholder(${swiftString(token.value)})`,
    )
    .join(', ')}]`;
}

function swiftMessage(value) {
  if (typeof value === 'string') return `.plain(${swiftTokens(value)})`;
  const variants = Object.entries(value.variants)
    .map(([selector, template]) => `${swiftString(selector)}: ${swiftTokens(template)}`)
    .join(', ');
  return `.plural(argument: ${swiftString(value.plural)}, variants: [${variants}])`;
}

export function iosRuntimeCatalogSource(catalogs) {
  const catalogEntries = [];
  const messageFunctions = [];
  catalogs.forEach((catalog, catalogIndex) => {
    const messageChunks = chunked(flattenRuntimeMessages(catalog.value.messages), 40);
    const functionNames = messageChunks.map(
      (_, chunkIndex) => `catalog${catalogIndex}Messages${chunkIndex}()`,
    );
    catalogEntries.push(
      `        RuntimeCatalog(\n` +
        `            tag: ${swiftString(catalog.languageTag)},\n` +
        `            englishName: ${swiftString(catalog.value.language.englishName)},\n` +
        `            nativeName: ${swiftString(catalog.value.language.nativeName)},\n` +
        `            direction: ${swiftString(catalog.value.language.direction)},\n` +
        `            aliases: [${catalog.value.language.aliases.map(swiftString).join(', ')}],\n` +
        `            messages: mergeMessages([${functionNames.join(', ')}])\n` +
        `        )`,
    );
    messageChunks.forEach((messageChunk, chunkIndex) => {
      const entries = messageChunk
        .map(
          ({ messagePath, value }) => `        ${swiftString(messagePath)}: ${swiftMessage(value)}`,
        )
        .join(',\n');
      messageFunctions.push(
        `    private static func catalog${catalogIndex}Messages${chunkIndex}() -> [String: CatalogMessage] {\n        [\n${entries},\n        ]\n    }`,
      );
    });
  });
  return (
    `import Foundation\n\n` +
    `enum GeneratedLanguageCatalogs {\n` +
    `    static let catalogs: [RuntimeCatalog] = [\n${catalogEntries.join(',\n')}\n    ]\n\n` +
    `    private static func mergeMessages(_ groups: [[String: CatalogMessage]]) -> [String: CatalogMessage] {\n` +
    `        var messages: [String: CatalogMessage] = [:]\n` +
    `        for group in groups { messages.merge(group) { _, replacement in replacement } }\n` +
    `        return messages\n` +
    `    }\n\n` +
    `${messageFunctions.join('\n\n')}\n` +
    `}\n`
  );
}

function generateAndroidResources(catalogs) {
  const englishCatalog = catalogs.find((catalog) => catalog.languageTag === 'en');
  if (!englishCatalog) throw new Error('Cannot generate Android language metadata without en.json');
  rmSync(androidOutputDirectory, { recursive: true, force: true });
  const xmlDirectory = path.join(androidOutputDirectory, 'res/xml');
  const kotlinDirectory = path.join(androidOutputDirectory, 'kotlin/com/futo/notes/localization');
  mkdirSync(xmlDirectory, { recursive: true });
  mkdirSync(kotlinDirectory, { recursive: true });
  writeFileSync(path.join(xmlDirectory, 'locales_config.xml'), androidLocaleConfig(catalogs));
  writeFileSync(
    path.join(kotlinDirectory, 'GeneratedLanguageCatalogs.kt'),
    androidRuntimeCatalogSource(catalogs),
  );
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
    rmSync(path.join(directory, 'InfoPlist.strings'), { force: true });
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
  rmSync(iosCatalogsPath, { force: true });
  mkdirSync(path.dirname(iosRuntimeSourcePath), { recursive: true });
  writeFileSync(iosRuntimeSourcePath, iosRuntimeCatalogSource(catalogs));
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
