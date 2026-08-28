import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  androidAppNameStrings,
  androidLocaleConfig,
  androidRuntimeCatalogSource,
  discoverNativeLanguageCatalogs,
  iosInfoPlistStrings,
  iosRuntimeCatalogSource,
  nativeResourceCatalogs,
} from './generate-native-language-resources.mjs';

const repositoryLanguagesDirectory = path.resolve(import.meta.dirname, '../languages');

describe('native language resources', () => {
  it('discovers every valid authored catalog without a registry', () => {
    expect(discoverNativeLanguageCatalogs().map((catalog) => catalog.languageTag)).toEqual([
      'en',
      'zh-Hans',
    ]);
  });

  it('generates Android locale metadata from catalog filenames', () => {
    expect(androidLocaleConfig(discoverNativeLanguageCatalogs())).toBe(
      '<?xml version="1.0" encoding="utf-8"?>\n' +
        '<locale-config xmlns:android="http://schemas.android.com/apk/res/android">\n' +
        '    <locale android:name="en" />\n' +
        '    <locale android:name="zh-Hans" />\n' +
        '</locale-config>\n',
    );
  });

  it('maps explicit aliases to native platform resources', () => {
    const catalogs = discoverNativeLanguageCatalogs();
    const simplifiedChinese = catalogs.find((catalog) => catalog.languageTag === 'zh-Hans');
    simplifiedChinese.value.language.aliases = ['zh-TW'];

    expect(
      nativeResourceCatalogs(catalogs).map(({ languageTag, catalog }) => [
        languageTag,
        catalog.languageTag,
      ]),
    ).toContainEqual(['zh-TW', 'zh-Hans']);
    expect(androidLocaleConfig(catalogs)).toContain('<locale android:name="zh-TW" />');
  });

  it('generates localized Android application names', () => {
    const catalogs = discoverNativeLanguageCatalogs();
    const english = catalogs.find((catalog) => catalog.languageTag === 'en');
    const simplifiedChinese = catalogs.find((catalog) => catalog.languageTag === 'zh-Hans');
    expect(androidAppNameStrings(simplifiedChinese, english)).toContain(
      '<string name="app_name_debug">FUTO 笔记开发版</string>',
    );
  });

  it('escapes Android application names as resource strings', () => {
    const english = {
      messages: new Map([
        ['app.android.displayName', 'FUTO Notes'],
        ['app.android.debugDisplayName', 'FUTO Notes Dev'],
      ]),
    };
    const catalog = {
      messages: new Map([
        ['app.android.displayName', 'A&B\'s "Notes"'],
        ['app.android.debugDisplayName', "A&B's Dev"],
      ]),
    };
    expect(androidAppNameStrings(catalog, english)).toContain(
      `<string name="app_name">A&amp;B\\'s \\"Notes\\"</string>`,
    );
  });

  it('escapes Android resource-reference prefixes in application names', () => {
    const english = {
      messages: new Map([
        ['app.android.displayName', 'FUTO Notes'],
        ['app.android.debugDisplayName', 'FUTO Notes Dev'],
      ]),
    };
    const catalog = {
      messages: new Map([
        ['app.android.displayName', '@string/translated_name'],
        ['app.android.debugDisplayName', '?attr/translated_name'],
      ]),
    };

    const resources = androidAppNameStrings(catalog, english);

    expect(resources).toContain('<string name="app_name">\\@string/translated_name</string>');
    expect(resources).toContain('<string name="app_name_debug">\\?attr/translated_name</string>');
  });

  it('generates Apple-owned text with English fallback', () => {
    const catalogs = discoverNativeLanguageCatalogs();
    const english = catalogs.find((catalog) => catalog.languageTag === 'en');
    const simplifiedChinese = catalogs.find((catalog) => catalog.languageTag === 'zh-Hans');
    expect(english).toBeDefined();
    expect(simplifiedChinese).toBeDefined();
    expect(iosInfoPlistStrings(simplifiedChinese, english)).toContain(
      '"NSCameraUsageDescription" = "拍摄照片并将其添加到笔记中。";',
    );
    expect(iosInfoPlistStrings(simplifiedChinese, english, true)).toContain(
      '"CFBundleDisplayName" = "FUTO 笔记开发版";',
    );
  });

  it('generates in-memory Android catalogs without asset reads or JSON parsing', () => {
    const source = androidRuntimeCatalogSource(discoverNativeLanguageCatalogs());

    expect(source).toContain('tag = "en"');
    expect(source).toContain('tag = "zh-Hans"');
    expect(source).toContain('"settings.language.heading" to CatalogMessage.Plain');
    expect(source).toContain('CatalogMessage.Plural("count"');
    expect(source).not.toContain('JSONObject');
    expect(source).not.toContain('assets');
  });

  it('generates in-memory Apple catalogs without bundle reads or JSON parsing', () => {
    const source = iosRuntimeCatalogSource(discoverNativeLanguageCatalogs());

    expect(source).toContain('tag: "en"');
    expect(source).toContain('tag: "zh-Hans"');
    expect(source).toContain('"settings.language.heading": .plain');
    expect(source).toContain('.plural(argument: "count"');
    expect(source).not.toContain('JSONSerialization');
    expect(source).not.toContain('Bundle');
  });

  describe('refuses an unusable catalog instead of dropping it', () => {
    let seededDirectory = null;

    afterEach(() => {
      if (seededDirectory !== null) rmSync(seededDirectory, { recursive: true, force: true });
      seededDirectory = null;
    });

    function seedCatalogs(mutate) {
      seededDirectory = mkdtempSync(path.join(tmpdir(), 'futo-language-catalogs-'));
      for (const languageTag of ['en', 'zh-Hans']) {
        const source = readFileSync(
          path.join(repositoryLanguagesDirectory, `${languageTag}.json`),
          'utf8',
        );
        writeFileSync(path.join(seededDirectory, `${languageTag}.json`), source);
      }
      mutate(seededDirectory);
      return seededDirectory;
    }

    it('accepts the seeded catalogs when nothing is wrong', () => {
      const directory = seedCatalogs(() => {});

      expect(
        discoverNativeLanguageCatalogs(directory).map((catalog) => catalog.languageTag),
      ).toEqual(['en', 'zh-Hans']);
    });

    it('throws when a catalog declares the wrong schema', () => {
      const directory = seedCatalogs((target) => {
        const catalogPath = path.join(target, 'zh-Hans.json');
        const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
        catalog.$schema = 'catalog.schema.json';
        writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
      });

      expect(() => discoverNativeLanguageCatalogs(directory)).toThrow(/\$schema/);
    });

    it('throws when a catalog is not readable JSON', () => {
      const directory = seedCatalogs((target) => {
        writeFileSync(path.join(target, 'zh-Hans.json'), '{ broken');
      });

      expect(() => discoverNativeLanguageCatalogs(directory)).toThrow(/not readable JSON/);
    });

    it('throws when catalog metadata is missing', () => {
      const directory = seedCatalogs((target) => {
        const catalogPath = path.join(target, 'zh-Hans.json');
        const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
        delete catalog.language.nativeName;
        writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
      });

      expect(() => discoverNativeLanguageCatalogs(directory)).toThrow(/language.nativeName/);
    });
  });
});
