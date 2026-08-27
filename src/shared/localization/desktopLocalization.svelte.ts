import { bundledLanguageCatalogs } from './bundledLanguageCatalogs';
import {
  createLocalizationModule,
  type Language,
  type LocalizationArguments,
  type LocalizationModule,
} from './localization';

export interface DesktopLocalizationDependencies {
  getSystemLanguageTags: () => readonly string[];
  getRegionalNumberFormat: () => Pick<
    Intl.ResolvedNumberFormatOptions,
    'locale' | 'numberingSystem'
  >;
  setDocumentLanguage: (language: Language) => void;
}

function browserLocalizationDependencies(): DesktopLocalizationDependencies {
  return {
    getSystemLanguageTags: () =>
      typeof navigator === 'undefined' || navigator.languages.length === 0
        ? ['en']
        : Array.from(navigator.languages),
    getRegionalNumberFormat: () => new Intl.NumberFormat().resolvedOptions(),
    setDocumentLanguage: (language) => {
      if (typeof document === 'undefined') return;
      document.documentElement.lang = language.tag;
      document.documentElement.dir = language.direction;
    },
  };
}

export function createDesktopLocalization(
  dependencies: DesktopLocalizationDependencies = browserLocalizationDependencies(),
) {
  let selectedLanguageTag = $state<string | null>(null);
  let selectionRevision = 0;

  function createCurrentLocalization(): LocalizationModule {
    const regionalNumberFormat = dependencies.getRegionalNumberFormat();
    return createLocalizationModule({
      catalogs: bundledLanguageCatalogs,
      requestedLanguageTags: selectedLanguageTag
        ? [selectedLanguageTag]
        : dependencies.getSystemLanguageTags(),
      regionalLanguageTag: regionalNumberFormat.locale,
      regionalNumberingSystem: regionalNumberFormat.numberingSystem,
    });
  }

  const initialLocalization = createCurrentLocalization();
  let localizationModule = $state.raw(initialLocalization);
  dependencies.setDocumentLanguage(initialLocalization.effectiveLanguage);

  function rebuildLocalization(): void {
    localizationModule = createCurrentLocalization();
    dependencies.setDocumentLanguage(localizationModule.effectiveLanguage);
  }

  function setSelectedLanguageTag(languageTag: string | null): string | null {
    selectionRevision += 1;
    selectedLanguageTag =
      languageTag &&
      localizationModule.availableLanguages.some((language) => language.tag === languageTag)
        ? languageTag
        : null;
    rebuildLocalization();
    return selectedLanguageTag;
  }

  function refreshSystemLanguage(): void {
    if (selectedLanguageTag === null) rebuildLocalization();
  }

  function localizedText(path: string, argumentsMap?: LocalizationArguments): string {
    return localizationModule.localizedText(path, argumentsMap);
  }

  return {
    get selectedLanguageTag() {
      return selectedLanguageTag;
    },
    get selectionRevision() {
      return selectionRevision;
    },
    get effectiveLanguage() {
      return localizationModule.effectiveLanguage;
    },
    get availableLanguages() {
      return localizationModule.availableLanguages;
    },
    localizedText,
    localizedFileSize: (bytes: number) => localizationModule.localizedFileSize(bytes),
    localizedRelativeTime: (timestamp: number) =>
      localizationModule.localizedRelativeTime(timestamp),
    setSelectedLanguageTag,
    refreshSystemLanguage,
  };
}

export type DesktopLocalization = ReturnType<typeof createDesktopLocalization>;

export const desktopLocalization = createDesktopLocalization();
