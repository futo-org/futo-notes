import { bundledLanguageCatalogs } from './bundledLanguageCatalogs';
import { createLocalizationModule } from './localization';

const requestedLanguageTags =
  typeof navigator === 'undefined' ? ['en'] : Array.from(navigator.languages);
const regionalNumberFormat = new Intl.NumberFormat().resolvedOptions();
const localizationModule = createLocalizationModule({
  catalogs: bundledLanguageCatalogs,
  requestedLanguageTags,
  regionalLanguageTag: regionalNumberFormat.locale,
  regionalNumberingSystem: regionalNumberFormat.numberingSystem,
});

export const effectiveLanguage = localizationModule.effectiveLanguage;
export const availableLanguages = localizationModule.availableLanguages;
export const localizedText = localizationModule.localizedText;
export const localizedFileSize = localizationModule.localizedFileSize;
export const localizedRelativeTime = localizationModule.localizedRelativeTime;

export type { Language, LocalizationArguments } from './localization';
