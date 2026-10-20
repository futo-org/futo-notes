/**
 * Fixtures the differential does not drive, and divergences the two languages ship today.
 */

// Conformance corpora this differential deliberately does NOT drive, each with
// the reason. The coverage guard fails on any corpus that is neither driven nor
// listed here, so a new one cannot quietly arrive without a decision.
const MARKDOWN_HOUSE_STYLE_REASON =
  "The editor's markdown serializer (packages/editor/src/markdown/, #266) exists " +
  'ONCE, in TypeScript: it writes the editor document, which only the editor holds, ' +
  "and its escaping is decided by parsing with the editor's own parser. There is no " +
  'Rust implementation to differentiate against. Locked by these fixtures plus ' +
  'src/features/editor/milkdown/markdownHouseStyle.test.ts, which reads every source ' +
  'with the shipping parser.';
export const FIXTURES_OUTSIDE_THE_DIFFERENTIAL = {
  'server-url.json':
    'validateServerUrl has NO Rust implementation: the rule is hand-written three ' +
    'times, in TS, Swift, and Kotlin (scripts/drift-registry.json concept ' +
    '"validate-server-url"), and each shell asserts this fixture from its own unit ' +
    'test. With no second implementation reachable from Node there is nothing to ' +
    'differentiate against - the fixture IS the lock. Growing it also means bumping ' +
    'the case count asserted in apps/android/.../SyncManagerDefaultsTest.kt and ' +
    're-running both native suites.',
  'path-safety.json':
    'ensureSafeNoteId (TS) <-> safe_note_path (Rust) is a filesystem-path rule, not a ' +
    'note rule: the Rust side takes a vault root and returns a resolved path, so it is ' +
    'not answerable through the pure futo-notes-model oracle. Locked by this fixture ' +
    'plus src/lib/platform/pathSafety.test.ts and ' +
    'crates/futo-notes-core/tests/path_safety_conformance.rs.',
  'license.json':
    'The license rules exist ONCE, in the futo-notes-license crate: parsing, RSA ' +
    'verification, expiry and deep-link handling are not per-keystroke work, so ' +
    'AGENTS.md M6 forbids a TypeScript (or Swift/Kotlin) copy to differentiate ' +
    'against. Shells reach them through Tauri and UniFFI. Locked by this fixture ' +
    'plus crates/futo-notes-license/tests/conformance.rs.',
  'constants.json':
    'Shared scalar constants, not ops. Locked by crates/futo-notes-model/tests/' +
    'conformance.rs, src/lib/constantsConformance.test.ts, and the Tauri watcher test.',
  'sync-session-mode.json':
    'hostedConnectEntry / restoreBranch have NO Rust implementation: they are ' +
    "decisions about a SHELL's own live session state (does this manager hold a " +
    'client, in which mode) that the engine cannot see, hand-written twice in Swift ' +
    'and Kotlin (scripts/drift-registry.json concept ' +
    '"sync-session-mode-precedence"). Each native shell asserts this fixture from ' +
    'its own unit test, so the fixture IS the lock. Growing it also means bumping ' +
    'the case counts asserted in apps/ios/Tests/Sync/SyncSessionModeConformanceTests' +
    '.swift and apps/android/.../SyncSessionModeConformanceTest.kt, and re-running ' +
    'both native suites.',
  'markdown-house-style-marks-and-breaks.json': MARKDOWN_HOUSE_STYLE_REASON,
  'markdown-house-style-lists-and-code.json': MARKDOWN_HOUSE_STYLE_REASON,
  'markdown-house-style-tables-and-verbatim.json': MARKDOWN_HOUSE_STYLE_REASON,
  'markdown-house-style-escapes-and-empty-lines.json': MARKDOWN_HOUSE_STYLE_REASON,
  'markdown-house-style-spaces-and-typing.json': MARKDOWN_HOUSE_STYLE_REASON,
};

// Divergences the two languages KNOWN-ship today. Each entry names the exact op
// set and input class it excuses, why, and - crucially - minimal `probes` that
// MUST STILL diverge: if one starts agreeing, the run fails and tells you to
// narrow or delete the entry. That is the same closure-probe discipline the
// docs/spec gap list uses, and it is what stops an exclusion outliving its cause.
//
// An entry is a decision to SHIP a divergence. Keep the input class as narrow as
// the CAUSE, never as wide as the symptom, and file the follow-up.
export const KNOWN_DIVERGENCES = [
  {
    id: 'js-\\s-versus-unicode-white_space',
    // Found by this differential the first time it reached past the title family.
    why:
      'The two languages disagree about exactly two code points, in opposite ' +
      "directions. U+0085 (NEL) has the Unicode White_Space property, so Rust's " +
      "char::is_whitespace() and the regex crate's \\s accept it while JS /\\s/ and " +
      'String.prototype.trim() do not. U+FEFF (BOM/ZWNBSP) is the mirror image: JS ' +
      '\\s and trim() treat it as space, Unicode White_Space does not. Every rule ' +
      'that asks "is this whitespace?" therefore parts company on those two ' +
      'characters and only those two: tag left/right boundaries, the header ' +
      'tag-block line test, tag-name normalization, and the preview trim. The ' +
      'reviewed goldens are ASCII, so they never saw it. Rust is canonical (M6), so ' +
      'closing this means teaching the TypeScript copies Unicode White_Space ' +
      '(/\\p{White_Space}/u plus a matching trim) - a real behavior change on a ' +
      'per-keystroke path, so it wants its own MR and a docs/spec line. The ' +
      'realistic case is a BOM-prefixed note from a Windows editor: its sidebar ' +
      'preview and its tag set differ depending on which side computed them.',
    ops: new Set([
      'tagRegexMatches',
      'extractTags',
      'extractHeaderTagBlock',
      'normalizeTagName',
      'makePreview',
    ]),
    matches: (input) => typeof input === 'string' && /[\u0085\ufeff]/u.test(input),
    probes: [
      { op: 'tagRegexMatches', input: 'pre\u0085#a post' },
      { op: 'tagRegexMatches', input: 'pre\ufeff#a post' },
      { op: 'tagRegexMatches', input: 'x #a\u0085b' },
      { op: 'tagRegexMatches', input: 'x #a\ufeffb' },
      { op: 'extractTags', input: '#a\u0085#b' },
      { op: 'extractTags', input: '#a\ufeff#b' },
      { op: 'extractHeaderTagBlock', input: '#a\u0085\n\nbody' },
      { op: 'extractHeaderTagBlock', input: '#a\ufeff\n\nbody' },
      { op: 'normalizeTagName', input: 'a\u0085b' },
      { op: 'normalizeTagName', input: 'a\ufeffb' },
      { op: 'normalizeTagName', input: '\u0085Tag\u0085' },
      { op: 'normalizeTagName', input: '\ufeffTag\ufeff' },
      { op: 'makePreview', input: '\u0085content\u0085' },
      { op: 'makePreview', input: '\ufeffcontent\ufeff' },
    ],
  },
];
