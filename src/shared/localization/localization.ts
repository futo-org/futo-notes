import { parseRuntimeCatalogs, type TemplateToken } from './catalogParsing';
import { fallbackCatalogs, formattingLanguageTag, selectCatalog } from './catalogSelection';

export type LocalizationArguments = Readonly<Record<string, string | number>>;

export interface Language {
  tag: string;
  nativeName: string;
  direction: 'ltr' | 'rtl';
}

export interface LocalizationModule {
  readonly effectiveLanguage: Language;
  readonly availableLanguages: readonly Language[];
  localizedText(path: string, values?: LocalizationArguments): string;
  localizedFileSize(bytes: number): string;
  localizedRelativeTime(timestamp: number): string;
  localizedAbsoluteDate(timestamp: number): string;
  localizedYear(timestamp: number): string;
}

export interface LocalizationModuleOptions {
  catalogs: Readonly<Record<string, unknown>>;
  requestedLanguageTags: readonly string[];
  regionalLanguageTag?: string;
  regionalNumberingSystem?: string;
  now?: () => number;
  reportDiagnostic?: (message: string) => void;
}

const englishLanguageNameCollator = new Intl.Collator('en');

function renderTemplate(
  template: readonly TemplateToken[],
  argumentsMap: LocalizationArguments,
  numberFormatter: Intl.NumberFormat,
  languageTag: string,
  messagePath: string,
  report: (key: string, message: string) => void,
): string {
  return template
    .map((token) => {
      if (token.kind === 'text') return token.value;
      const value = argumentsMap[token.name];
      if (!Object.prototype.hasOwnProperty.call(argumentsMap, token.name) || value === undefined) {
        report(
          `${languageTag}:${messagePath}:missing-argument:${token.name}`,
          `Localization catalog error: language=${languageTag} path=${messagePath} type=missing-argument name=${token.name}`,
        );
        return `{${token.name}}`;
      }
      return typeof value === 'number' ? numberFormatter.format(value) : value;
    })
    .join('');
}

export function createLocalizationModule(options: LocalizationModuleOptions): LocalizationModule {
  const reportedDiagnostics = new Set<string>();
  const reportDiagnostic =
    options.reportDiagnostic ?? ((message: string) => console.error(message));
  const report = (key: string, message: string): void => {
    if (reportedDiagnostics.has(key)) return;
    reportedDiagnostics.add(key);
    reportDiagnostic(message);
  };

  const catalogs = parseRuntimeCatalogs(options, report);

  const selection = selectCatalog(options.requestedLanguageTags, catalogs);
  const selectedCatalog = selection.catalog;
  const effectiveLanguage: Language = selectedCatalog
    ? {
        tag: selectedCatalog.tag,
        nativeName: selectedCatalog.nativeName,
        direction: selectedCatalog.direction,
      }
    : { tag: 'en', nativeName: 'English', direction: 'ltr' };
  const formatLanguageTag = formattingLanguageTag(
    effectiveLanguage.tag,
    options.regionalLanguageTag,
    options.regionalNumberingSystem,
  );
  const numberFormatter = new Intl.NumberFormat(formatLanguageTag, { maximumFractionDigits: 3 });
  // Absolute dates. The platform owns the calendar, numbering system and field
  // order (localization.md), so these go through Intl rather than any hand-rolled
  // pattern. `dateStyle: 'medium'` names the month instead of numbering it, which
  // is what keeps "Valid until 15 Jan 2029" unambiguous between the locales that
  // read a numeric date day-first and those that read it month-first.
  const absoluteDateFormatter = new Intl.DateTimeFormat(formatLanguageTag, {
    dateStyle: 'medium',
  });
  // A year on its own is NOT a number: `Intl.NumberFormat` would group it as
  // "2,026". It is a date field, so the date formatter answers for it too.
  const yearFormatter = new Intl.DateTimeFormat(formatLanguageTag, { year: 'numeric' });
  const messageCatalogs = fallbackCatalogs(selectedCatalog, catalogs);
  const availableLanguages = catalogs
    .slice()
    .sort((left, right) => {
      const englishNameOrder = englishLanguageNameCollator.compare(
        left.englishName,
        right.englishName,
      );
      return englishNameOrder || englishLanguageNameCollator.compare(left.tag, right.tag);
    })
    .map<Language>((catalog) => ({
      tag: catalog.tag,
      nativeName: catalog.nativeName,
      direction: catalog.direction,
    }));

  function localizedText(messagePath: string, argumentsMap: LocalizationArguments = {}): string {
    for (const catalog of messageCatalogs) {
      const message = catalog.messages.get(messagePath);
      if (!message) continue;
      if (message.kind === 'plain') {
        return renderTemplate(
          message.template,
          argumentsMap,
          numberFormatter,
          effectiveLanguage.tag,
          messagePath,
          report,
        );
      }

      const pluralValue = argumentsMap[message.pluralArgument];
      if (typeof pluralValue !== 'number' || !Number.isInteger(pluralValue) || pluralValue < 0) {
        report(
          `${effectiveLanguage.tag}:${messagePath}:invalid-plural-argument`,
          `Localization catalog error: language=${effectiveLanguage.tag} path=${messagePath} type=invalid-plural-argument`,
        );
        return messagePath;
      }
      const exactSelector = `=${pluralValue}`;
      let template = message.variants.get(exactSelector);
      if (!template) {
        let category: string;
        try {
          category = new Intl.PluralRules(catalog.tag, { type: 'cardinal' }).select(pluralValue);
        } catch {
          category = 'other';
        }
        template = message.variants.get(category) ?? message.variants.get('other');
      }
      if (!template) return messagePath;
      return renderTemplate(
        template,
        argumentsMap,
        numberFormatter,
        effectiveLanguage.tag,
        messagePath,
        report,
      );
    }

    report(
      `${effectiveLanguage.tag}:${messagePath}:missing-message`,
      `Localization catalog error: language=${effectiveLanguage.tag} path=${messagePath} type=missing-message`,
    );
    return messagePath;
  }

  function localizedFileSize(bytes: number): string {
    if (bytes >= 1_000_000_000_000) {
      const value = Math.round((bytes / 1_000_000_000_000) * 10) / 10;
      return localizedText('units.fileSize.terabyte', { value });
    }
    if (bytes >= 1_000_000_000) {
      const value = Math.round((bytes / 1_000_000_000) * 10) / 10;
      return localizedText('units.fileSize.gigabyte', { value });
    }
    if (bytes >= 1_000_000) {
      const value = Math.round((bytes / 1_000_000) * 10) / 10;
      return localizedText('units.fileSize.megabyte', { value });
    }
    if (bytes >= 1_000) {
      const value = Math.round((bytes / 1_000) * 10) / 10;
      return localizedText('units.fileSize.kilobyte', { value });
    }
    return localizedText('units.fileSize.byte', { value: bytes });
  }

  function localizedRelativeTime(timestamp: number): string {
    const differenceSeconds = (timestamp - (options.now ?? Date.now)()) / 1_000;
    const absoluteSeconds = Math.abs(differenceSeconds);
    if (absoluteSeconds < 60) return localizedText('time.relative.now');

    if (absoluteSeconds >= 365 * 24 * 60 * 60) {
      const count = Math.floor(absoluteSeconds / (365 * 24 * 60 * 60));
      return differenceSeconds < 0
        ? localizedText('time.relative.past.year', { count })
        : localizedText('time.relative.future.year', { count });
    }
    if (absoluteSeconds >= 30 * 24 * 60 * 60) {
      const count = Math.floor(absoluteSeconds / (30 * 24 * 60 * 60));
      return differenceSeconds < 0
        ? localizedText('time.relative.past.month', { count })
        : localizedText('time.relative.future.month', { count });
    }
    if (absoluteSeconds >= 24 * 60 * 60) {
      const count = Math.floor(absoluteSeconds / (24 * 60 * 60));
      return differenceSeconds < 0
        ? localizedText('time.relative.past.day', { count })
        : localizedText('time.relative.future.day', { count });
    }
    if (absoluteSeconds >= 60 * 60) {
      const count = Math.floor(absoluteSeconds / (60 * 60));
      return differenceSeconds < 0
        ? localizedText('time.relative.past.hour', { count })
        : localizedText('time.relative.future.hour', { count });
    }
    const count = Math.floor(absoluteSeconds / 60);
    return differenceSeconds < 0
      ? localizedText('time.relative.past.minute', { count })
      : localizedText('time.relative.future.minute', { count });
  }

  /** An absolute calendar date — "Valid until {date}", "License expired {date}".
   *  Distinct from `localizedRelativeTime`, which answers "how long ago". */
  function localizedAbsoluteDate(timestamp: number): string {
    return absoluteDateFormatter.format(new Date(timestamp));
  }

  /** The year alone — a year is a date field, never a grouped number. */
  function localizedYear(timestamp: number): string {
    return yearFormatter.format(new Date(timestamp));
  }

  return {
    effectiveLanguage,
    availableLanguages,
    localizedText,
    localizedFileSize,
    localizedRelativeTime,
    localizedAbsoluteDate,
    localizedYear,
  };
}
