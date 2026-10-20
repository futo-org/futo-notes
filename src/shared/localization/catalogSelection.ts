import type { RuntimeCatalog } from './catalogParsing';

interface LocaleParts {
  readonly language: string;
  readonly script?: string;
  readonly region?: string;
}

export function canonicalLanguageTag(languageTag: string): string | null {
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

export function selectCatalog(
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

export function formattingLanguageTag(
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

export function fallbackCatalogs(
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
