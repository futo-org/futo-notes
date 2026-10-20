import { canonicalLanguageTag } from './catalogSelection';
import type { LocalizationModuleOptions } from './localization';

export type TemplateToken =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'placeholder'; readonly name: string };

export type CatalogMessage =
  | { readonly kind: 'plain'; readonly template: readonly TemplateToken[] }
  | {
      readonly kind: 'plural';
      readonly pluralArgument: string;
      readonly variants: ReadonlyMap<string, readonly TemplateToken[]>;
    };

export interface RuntimeCatalog {
  readonly tag: string;
  readonly englishName: string;
  readonly nativeName: string;
  readonly direction: 'ltr' | 'rtl';
  readonly aliases: readonly string[];
  readonly messages: ReadonlyMap<string, CatalogMessage>;
}

const pathSegmentPattern = /^[a-z][A-Za-z0-9]*$/;
const exactPluralPattern = /^=(?:0|[1-9][0-9]*)$/;
const pluralCategories = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);

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

export function parseRuntimeCatalogs(
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
