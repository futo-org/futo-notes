# App localization architecture

Date: 2026-08-26
Status: accepted contract; foundation implemented

The earlier platform-native catalog proposal is superseded. FUTO Notes will use
one authored JSON catalog per language for the desktop, iOS, Android, and shared
CodeMirror UI. The exact behavior is in
[`docs/spec/localization.md`](../spec/localization.md), and the authored format is
in [`languages/`](../../languages/).

## Ownership and seams

- `languages/` owns shared UI text and its schema. A new valid language file is
  the only authored source change required to add that language.
- Each shell exposes the same narrow localization interface for catalog loading,
  language matching, fallback, placeholder replacement, plural selection, file
  sizes, and relative time. Shared behavior vectors keep the necessary platform
  adapters aligned and keep those policies out of UI call sites.
- Desktop, iOS, and Android adapters own operating-system language selection,
  lifecycle changes, reactive invalidation, and required native resource
  generation. They do not own duplicate UI strings.
- Rust and platform APIs return stable error meaning plus English diagnostics.
  The presenting UI localizes that meaning, while logs and crash reports preserve
  the English diagnostic.
- The shared editor receives the effective language and resolves FUTO controls
  and CodeMirror phrases through the same catalog. The toolbar manifest projects
  localization paths, not translated text.

## Deliberate tradeoff

This design favors one obvious editable source over each platform's native
catalog workflow. Version 1 does not get native extraction, native catalog
previews, translator tooling, or full compile-time checks from Xcode and Android
resources. It generates only the native metadata and app-authored operating-system
resources that the platforms require.

If localization later needs those native benefits, the shared source can be
replaced by separate Apple, Android, and web catalogs. That migration is not part
of version 1.

iOS still needs CLDR plural categories. A narrow synchronous ICU4X operation in
the existing Rust FFI supplies them; there is no Apple-only marker catalog and no
new Rust crate.

## Authoring workflow

Catalogs are edited directly in the repository and may be machine-translated
during development. Version 1 has no translation command, translation-management
service, pseudolocalization pipeline, or required fluent-speaker review. Syntax
and executable message structure block a change; completeness and translation
quality are a non-blocking audit.

This UI-localization contract does not establish complete Chinese workflow
support. Search and IME work remain separate, as described in
[`simplified-chinese-support.md`](simplified-chinese-support.md).
