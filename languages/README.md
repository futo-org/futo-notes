# Language catalogs

This directory is the authored source for FUTO Notes UI text on every platform.
The product behavior is defined in
[`docs/spec/localization.md`](../docs/spec/localization.md). The machine-readable
file shape is defined in [`catalog.schema.json`](catalog.schema.json).

## Add or edit a language

1. Create or edit one UTF-8 JSON file named with its canonical BCP 47 language
   tag, such as `en.json` or `zh-Hans.json`.
2. Keep `$schema` set to `./catalog.schema.json` and provide `nativeName`,
   `direction`, and `aliases`.
3. Put translated UI text below `messages`. Catalog objects are nested; call
   sites use the equivalent dot-separated path.
4. Run `pnpm run check:languages`. It reports all invalid catalog files and
   message paths together. `pnpm run audit:languages` is the separate,
   non-blocking completeness audit.

Anyone may edit a catalog directly. Machine translation during development is
allowed. There is no translation command or required external service or review.
A catalog can be incomplete; missing values fall back according to the product
spec. Anything present must satisfy the schema and message rules.

Adding a valid catalog file is the only source change required for a language.
The build will discover and bundle it and generate required platform language
metadata. Do not add a registry entry or platform-specific copy of its UI text.

`tests/localization/cases.json` holds data-only matching and formatting examples
that every platform adapter runs. Add a case when shared behavior changes; do
not put implementation logic in the fixture.

## Complete file shape

```json
{
  "$schema": "./catalog.schema.json",
  "language": {
    "nativeName": "English",
    "direction": "ltr",
    "aliases": []
  },
  "messages": {
    "settings": {
      "language": {
        "heading": "Language",
        "systemOption": "System"
      }
    },
    "notes": {
      "delete": {
        "confirmation": "Delete {noteTitle}?"
      },
      "count": {
        "plural": "count",
        "variants": {
          "=0": "No notes",
          "one": "{count} note",
          "other": "{count} notes"
        }
      }
    }
  }
}
```

The filename is the language tag. Do not repeat it inside the file. `nativeName`
is the name shown to speakers of that language. `direction` is `ltr` or `rtl`.
`aliases` contains only deliberate requested-tag overrides and can be empty.
An alias selects this catalog at runtime and receives the same generated Android
and iOS resources; it does not create another in-app language choice.

## Paths

- Use nested objects in catalogs and lower camel case for every path segment.
- Let the first segment own the feature, such as `settings`, `notes`, `editor`,
  or `sync`. Add only as much context as the meaning needs.
- Name meaning, not English wording, screen position, or a message number.
- Reuse a path only for the same semantic promise. Use `common` only for text
  that is intentionally universal.
- Name a true platform difference at the point of divergence, such as
  `settings.language.ios.openSystemSettings`.
- Do not write dotted paths in a catalog. Do not let an object be both a message
  and a group. `plural` and `variants` are reserved for plural leaves.

## Text and placeholders

A plain message is a non-empty string:

```json
"confirmation": "Delete {noteTitle}?"
```

Placeholder names use lower camel case. Their runtime values are strings or
numbers. Keep punctuation and the complete thought in the message. Do not use
HTML, Markdown, styling, leading or trailing whitespace, or sentence fragments
that a caller must join.

Use `{{` and `}}` for literal braces. `Write {{count}}` renders as
`Write {count}`. Inserted values are never parsed again.

## Plurals

A plural message contains exactly `plural` and `variants`:

```json
"count": {
  "plural": "count",
  "variants": {
    "=0": "No notes",
    "one": "{count} note",
    "other": "{count} notes"
  }
}
```

The plural argument is a nonnegative integer. Exact selectors such as `=0` run
before CLDR cardinal categories. Allowed categories are `zero`, `one`, `two`,
`few`, `many`, and `other`; `other` is required. Add only the categories the
language needs. Plurals do not nest, and version 1 has no gender, select,
ordinal, message-reference, date, currency, or unit expression syntax.

Translations may reorder or omit English placeholders, but they may not add a
placeholder that English does not declare. An omitted English placeholder is a
non-blocking audit warning.
