import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync(new URL('../App.svelte', import.meta.url), 'utf8');

describe('localized application title contract', () => {
  it('updates the DOM and native window from one title inside the localization effect', () => {
    const localizationEffect = appSource.match(
      /\$effect\(\(\) => \{\n {4}desktopLocalization\.effectiveLanguage\.tag;[\s\S]*?\n {2}\}\);/,
    )?.[0];

    expect(localizationEffect).toMatch(
      /const applicationTitle =[\s\S]*?document\.title = applicationTitle;[\s\S]*?setApplicationWindowTitle\(applicationTitle\);/,
    );
  });
});
