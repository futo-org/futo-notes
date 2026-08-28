import { describe, expect, it, vi } from 'vitest';

import englishCatalog from '../../../languages/en.json';
import simplifiedChineseCatalog from '../../../languages/zh-Hans.json';
import localizationCases from '../../../tests/localization/cases.json';
import { createLocalizationModule, type LocalizationArguments } from './localization';

const catalogs = {
  en: englishCatalog,
  'zh-Hans': simplifiedChineseCatalog,
};

function minimalCatalog(languageTag: string): unknown {
  if (languageTag === 'en') return englishCatalog;
  if (languageTag === 'zh-Hans') return simplifiedChineseCatalog;
  return {
    $schema: './catalog.schema.json',
    language: {
      englishName: languageTag,
      nativeName: languageTag,
      direction: 'ltr',
      aliases: [],
    },
    messages: {},
  };
}

function localization(
  languageTag: string,
  regionalLanguageTag: string,
  overrides: Partial<Parameters<typeof createLocalizationModule>[0]> = {},
) {
  return createLocalizationModule({
    catalogs,
    requestedLanguageTags: [languageTag],
    regionalLanguageTag,
    reportDiagnostic: vi.fn(),
    ...overrides,
  });
}

describe('localization language matching', () => {
  it('has language-matching cases to run', () => {
    expect(localizationCases.languageMatching.length).toBeGreaterThan(0);
  });

  it.each(localizationCases.languageMatching)(
    'matches $requestedLanguageTags against compatible scripts',
    ({ requestedLanguageTags, availableLanguageTags, expectedLanguageTag }) => {
      const availableCatalogs = Object.fromEntries(
        availableLanguageTags.map((languageTag) => [languageTag, minimalCatalog(languageTag)]),
      );
      const module = createLocalizationModule({
        catalogs: availableCatalogs,
        requestedLanguageTags,
        reportDiagnostic: vi.fn(),
      });

      expect(module.effectiveLanguage.tag).toBe(expectedLanguageTag);
    },
  );

  it('honors explicit aliases before likely-script matching', () => {
    const aliasedChinese = structuredClone(simplifiedChineseCatalog);
    aliasedChinese.language.aliases = ['zh-TW'];
    const module = createLocalizationModule({
      catalogs: { en: englishCatalog, 'zh-Hans': aliasedChinese },
      requestedLanguageTags: ['zh-TW'],
      reportDiagnostic: vi.fn(),
    });

    expect(module.effectiveLanguage.tag).toBe('zh-Hans');
  });

  it('orders available languages by their English names', () => {
    const module = localization('zh-Hans', 'zh-CN');

    expect(module.availableLanguages.map((language) => language.tag)).toEqual(['en', 'zh-Hans']);
  });

  it.each(['englishName', 'nativeName'] as const)(
    'skips catalogs with invalid control text in %s',
    (metadataField) => {
      const reportDiagnostic = vi.fn();
      const invalidChinese = structuredClone(simplifiedChineseCatalog);
      invalidChinese.language[metadataField] = '\u0000';
      const module = createLocalizationModule({
        catalogs: { en: englishCatalog, 'zh-Hans': invalidChinese },
        requestedLanguageTags: ['zh-Hans'],
        reportDiagnostic,
      });

      expect(module.effectiveLanguage.tag).toBe('en');
      expect(reportDiagnostic).toHaveBeenCalledWith(
        'Localization catalog error: language=zh-Hans path=catalog type=invalid-catalog',
      );
    },
  );
});

describe('localizedText', () => {
  it('has message cases to run', () => {
    expect(localizationCases.messages.length).toBeGreaterThan(0);
  });

  it.each(localizationCases.messages)(
    'formats $path in $languageTag',
    ({
      languageTag,
      regionalLanguageTag,
      regionalNumberingSystem,
      path,
      arguments: messageArguments,
      expected,
    }) => {
      const module = localization(languageTag, regionalLanguageTag, {
        regionalNumberingSystem,
      });
      expect(
        module.localizedText(path, messageArguments as LocalizationArguments | undefined),
      ).toBe(expected);
    },
  );

  it('uses the supplying English catalog plural rules during fallback', () => {
    const incompleteChinese = structuredClone(simplifiedChineseCatalog);
    delete incompleteChinese.messages.time.relative.future.minute;
    const module = localization('zh-Hans', 'zh-CN', {
      catalogs: { en: englishCatalog, 'zh-Hans': incompleteChinese },
    });

    expect(module.localizedText('time.relative.future.minute', { count: 1 })).toBe('In 1 minute');
    expect(module.localizedText('time.relative.future.minute', { count: 2 })).toBe('In 2 minutes');
  });

  it('renders escaped braces without parsing inserted values', () => {
    const module = createLocalizationModule({
      catalogs: {
        en: {
          $schema: './catalog.schema.json',
          language: {
            englishName: 'English',
            nativeName: 'English',
            direction: 'ltr',
            aliases: [],
          },
          messages: { example: 'Write {{count}} beside {value}' },
        },
      },
      requestedLanguageTags: ['en'],
      reportDiagnostic: vi.fn(),
    });

    expect(module.localizedText('example', { value: '{untouched}' })).toBe(
      'Write {count} beside {untouched}',
    );
  });

  it('leaves a missing placeholder visible and reports it once without its value', () => {
    const reportDiagnostic = vi.fn();
    const module = createLocalizationModule({
      catalogs,
      requestedLanguageTags: ['en'],
      reportDiagnostic,
    });

    expect(module.localizedText('units.fileSize.byte')).toBe('{value} B');
    expect(module.localizedText('units.fileSize.byte')).toBe('{value} B');
    expect(reportDiagnostic).toHaveBeenCalledTimes(1);
    expect(reportDiagnostic).toHaveBeenCalledWith(
      'Localization catalog error: language=en path=units.fileSize.byte type=missing-argument name=value',
    );
  });

  it('does not use inherited properties as placeholder arguments', () => {
    const reportDiagnostic = vi.fn();
    const module = createLocalizationModule({
      catalogs: {
        en: {
          $schema: './catalog.schema.json',
          language: {
            englishName: 'English',
            nativeName: 'English',
            direction: 'ltr',
            aliases: [],
          },
          messages: { example: '{constructor} {toString}' },
        },
      },
      requestedLanguageTags: ['en'],
      reportDiagnostic,
    });

    expect(module.localizedText('example')).toBe('{constructor} {toString}');
    expect(reportDiagnostic).toHaveBeenCalledTimes(2);
  });

  it('returns the path for an invalid plural argument or missing English message', () => {
    const module = localization('en', 'en-US');
    expect(module.localizedText('time.relative.past.minute', { count: -1 })).toBe(
      'time.relative.past.minute',
    );
    expect(module.localizedText('missing.path')).toBe('missing.path');
  });

  it('ignores an invalid translated leaf and reports it once', () => {
    const reportDiagnostic = vi.fn();
    const invalidChinese = structuredClone(simplifiedChineseCatalog) as unknown as {
      messages: { settings: { language: { heading: unknown } } };
    };
    invalidChinese.messages.settings.language.heading = 42;
    const module = createLocalizationModule({
      catalogs: { en: englishCatalog, 'zh-Hans': invalidChinese },
      requestedLanguageTags: ['zh-Hans'],
      reportDiagnostic,
    });

    expect(module.localizedText('settings.language.heading')).toBe('Language');
    expect(module.localizedText('settings.language.heading')).toBe('Language');
    expect(reportDiagnostic).toHaveBeenCalledOnce();
    expect(reportDiagnostic).toHaveBeenCalledWith(
      'Localization catalog error: language=zh-Hans path=settings.language.heading type=invalid-message',
    );
  });

  it('ignores control-only translated text and falls back', () => {
    const reportDiagnostic = vi.fn();
    const invalidChinese = structuredClone(simplifiedChineseCatalog);
    invalidChinese.messages.settings.language.heading = '\u0000';
    const module = createLocalizationModule({
      catalogs: { en: englishCatalog, 'zh-Hans': invalidChinese },
      requestedLanguageTags: ['zh-Hans'],
      reportDiagnostic,
    });

    expect(module.localizedText('settings.language.heading')).toBe('Language');
    expect(reportDiagnostic).toHaveBeenCalledWith(
      'Localization catalog error: language=zh-Hans path=settings.language.heading type=invalid-message',
    );
  });
});

describe('localized formatters', () => {
  it.each(localizationCases.fileSizes)(
    'formats $bytes bytes in $languageTag',
    ({ languageTag, regionalLanguageTag, bytes, expected }) => {
      expect(localization(languageTag, regionalLanguageTag).localizedFileSize(bytes)).toBe(
        expected,
      );
    },
  );

  it.each(localizationCases.relativeTimes)(
    'formats $secondsFromNow seconds in $languageTag',
    ({ languageTag, regionalLanguageTag, secondsFromNow, expected }) => {
      const now = 1_700_000_000_000;
      const module = localization(languageTag, regionalLanguageTag, { now: () => now });
      expect(module.localizedRelativeTime(now + secondsFromNow * 1_000)).toBe(expected);
    },
  );
});
