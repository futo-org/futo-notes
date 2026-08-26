import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  auditLanguageCatalogs,
  inspectMessageTemplate,
  validateLanguageCatalogs,
} from './language-catalogs.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..');

function temporaryCatalogDirectory() {
  const directory = path.join(os.tmpdir(), `futo-language-catalogs-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, 'catalog.schema.json'),
    readFileSync(path.join(repositoryRoot, 'languages/catalog.schema.json')),
  );
  return directory;
}

function catalog(nativeName, messages, aliases = []) {
  return {
    $schema: './catalog.schema.json',
    language: { nativeName, direction: 'ltr', aliases },
    messages,
  };
}

describe('language catalogs', () => {
  it('validates every repository catalog together', () => {
    const validation = validateLanguageCatalogs();
    expect(validation.errors).toEqual([]);
    expect([...validation.catalogs.keys()]).toEqual(['en', 'zh-Hans']);
  });

  it('recognizes placeholders and escaped literal braces', () => {
    expect(inspectMessageTemplate('Write {{count}} for {noteTitle}')).toEqual({
      placeholders: new Set(['noteTitle']),
      error: null,
    });
  });

  it('collects syntax, duplicate-key, filename, alias, brace, and placeholder errors', () => {
    const directory = temporaryCatalogDirectory();
    writeFileSync(
      path.join(directory, 'en.json'),
      JSON.stringify(catalog('English', { notes: { title: 'Title {noteTitle}' } })),
    );
    writeFileSync(
      path.join(directory, 'ZH_hans.json'),
      '{"$schema":"./catalog.schema.json","language":{"nativeName":"简体中文","nativeName":"中文","direction":"ltr","aliases":["en"]},"messages":{"notes":{"title":"标题 {otherTitle"}}}',
    );
    writeFileSync(path.join(directory, 'fr.json'), '{');

    const validation = validateLanguageCatalogs({
      languagesDirectory: directory,
      schemaPath: path.join(directory, 'catalog.schema.json'),
    });

    expect(validation.errors.join('\n')).toMatch(
      'ZH_hans.json: filename is not a valid BCP 47 language tag',
    );
    expect(validation.errors.join('\n')).toMatch('ZH_hans.json: duplicate key');
    expect(validation.errors.join('\n')).toMatch(
      'ZH_hans.json: notes.title: contains an unmatched opening brace',
    );
    expect(validation.errors.join('\n')).toMatch(
      'ZH_hans.json: language.aliases: en collides with catalog en.json',
    );
    expect(validation.errors.join('\n')).toMatch('fr.json: invalid JSON');
  });

  it('blocks translated placeholders that English does not declare', () => {
    const directory = temporaryCatalogDirectory();
    writeFileSync(
      path.join(directory, 'en.json'),
      JSON.stringify(catalog('English', { save: 'Save' })),
    );
    writeFileSync(
      path.join(directory, 'fr.json'),
      JSON.stringify(catalog('Français', { save: 'Enregistrer {name}' })),
    );

    const validation = validateLanguageCatalogs({
      languagesDirectory: directory,
      schemaPath: path.join(directory, 'catalog.schema.json'),
    });

    expect(validation.errors).toContain(
      'fr.json: save: placeholder {name} is not declared by en.json',
    );
  });

  it('blocks placeholders on translation-only paths', () => {
    const directory = temporaryCatalogDirectory();
    writeFileSync(
      path.join(directory, 'en.json'),
      JSON.stringify(catalog('English', { save: 'Save' })),
    );
    writeFileSync(
      path.join(directory, 'fr.json'),
      JSON.stringify(catalog('Français', { extra: 'Supprimer {name}' })),
    );

    const validation = validateLanguageCatalogs({
      languagesDirectory: directory,
      schemaPath: path.join(directory, 'catalog.schema.json'),
    });

    expect(validation.errors).toContain(
      'fr.json: extra: placeholder {name} is not declared by en.json',
    );
  });

  it('treats a plural selector argument as declared even when English does not display it', () => {
    const directory = temporaryCatalogDirectory();
    writeFileSync(
      path.join(directory, 'en.json'),
      JSON.stringify(
        catalog('English', {
          notes: {
            count: {
              plural: 'count',
              variants: { one: 'One note', other: 'Many notes' },
            },
          },
        }),
      ),
    );
    writeFileSync(
      path.join(directory, 'zh-Hans.json'),
      JSON.stringify(
        catalog('简体中文', {
          notes: {
            count: {
              plural: 'count',
              variants: { other: '{count} 条笔记' },
            },
          },
        }),
      ),
    );

    const validation = validateLanguageCatalogs({
      languagesDirectory: directory,
      schemaPath: path.join(directory, 'catalog.schema.json'),
    });

    expect(validation.errors).toEqual([]);
  });

  it('rejects text that cannot be represented in native resources', () => {
    const directory = temporaryCatalogDirectory();
    writeFileSync(
      path.join(directory, 'en.json'),
      JSON.stringify(catalog('English', { app: { displayName: 'FUTO\u0000 Notes' } })),
    );

    const validation = validateLanguageCatalogs({
      languagesDirectory: directory,
      schemaPath: path.join(directory, 'catalog.schema.json'),
    });

    expect(validation.errors.some((error) => error.startsWith('en.json: app.displayName:'))).toBe(
      true,
    );
  });

  it('keeps completeness findings in the non-blocking audit', () => {
    const directory = temporaryCatalogDirectory();
    writeFileSync(
      path.join(directory, 'en.json'),
      JSON.stringify(catalog('English', { save: 'Save', cancel: 'Cancel {name}' })),
    );
    writeFileSync(
      path.join(directory, 'fr.json'),
      JSON.stringify(catalog('Français', { save: 'Save', extra: 'Supplément' })),
    );
    const validation = validateLanguageCatalogs({
      languagesDirectory: directory,
      schemaPath: path.join(directory, 'catalog.schema.json'),
    });

    expect(validation.errors).toEqual([]);
    expect(auditLanguageCatalogs(validation)).toEqual({
      summaries: ['fr: 1/2 messages (50%)'],
      warnings: [
        'fr.json: cancel: missing translation',
        'fr.json: extra: message does not exist in en.json',
        'fr.json: save: translation is unchanged from English',
      ],
    });
  });
});
