import { describe, expect, it } from 'vitest';

import { createDesktopLocalization } from './desktopLocalization.svelte';
import type { Language } from './localization';

function localizationHarness(initialSystemLanguageTags: readonly string[]) {
  let systemLanguageTags = initialSystemLanguageTags;
  const documentLanguages: Language[] = [];
  const localization = createDesktopLocalization({
    getSystemLanguageTags: () => systemLanguageTags,
    getRegionalNumberFormat: () => ({ locale: 'en-US', numberingSystem: 'latn' }),
    setDocumentLanguage: (language) => documentLanguages.push(language),
  });

  return {
    localization,
    documentLanguages,
    setSystemLanguageTags: (languageTags: readonly string[]) => {
      systemLanguageTags = languageTags;
    },
  };
}

describe('desktop localization', () => {
  it('applies an explicit language immediately', () => {
    const harness = localizationHarness(['en-US']);

    expect(harness.localization.localizedText('settings.language.heading')).toBe('Language');

    expect(harness.localization.setSelectedLanguageTag('zh-Hans')).toBe('zh-Hans');
    expect(harness.localization.localizedText('settings.language.heading')).toBe('语言');
    expect(harness.localization.effectiveLanguage.tag).toBe('zh-Hans');
    expect(harness.documentLanguages.at(-1)?.tag).toBe('zh-Hans');
  });

  it('refreshes System from the ordered device languages without overriding a selection', () => {
    const harness = localizationHarness(['en-US']);
    harness.setSystemLanguageTags(['zh-CN', 'en-US']);
    harness.localization.refreshSystemLanguage();

    expect(harness.localization.effectiveLanguage.tag).toBe('zh-Hans');

    harness.localization.setSelectedLanguageTag('en');
    harness.setSystemLanguageTags(['zh-CN']);
    harness.localization.refreshSystemLanguage();

    expect(harness.localization.effectiveLanguage.tag).toBe('en');
  });

  it('does not rebuild when the device languages are unchanged', () => {
    const harness = localizationHarness(['en-US']);
    const documentLanguageCount = harness.documentLanguages.length;

    harness.localization.refreshSystemLanguage();
    harness.localization.refreshSystemLanguage();

    expect(harness.documentLanguages.length).toBe(documentLanguageCount);

    harness.setSystemLanguageTags(['zh-CN']);
    harness.localization.refreshSystemLanguage();

    expect(harness.documentLanguages.length).toBe(documentLanguageCount + 1);
  });

  it('corrects an unavailable stored language to System', () => {
    const harness = localizationHarness(['zh-CN']);

    expect(harness.localization.setSelectedLanguageTag('fr')).toBeNull();
    expect(harness.localization.selectedLanguageTag).toBeNull();
    expect(harness.localization.effectiveLanguage.tag).toBe('zh-Hans');
  });
});
