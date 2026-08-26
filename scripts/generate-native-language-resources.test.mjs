import { describe, expect, it } from 'vitest';

import {
  androidAppNameStrings,
  androidLocaleConfig,
  discoverNativeLanguageCatalogs,
  iosInfoPlistStrings,
  iosRuntimeCatalogs,
  nativeResourceCatalogs,
} from './generate-native-language-resources.mjs';

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

  it('bundles every runtime catalog for Apple without scanning unrelated resources', () => {
    const runtimeCatalogs = JSON.parse(iosRuntimeCatalogs(discoverNativeLanguageCatalogs()));
    expect(Object.keys(runtimeCatalogs)).toEqual(['en', 'zh-Hans']);
    expect(runtimeCatalogs['zh-Hans'].messages.settings.language.heading).toBe('语言');
  });
});
