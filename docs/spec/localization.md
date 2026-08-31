# Localization — Spec

> **Gap:** Shared UI text, user-facing errors, authored native-shell text, and the
> embedded editor resolve from the catalogs on desktop, Android, and iOS. Android's
> in-app language dropdown remains unwired.

## Scope

- A catalog localizes the application UI. It does not promise a complete workflow
  for its language. Search tokenization, IME acceptance, locale-aware word
  selection, and non-ASCII tag rules remain separate work.
- Localized UI includes visible labels, navigation, settings, menus, tooltips,
  alerts, toasts, errors, empty states, permission explanations, accessibility
  text, editor controls, CodeMirror phrases, share-sheet titles, and other text
  authored by FUTO Notes.
- The operating system continues to own and localize its own text. Text that FUTO
  Notes must provide to an operating-system surface is sourced from the shared
  catalog and generated into that platform's required resource format.
- Note content, filenames, note titles, tags, URLs, identifiers, protocols, test
  data, diagnostics, logs, and crash payloads are not translated. Debug-only
  controls and other authored application UI are localized; errors thrown by
  those controls remain fixed English diagnostics.
- Right-to-left language metadata mirrors application chrome. It does not change
  the direction of user-authored note content.

## Authored catalogs

- `languages/<language-tag>.json` is the only authored source for UI text on all
  platforms. Each file is UTF-8 JSON and its canonical BCP 47 filename is its
  language tag.
- A catalog contains the exact root envelope and message shapes defined by
  [`languages/catalog.schema.json`](../../languages/catalog.schema.json).
  [`languages/README.md`](../../languages/README.md) is the authoring guide.
- Catalog metadata consists only of `englishName`, `nativeName`, `direction`,
  and `aliases`. `direction` is `ltr` or `rtl`. Aliases are explicit requested-tag overrides.
  Each alias receives the catalog's generated Android and iOS resources but does
  not become a separate in-app language choice.
- Authored catalogs use nested objects. Call sites use literal, dot-separated
  paths such as `settings.language.heading`; the loader may flatten them
  internally.
- Adding a structurally valid catalog file is the only required source change for
  a language. Build generation bundles it on every platform, adds it to desktop
  and Android choices, and updates Android and iOS supported-language metadata.
  There is no language registry or separately advertised-language state.
- Every structurally valid catalog appears as an available language even when it
  is incomplete. Missing messages use the fallback rules below.
- English is the source catalog and final message fallback. It declares the
  placeholder names that translations may use.
- The initial catalog set is English (`en`) and Simplified Chinese (`zh-Hans`).
  With those files present, desktop and Android show System, English, and
  简体中文.

## Message paths

- Every path segment uses lower camel case. The first segment owns the feature,
  intermediate segments add context, and the leaf states the message's meaning or
  role. A path has no required depth.
- Paths describe meaning, not current English text, widget position, or a numbered
  message. A group cannot also be a message.
- Platforms use the same path for the same semantic promise. A platform-specific
  path names the exact platform at the divergence point, such as
  `settings.language.ios.openSystemSettings`.
- A path is reused only when its semantic meaning is identical. The `common`
  group is reserved for intentionally universal behavior, not coincidentally
  equal English text.
- Call sites and generated manifests contain full literal paths. They do not
  construct paths dynamically. Version 1 has no generated key constants.
- A path rename or deletion changes every call site and catalog in the same
  change. Obsolete path aliases are not retained.
- A visible-text control lets the operating system derive its accessible name.
  Icon-only and custom controls use dedicated `accessibilityLabel` paths, and
  extra explanation uses `accessibilityHint`. Custom UI may reuse its visible
  text path when the accessible value must be identical.

## Message values

- A message leaf is either a non-empty plain string or a plural object containing
  exactly `plural` and `variants`.
- Plain strings use `{lowerCamelCase}` placeholders. Arguments are strings or
  numbers. Inserted values are never parsed as templates.
- A value returned by a localization formatter, such as
  `localizedRelativeTime`, may be passed through a placeholder. It remains one
  formatted value rather than a recursive message reference.
- `{{` and `}}` write literal braces. For example, `Write {{count}}` renders as
  `Write {count}`.
- Messages are plain text. They contain no HTML, Markdown, styling, leading or
  trailing whitespace, or whitespace-only values. Newlines are allowed.
- A message contains its own punctuation and forms a complete thought. Callers do
  not concatenate translated sentence fragments.
- A plural argument is a nonnegative integer and selects a cardinal plural.
  Exact variants such as `=0` are checked before its CLDR category.
- Plural variants may use exact nonnegative integer selectors and the CLDR
  categories `zero`, `one`, `two`, `few`, `many`, and `other`. `other` is
  required; all other variants are optional. A translation may add categories
  required by its language.
- If the selected category is absent, the same message's `other` variant is used.
  Nested plurals, gender or select variants, ordinals, recursive message
  references, and date, currency, or unit syntax are not supported.
- Numbers inserted into a message are formatted for the effective language and
  the device's regional preferences. Plural selection uses the raw integer before
  that formatting.
- The UI receives the final plain string. Existing controls retain their own
  typography, color, layout, and other presentation properties.

## Localization module

- The module's lookup interface is
  `localizedText(path, arguments?) -> plain string`. Lookup is synchronous and
  performs no I/O.
- `arguments` is an optional map from placeholder names to string or number
  values.
- A caller does not pass a language, plural category, fallback, or English source
  string. The catalog decides whether a path is plain or plural; there is no
  separate plural lookup.
- The module exposes a read-only `effectiveLanguage` object and an
  `availableLanguages` list. Each language object contains only `tag`,
  `nativeName`, and `direction`; aliases remain internal.
- The module does not expose raw catalogs, `hasKey`, or mutable language selection.
  Platform adapters own selection because their lifecycle rules differ.
- Adapters expose localization as reactive state. A language change invalidates
  visible UI and replaces text immediately.
- UI state never persists translated output. Delayed UI such as dialogs, toasts,
  and visible errors stores a semantic descriptor containing `path` and
  `arguments`, or a structured error code, and resolves it when rendered.
- User-facing failures are localized from stable error codes. The underlying
  Rust or platform diagnostic and every crash report remain in English.
  Diagnostics never include localization argument values or private note titles.

## Language selection

- Language selection is local to one device and never syncs with notes.
- System is the first choice. Other choices display each catalog's `nativeName`
  and sort by `englishName` with English platform collation. They use no flag or
  translated exonym.
- Changing language updates all visible application text immediately, including
  open dialogs, errors, accessibility text, and editor controls. It does not
  change note content, filenames, search behavior, or sort behavior.
- Desktop provides an in-app dropdown. It applies the selection reactively and
  saves it as a local preference. If saving fails, the session keeps the selected
  language and shows a localized warning.
- Desktop resolves System at launch and whenever the app returns to the
  foreground. It does not poll. A stored language that is invalid or no longer
  available becomes System, and desktop saves that correction.
- Android provides an in-app dropdown that reads and writes the operating
  system's per-app language setting. Selecting System clears the override. A
  change made in Android system settings and a change made in the app therefore
  share one source of truth.
- Android's operating system relaunches the activity to apply a language change.
  Declaring the locale configuration change does not prevent that relaunch. The
  current editor draft settles first; if settling fails, the language does not
  change and a localized save error appears. The relaunch restores
  the route from saved instance state, so the user returns to the screen they were
  on — including after several language changes made from Android's own settings
  while the app was in the background — for every route [nav.md](nav.md) restores. →
  SettingsScreen.kt / AppNavigation.kt / AppNavigationTest.kt _(Android)_
- Android's language row shows the catalog actually in effect, so a regional
  override such as `en-US` reads as English rather than falling back to System. →
  SettingsScreen.kt / AndroidLocalizationTest.kt _(Android)_

> **Gap:** Android's language-change relaunch briefly blanks the whole display and
> loses editor state. The blank is the system's window gap, not a surface the app
> can paint, and no `configChanges` declaration suppresses the relaunch. Restorable
> routes and the settled draft survive; the open note, cursor, editor scroll and
> undo history do not, because they live in the CodeMirror WebView the relaunch
> destroys. Eliminating all of it requires an app-owned language preference instead
> of the operating system's per-app locale — the app reads no Android string
> resources, so a switch could apply in-process with nothing torn down. Deliberately
> not taken: it trades this spec's single source of truth with the OS for two
> sources and a precedence rule (2026-08-31).
- iOS provides no in-app dropdown. Its Language row opens FUTO Notes in system
  Settings, where the operating system owns selection. Returning to the app or
  relaunching resolves the change immediately and preserves the existing
  background draft behavior.
- Android and iOS let the operating system discard an override for a catalog that
  is no longer available.

## Language matching and message fallback

- Language matching is fully offline. Desktop uses bundled `Intl` and Unicode
  data, Android uses bundled ICU data, iOS uses ICU4X data compiled into the
  existing Rust library, and every catalog is bundled with the app.
- System reads the operating system's ordered preferred-language list and tries
  each entry before falling back to English.
- A requested tag is canonicalized, then matched to an exact catalog filename,
  then to an explicit catalog alias.
- If neither match exists, requested and available tags are maximized with
  Unicode CLDR likely-subtag data. Candidates must keep the same base language
  and the same known script. A generic compatible catalog is preferred. Without
  one, a match is used only when exactly one compatible candidate remains.
- The matcher never guesses between multiple regional candidates; an explicit
  alias is required. It never crosses known scripts, so `zh-Hant` cannot select
  `zh-Hans`.
- With only `en` and `zh-Hans`, `zh`, `zh-CN`, and `zh-SG` select `zh-Hans`;
  `zh-TW` and `zh-Hant` continue to the next preferred language or English; and
  `en-US` selects `en`.
- A missing message falls back through the effective catalog, a real compatible
  generic catalog when present, and English. If English also lacks the message,
  the semantic path is displayed.
- A fallback plural uses the plural rules of the catalog that supplied the
  message. An English fallback therefore uses English rules. Text direction
  remains that of the effective selected language.

## File sizes and relative time

- File sizes use decimal units: 1 KB is 1,000 bytes. `localizedFileSize(bytes)`
  selects bytes, kilobytes, megabytes, gigabytes, or terabytes; scales the value;
  rounds to at most one decimal place with exact half steps rounded up; removes
  trailing zeros; formats the number with platform language-region rules; and
  resolves the catalog pattern.
- Catalog paths `units.fileSize.byte`, `kilobyte`, `megabyte`, `gigabyte`, and
  `terabyte` own the unit text, placement, and spacing. Their argument is
  `{value}`. Examples are 999 bytes → `999 B`, 1,000 bytes → `1 KB`, and 1,500
  bytes → `1.5 KB` in English.
- Relative-time wording comes from `time.relative.now` and plural messages under
  `time.relative.past` and `time.relative.future` for `minute`, `hour`, `day`,
  `month`, and `year`. The past-day and future-day messages use exact `=1`
  variants for the localized equivalents of “yesterday” and “tomorrow”. Version
  1 has one natural-language presentation, not separate short and long styles.
- `localizedRelativeTime(timestamp)` uses `now` below 60 seconds, minutes below
  60 minutes, hours below 24 hours, days below 30 days, months below 365 days,
  and years thereafter.
- The platform owns numeric formatting, numbering system, calendar, time zone,
  12-hour or 24-hour preference, and any future absolute date or time formatting.
  The selected application language is combined with the device's regional
  preferences.
- Stored timestamps, filenames, protocols, and crash dates remain
  language-independent. Version 1 adds no currency, percentage, or general
  absolute-date formatter without a real caller.

> **Gap:** When no regional tag is supplied, desktop falls back to the requested
> language tag for number formatting while both native shells format with the
> region-less selected tag, so `zh-CN` formats as `zh-CN` on desktop and
> `zh-Hans` on iOS and Android. Every message case in tests/localization/cases.json
> supplies a regional tag, so the shared fixture cannot see this.

## Editor integration

- The host gives the embedded editor the effective language. A language change
  reconfigures editor labels and CodeMirror phrases without reloading the note or
  changing its content.
- FUTO editor text and the CodeMirror phrase map resolve through the same shared
  catalog and language matcher.
- The shared toolbar manifest carries a localization path instead of an English
  label. Generated Swift and Kotlin toolbar specifications carry that path, while
  command identity, order, visibility, icons, and behavior remain unchanged.
- iOS plural selection is a narrow synchronous ICU4X operation exposed through
  the existing Rust FFI. It does not create another Rust crate or a second UI
  string catalog.

## Failure behavior and checks

- A release build never crashes or returns blank text because a catalog is bad.
  Invalid non-English JSON, root shape, or required metadata skips that language
  and logs once. An invalid message leaf is ignored and falls back normally.
- A missing translation falls back silently. A missing English path displays the
  semantic path. If English is entirely unusable, the app still starts and
  displays semantic paths.
- A missing required argument leaves its placeholder visible and logs once. An
  invalid plural argument displays the semantic path and logs once.
- Catalog diagnostics are English, include the language tag, message path, and
  error type, omit argument values, and emit once per distinct problem rather
  than once per render.
- One blocking catalog test scans every catalog, collects every error, and reports
  all breaking files together. Each error names its filename, message path when
  available, and reason; the test does not stop at the first bad catalog.
- The blocking test rejects invalid JSON, duplicate keys, invalid BCP 47
  filenames, missing or invalid metadata, alias collisions, invalid nested
  shapes, empty or whitespace-padded messages, malformed braces or placeholders,
  unsupported placeholder names, invalid plural categories or exact selectors,
  plurals without `other`, and translated placeholders not declared by English.
- A separate non-blocking audit reports missing and extra messages, translation
  completeness, translations that omit English placeholders, likely stale
  translations, and other translation-quality warnings. It is allowed to fail
  and is not part of the release gate.
- Formatter and adapter behavior tests are blocking. Their shared, data-only
  vectors live in `tests/localization/cases.json`; the fixture is not an
  implementation or a formatter.
- Catalogs may be incomplete, but every value they contain must be executable and
  safe. The syntax and structure test is blocking; completeness is not.
- Catalog files are edited directly in the repository. Machine translation during
  development is allowed. Version 1 requires no translation command, service,
  pseudolocalization system, or fluent-speaker review.
