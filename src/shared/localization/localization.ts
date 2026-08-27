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
}

export interface LocalizationModuleOptions {
  catalogs: Readonly<Record<string, unknown>>;
  requestedLanguageTags: readonly string[];
  regionalLanguageTag?: string;
  regionalNumberingSystem?: string;
  now?: () => number;
  reportDiagnostic?: (message: string) => void;
}

type TemplateToken =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'placeholder'; readonly name: string };

type CatalogMessage =
  | { readonly kind: 'plain'; readonly template: readonly TemplateToken[] }
  | {
      readonly kind: 'plural';
      readonly pluralArgument: string;
      readonly variants: ReadonlyMap<string, readonly TemplateToken[]>;
    };

interface RuntimeCatalog {
  readonly tag: string;
  readonly englishName: string;
  readonly nativeName: string;
  readonly direction: 'ltr' | 'rtl';
  readonly aliases: readonly string[];
  readonly messages: ReadonlyMap<string, CatalogMessage>;
}

interface LocaleParts {
  readonly language: string;
  readonly script?: string;
  readonly region?: string;
}

const pathSegmentPattern = /^[a-z][A-Za-z0-9]*$/;
const exactPluralPattern = /^=(?:0|[1-9][0-9]*)$/;
const pluralCategories = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);
const englishLanguageNameCollator = new Intl.Collator('en');

function canonicalLanguageTag(languageTag: string): string | null {
  try {
    return Intl.getCanonicalLocales(languageTag)[0] ?? null;
  } catch {
    return null;
  }
}

function parseLocale(languageTag: string, maximize: boolean): LocaleParts | null {
  try {
    const locale = maximize
      ? new Intl.Locale(languageTag).maximize()
      : new Intl.Locale(languageTag);
    return {
      language: locale.language,
      ...(locale.script ? { script: locale.script } : {}),
      ...(locale.region ? { region: locale.region } : {}),
    };
  } catch {
    return null;
  }
}

function appendText(tokens: TemplateToken[], value: string): void {
  if (value.length === 0) return;
  const previous = tokens[tokens.length - 1];
  if (previous?.kind === 'text') {
    tokens[tokens.length - 1] = { kind: 'text', value: previous.value + value };
  } else {
    tokens.push({ kind: 'text', value });
  }
}

function isValidCatalogText(value: string): boolean {
  if (value.length === 0 || value.trim() !== value) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      (codePoint >= 0x00 && codePoint <= 0x08) ||
      (codePoint >= 0x0b && codePoint <= 0x0c) ||
      (codePoint >= 0x0e && codePoint <= 0x1f) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      (codePoint >= 0xfffe && codePoint <= 0xffff)
    ) {
      return false;
    }
  }
  return true;
}

function parseTemplate(template: string): readonly TemplateToken[] | null {
  if (!isValidCatalogText(template)) return null;
  const tokens: TemplateToken[] = [];

  for (let index = 0; index < template.length;) {
    const character = template[index];
    const nextCharacter = template[index + 1];

    if (character === '{' && nextCharacter === '{') {
      appendText(tokens, '{');
      index += 2;
      continue;
    }
    if (character === '}' && nextCharacter === '}') {
      appendText(tokens, '}');
      index += 2;
      continue;
    }
    if (character === '}') return null;
    if (character !== '{') {
      appendText(tokens, character);
      index += 1;
      continue;
    }

    const closingIndex = template.indexOf('}', index + 1);
    if (closingIndex === -1) return null;
    const placeholder = template.slice(index + 1, closingIndex);
    if (!pathSegmentPattern.test(placeholder)) return null;
    tokens.push({ kind: 'placeholder', name: placeholder });
    index = closingIndex + 1;
  }

  return tokens;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMessage(value: unknown): CatalogMessage | null {
  if (typeof value === 'string') {
    const template = parseTemplate(value);
    return template ? { kind: 'plain', template } : null;
  }
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('plural') || !keys.includes('variants')) return null;
  if (typeof value.plural !== 'string' || !pathSegmentPattern.test(value.plural)) return null;
  if (!isRecord(value.variants) || !Object.prototype.hasOwnProperty.call(value.variants, 'other')) {
    return null;
  }

  const variants = new Map<string, readonly TemplateToken[]>();
  for (const [selector, variant] of Object.entries(value.variants)) {
    if (!pluralCategories.has(selector) && !exactPluralPattern.test(selector)) return null;
    if (typeof variant !== 'string') return null;
    const template = parseTemplate(variant);
    if (!template) return null;
    variants.set(selector, template);
  }

  return { kind: 'plural', pluralArgument: value.plural, variants };
}

function flattenCatalogMessages(
  languageTag: string,
  value: unknown,
  report: (key: string, message: string) => void,
): ReadonlyMap<string, CatalogMessage> {
  const messages = new Map<string, CatalogMessage>();

  function visit(current: unknown, segments: readonly string[]): void {
    if (!isRecord(current)) return;
    for (const [segment, child] of Object.entries(current)) {
      const nextSegments = [...segments, segment];
      const messagePath = nextSegments.join('.');
      if (!pathSegmentPattern.test(segment)) {
        report(
          `${languageTag}:${messagePath}:invalid-path`,
          `Localization catalog error: language=${languageTag} path=${messagePath} type=invalid-path`,
        );
        continue;
      }
      if (
        typeof child === 'string' ||
        (isRecord(child) && ('plural' in child || 'variants' in child))
      ) {
        const message = parseMessage(child);
        if (message) {
          messages.set(messagePath, message);
        } else {
          report(
            `${languageTag}:${messagePath}:invalid-message`,
            `Localization catalog error: language=${languageTag} path=${messagePath} type=invalid-message`,
          );
        }
        continue;
      }
      if (isRecord(child)) {
        visit(child, nextSegments);
      } else {
        report(
          `${languageTag}:${messagePath}:invalid-message`,
          `Localization catalog error: language=${languageTag} path=${messagePath} type=invalid-message`,
        );
      }
    }
  }

  visit(value, []);
  return messages;
}

function parseCatalog(
  languageTag: string,
  value: unknown,
  report: (key: string, message: string) => void,
): RuntimeCatalog | null {
  const canonicalTag = canonicalLanguageTag(languageTag);
  if (!canonicalTag || canonicalTag !== languageTag || !isRecord(value)) return null;
  if (
    Object.keys(value).length !== 3 ||
    value.$schema !== './catalog.schema.json' ||
    !isRecord(value.language) ||
    Object.keys(value.language).length !== 4 ||
    !isRecord(value.messages)
  ) {
    return null;
  }
  const englishName = value.language.englishName;
  const nativeName = value.language.nativeName;
  const direction = value.language.direction;
  const aliases = value.language.aliases;
  if (
    typeof englishName !== 'string' ||
    !isValidCatalogText(englishName) ||
    typeof nativeName !== 'string' ||
    !isValidCatalogText(nativeName) ||
    (direction !== 'ltr' && direction !== 'rtl') ||
    !Array.isArray(aliases)
  ) {
    return null;
  }

  const canonicalAliases: string[] = [];
  for (const alias of aliases) {
    if (typeof alias !== 'string') return null;
    const canonicalAlias = canonicalLanguageTag(alias);
    if (!canonicalAlias || canonicalAlias !== alias || canonicalAliases.includes(alias))
      return null;
    canonicalAliases.push(alias);
  }

  return {
    tag: languageTag,
    englishName,
    nativeName,
    direction,
    aliases: canonicalAliases,
    messages: flattenCatalogMessages(languageTag, value.messages, report),
  };
}

function compatibleCatalogs(
  requestedLanguageTag: string,
  catalogs: readonly RuntimeCatalog[],
): readonly RuntimeCatalog[] {
  const requested = parseLocale(requestedLanguageTag, true);
  if (!requested?.script) return [];
  return catalogs.filter((catalog) => {
    const candidate = parseLocale(catalog.tag, true);
    return candidate?.language === requested.language && candidate.script === requested.script;
  });
}

function selectRequestedCatalog(
  requestedLanguageTag: string,
  catalogs: readonly RuntimeCatalog[],
): RuntimeCatalog | null {
  const canonicalTag = canonicalLanguageTag(requestedLanguageTag);
  if (!canonicalTag) return null;
  const exact = catalogs.find((catalog) => catalog.tag === canonicalTag);
  if (exact) return exact;
  const alias = catalogs.find((catalog) => catalog.aliases.includes(canonicalTag));
  if (alias) return alias;

  const compatible = compatibleCatalogs(canonicalTag, catalogs);
  const generic = compatible.filter((catalog) => !parseLocale(catalog.tag, false)?.region);
  if (generic.length === 1) return generic[0];
  return compatible.length === 1 ? compatible[0] : null;
}

function selectCatalog(
  requestedLanguageTags: readonly string[],
  catalogs: readonly RuntimeCatalog[],
): { catalog: RuntimeCatalog | null; requestedLanguageTag: string } {
  for (const requestedLanguageTag of requestedLanguageTags) {
    const catalog = selectRequestedCatalog(requestedLanguageTag, catalogs);
    if (catalog) return { catalog, requestedLanguageTag };
  }
  return {
    catalog: catalogs.find((catalog) => catalog.tag === 'en') ?? null,
    requestedLanguageTag: 'en',
  };
}

function formattingLanguageTag(
  selectedLanguageTag: string,
  regionalLanguageTag: string | undefined,
  regionalNumberingSystem: string | undefined,
): string {
  try {
    const selected = new Intl.Locale(selectedLanguageTag);
    const regional = regionalLanguageTag ? new Intl.Locale(regionalLanguageTag) : null;
    const numberingSystem =
      regionalNumberingSystem ??
      (regionalLanguageTag
        ? new Intl.NumberFormat(regionalLanguageTag).resolvedOptions().numberingSystem
        : undefined);
    return new Intl.Locale(selected.baseName, {
      ...(regional?.region ? { region: regional.region } : {}),
      ...(numberingSystem ? { numberingSystem } : {}),
    }).toString();
  } catch {
    return selectedLanguageTag;
  }
}

function genericFallbackCatalog(
  selectedCatalog: RuntimeCatalog | null,
  catalogs: readonly RuntimeCatalog[],
): RuntimeCatalog | null {
  if (!selectedCatalog) return null;
  const generic = compatibleCatalogs(selectedCatalog.tag, catalogs).filter(
    (catalog) => catalog.tag !== selectedCatalog.tag && !parseLocale(catalog.tag, false)?.region,
  );
  return generic.length === 1 ? generic[0] : null;
}

function fallbackCatalogs(
  selectedCatalog: RuntimeCatalog | null,
  catalogs: readonly RuntimeCatalog[],
): readonly RuntimeCatalog[] {
  const candidates = [
    selectedCatalog,
    genericFallbackCatalog(selectedCatalog, catalogs),
    catalogs.find((catalog) => catalog.tag === 'en') ?? null,
  ];
  return candidates.filter(
    (catalog, index): catalog is RuntimeCatalog =>
      catalog !== null &&
      candidates.findIndex((candidate) => candidate?.tag === catalog.tag) === index,
  );
}

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

function parseRuntimeCatalogs(
  options: LocalizationModuleOptions,
  report: (key: string, message: string) => void,
): RuntimeCatalog[] {
  return Object.entries(options.catalogs)
    .map(([languageTag, value]) => {
      const catalog = parseCatalog(languageTag, value, report);
      if (!catalog) {
        report(
          `${languageTag}:catalog:invalid-catalog`,
          `Localization catalog error: language=${languageTag} path=catalog type=invalid-catalog`,
        );
      }
      return catalog;
    })
    .filter((catalog): catalog is RuntimeCatalog => catalog !== null);
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
    options.regionalLanguageTag ?? selection.requestedLanguageTag,
    options.regionalNumberingSystem,
  );
  const numberFormatter = new Intl.NumberFormat(formatLanguageTag, { maximumFractionDigits: 3 });
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
        let category = 'other';
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

  return {
    effectiveLanguage,
    availableLanguages,
    localizedText,
    localizedFileSize,
    localizedRelativeTime,
  };
}
