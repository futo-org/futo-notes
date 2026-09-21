import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import { load as parseYaml } from 'js-yaml';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const defaultLanguagesDirectory = path.join(repositoryRoot, 'languages');
const defaultSchemaPath = path.join(defaultLanguagesDirectory, 'catalog.schema.json');
const placeholderPattern = /^[a-z][A-Za-z0-9]*$/;

function canonicalLanguageTag(languageTag) {
  try {
    return Intl.getCanonicalLocales(languageTag)[0] ?? null;
  } catch {
    return null;
  }
}

export function inspectMessageTemplate(template) {
  const placeholders = new Set();

  for (let index = 0; index < template.length;) {
    const character = template[index];
    const nextCharacter = template[index + 1];

    if (
      (character === '{' && nextCharacter === '{') ||
      (character === '}' && nextCharacter === '}')
    ) {
      index += 2;
      continue;
    }

    if (character === '}') {
      return { placeholders, error: 'contains an unmatched closing brace' };
    }

    if (character !== '{') {
      index += 1;
      continue;
    }

    const closingIndex = template.indexOf('}', index + 1);
    if (closingIndex === -1) {
      return { placeholders, error: 'contains an unmatched opening brace' };
    }

    const placeholder = template.slice(index + 1, closingIndex);
    if (!placeholderPattern.test(placeholder)) {
      return { placeholders, error: `contains invalid placeholder {${placeholder}}` };
    }

    placeholders.add(placeholder);
    index = closingIndex + 1;
  }

  return { placeholders, error: null };
}

function messageTemplates(value) {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  if (!('plural' in value) || !('variants' in value)) return [];
  if (!value.variants || typeof value.variants !== 'object' || Array.isArray(value.variants))
    return [];
  return Object.values(value.variants).filter((variant) => typeof variant === 'string');
}

function flattenMessages(messages, fileName, errors) {
  const flattened = new Map();

  function visit(value, segments) {
    const messagePath = segments.join('.');

    if (typeof value === 'string' || (value && typeof value === 'object' && 'plural' in value)) {
      const placeholders = new Set();
      if (typeof value?.plural === 'string' && placeholderPattern.test(value.plural)) {
        placeholders.add(value.plural);
      }
      for (const template of messageTemplates(value)) {
        const inspection = inspectMessageTemplate(template);
        if (inspection.error) errors.push(`${fileName}: ${messagePath}: ${inspection.error}`);
        for (const placeholder of inspection.placeholders) placeholders.add(placeholder);
      }
      flattened.set(messagePath, { value, placeholders });
      return;
    }

    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [segment, child] of Object.entries(value)) visit(child, [...segments, segment]);
  }

  visit(messages, []);
  return flattened;
}

function schemaError(fileName, error) {
  const pathSegments = error.instancePath
    .split('/')
    .filter(Boolean)
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
  const messagePath =
    pathSegments[0] === 'messages' ? pathSegments.slice(1).join('.') : pathSegments.join('.');
  const location = messagePath ? `: ${messagePath}` : '';
  return `${fileName}${location}: ${error.message ?? 'does not match the catalog schema'}`;
}

function readCatalogFiles(languagesDirectory) {
  return readdirSync(languagesDirectory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'catalog.schema.json',
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

export function validateLanguageCatalogs({
  languagesDirectory = defaultLanguagesDirectory,
  schemaPath = defaultSchemaPath,
} = {}) {
  const errors = [];
  const catalogs = new Map();
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  const validateSchema = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
  }).compile(schema);

  for (const fileName of readCatalogFiles(languagesDirectory)) {
    const languageTag = fileName.slice(0, -'.json'.length);
    const canonicalTag = canonicalLanguageTag(languageTag);
    if (!canonicalTag) {
      errors.push(`${fileName}: filename is not a valid BCP 47 language tag`);
    } else if (canonicalTag !== languageTag) {
      errors.push(`${fileName}: filename must use canonical tag ${canonicalTag}`);
    }

    const source = readFileSync(path.join(languagesDirectory, fileName), 'utf8');
    let value;
    try {
      value = JSON.parse(source);
    } catch (error) {
      errors.push(
        `${fileName}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    try {
      parseYaml(source);
    } catch (error) {
      const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
      errors.push(`${fileName}: duplicate key: ${reason}`);
    }

    if (!validateSchema(value)) {
      for (const error of validateSchema.errors ?? []) errors.push(schemaError(fileName, error));
    }

    const messageErrors = [];
    const messages = flattenMessages(value?.messages, fileName, messageErrors);
    errors.push(...messageErrors);
    catalogs.set(languageTag, { fileName, languageTag, value, messages });
  }

  const catalogTags = new Set(catalogs.keys());
  const aliasOwners = new Map();
  for (const catalog of catalogs.values()) {
    const aliases = Array.isArray(catalog.value?.language?.aliases)
      ? catalog.value.language.aliases
      : [];
    for (const alias of aliases) {
      if (typeof alias !== 'string') continue;
      const canonicalAlias = canonicalLanguageTag(alias);
      if (!canonicalAlias) {
        errors.push(
          `${catalog.fileName}: language.aliases: ${alias} is not a valid BCP 47 language tag`,
        );
        continue;
      }
      if (canonicalAlias !== alias) {
        errors.push(
          `${catalog.fileName}: language.aliases: ${alias} must use canonical tag ${canonicalAlias}`,
        );
      }
      if (catalogTags.has(canonicalAlias)) {
        errors.push(
          `${catalog.fileName}: language.aliases: ${alias} collides with catalog ${canonicalAlias}.json`,
        );
      }
      const owner = aliasOwners.get(canonicalAlias);
      if (owner && owner !== catalog.languageTag) {
        errors.push(
          `${catalog.fileName}: language.aliases: ${alias} is already owned by ${owner}.json`,
        );
      } else {
        aliasOwners.set(canonicalAlias, catalog.languageTag);
      }
    }
  }

  const english = catalogs.get('en');
  if (!english) {
    errors.push('en.json: required English source catalog is missing');
  } else {
    for (const catalog of catalogs.values()) {
      if (catalog.languageTag === 'en') continue;
      for (const [messagePath, message] of catalog.messages) {
        const sourcePlaceholders = english.messages.get(messagePath)?.placeholders ?? new Set();
        for (const placeholder of message.placeholders) {
          if (!sourcePlaceholders.has(placeholder)) {
            errors.push(
              `${catalog.fileName}: ${messagePath}: placeholder {${placeholder}} is not declared by en.json`,
            );
          }
        }
      }
    }
  }

  return { errors: [...new Set(errors)].sort(), catalogs };
}

function sameMessageValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function auditLanguageCatalogs(validation) {
  const warnings = [];
  const english = validation.catalogs.get('en');
  if (!english)
    return {
      warnings: ['en.json: cannot audit without the English source catalog'],
      summaries: [],
    };
  const summaries = [];

  for (const catalog of validation.catalogs.values()) {
    if (catalog.languageTag === 'en') continue;
    const missing = [...english.messages.keys()].filter(
      (messagePath) => !catalog.messages.has(messagePath),
    );
    const extra = [...catalog.messages.keys()].filter(
      (messagePath) => !english.messages.has(messagePath),
    );
    const translated = english.messages.size - missing.length;
    const completeness =
      english.messages.size === 0 ? 100 : Math.round((translated / english.messages.size) * 100);
    summaries.push(
      `${catalog.languageTag}: ${translated}/${english.messages.size} messages (${completeness}%)`,
    );

    for (const messagePath of missing)
      warnings.push(`${catalog.fileName}: ${messagePath}: missing translation`);
    for (const messagePath of extra)
      warnings.push(`${catalog.fileName}: ${messagePath}: message does not exist in en.json`);

    for (const [messagePath, message] of catalog.messages) {
      const sourceMessage = english.messages.get(messagePath);
      if (!sourceMessage) continue;
      for (const placeholder of sourceMessage.placeholders) {
        if (!message.placeholders.has(placeholder)) {
          warnings.push(
            `${catalog.fileName}: ${messagePath}: omits English placeholder {${placeholder}}`,
          );
        }
      }
      if (
        sameMessageValue(message.value, sourceMessage.value) &&
        !messagePath.startsWith('app.') &&
        !messagePath.startsWith('units.')
      ) {
        warnings.push(`${catalog.fileName}: ${messagePath}: translation is unchanged from English`);
      }
    }
  }

  return { warnings: [...new Set(warnings)].sort(), summaries };
}

function run() {
  const audit = process.argv.includes('--audit');
  const validation = validateLanguageCatalogs();
  if (validation.errors.length > 0) {
    process.stderr.write(
      `Language catalog validation failed:\n${validation.errors.map((error) => `- ${error}`).join('\n')}\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (!audit) {
    process.stdout.write(`Validated ${validation.catalogs.size} language catalogs.\n`);
    return;
  }

  const report = auditLanguageCatalogs(validation);
  process.stdout.write(`${report.summaries.join('\n')}\n`);
  if (report.warnings.length > 0) {
    process.stderr.write(
      `Localization audit warnings:\n${report.warnings.map((warning) => `- ${warning}`).join('\n')}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) run();
