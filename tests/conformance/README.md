# Cross-language note-rule conformance

A handful of note rules legitimately exist twice: canonically in Rust
(`futo-notes-model` / `futo-notes-core`) and, because the editor needs them
synchronously on every keystroke, once more in TypeScript under
`packages/editor/src/` (plus `src/shared/note/wikilinks.ts`). AGENTS.md M6/M7 allow
that single duplication on one condition — **nothing may drift**. This directory is
how that condition is enforced.

Two mechanisms live here, and they do different jobs:

|                                | What it is                                                                 | What it proves                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `*.json`                       | Hand-reviewed **goldens**. A human decided what each rule _should_ answer. | The rules are _correct_ — and stay correct in every language that reads the file (TS, Rust, Swift, Kotlin). |
| `title-rules-differential.mjs` | A generated **differential**. No expected values at all.                   | TypeScript and Rust _agree_, over tens of thousands of adversarial inputs no human would author.            |

You need both. Goldens catch "we changed the intended behavior"; the differential
catches "we changed it in one language only". Neither subsumes the other.

## Running

```bash
just test-rust        # Rust goldens + the full differential
just test-rust-full   # the whole cargo workspace + the full differential
pnpm run test:editor:minimal   # the TypeScript side of the goldens
```

Straight from Node, with the flags that matter while debugging:

```bash
node --experimental-strip-types tests/conformance/title-rules-differential.mjs
node --experimental-strip-types tests/conformance/title-rules-differential.mjs --family=tags
node --experimental-strip-types tests/conformance/title-rules-differential.mjs --all
```

`--family=<name>` narrows to one family and marks the run PARTIAL (the coverage
guard is skipped — never take a PARTIAL run as a pass). `--all` prints every
disagreement instead of the first 25. The whole thing takes well under a second
once the Rust oracle is built; it needs `cargo`, so it runs in the
`test:rust:workspace` CI job, not the Node-only `test` job.

## The corpora

| File               | Family    | Ops                                                                                                                                                                                                                | TypeScript owner                       | Rust owner                                                                    |
| ------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- | ----------------------------------------------------------------------------- |
| `filename.json`    | title     | `sanitizeTitle`, `validateTitle`, `isValidTitle`, `isWindowsReservedName`, `validateFolderName`, `isValidFolderName`, `hasCaseInsensitiveSiblingCollision`, `validateFolderPath`, `isValidFolderPath`, `pathDepth` | `packages/editor/src/filename.ts`      | `futo-notes-core/src/files/filenames.rs` + `futo-notes-model/src/filename.rs` |
| `tags.json`        | tags      | `tagRegexMatches`, `isValidTagName`, `normalizeTagName`, `extractTags`, `extractHeaderTagBlock`                                                                                                                    | `packages/editor/src/tags.ts`          | `futo-notes-model/src/tags.rs`                                                |
| `image.json`       | image     | `isImageFilename`, `imageExtensions`                                                                                                                                                                               | `packages/editor/src/images.ts`        | `futo-notes-core/src/image.rs`                                                |
| `preview.json`     | preview   | `makePreview`                                                                                                                                                                                                      | `packages/editor/src/preview.ts`       | `futo-notes-model/src/note.rs`                                                |
| `wikilinks.json`   | wikilinks | `resolveWikilink`, `shortestUniqueSuffix`, `rewriteWikilinks`                                                                                                                                                      | `src/shared/note/wikilinks.ts`         | `futo-notes-model/src/wikilinks.rs`                                           |
| `server-url.json`  | —         | `validateServerUrl`                                                                                                                                                                                                | `src/features/sync/syncServiceE2ee.ts` | **none — see below**                                                          |
| `path-safety.json` | —         | note-id acceptance                                                                                                                                                                                                 | `src/lib/platform/pathSafety.ts`       | `futo-notes-core/src/files/paths.rs`                                          |
| `constants.json`   | —         | shared scalars                                                                                                                                                                                                     | several                                | several                                                                       |

`op` names are the language-neutral verbs every binding dispatches on. Renaming one
means touching the fixtures, the differential, the Rust dispatcher, and the native
specs in the same commit.

Who asserts what:

- Rust goldens → `crates/futo-notes-model/tests/conformance.rs`
  (`crates/futo-notes-core/tests/path_safety_conformance.rs` for path safety).
- TypeScript goldens → `packages/editor/src/conformance.test.ts`,
  `src/lib/platform/pathSafety.test.ts`, `src/lib/constantsConformance.test.ts`,
  `src/features/sync/syncServiceE2ee.test.ts`.
- Swift/Kotlin goldens → `apps/ios/Tests/Sync/ServerUrlConformanceTests.swift`,
  `apps/android/app/src/test/java/com/futo/notes/SyncManagerDefaultsTest.kt`,
  `apps/android/app/src/test/java/com/futo/notes/ui/TitleSpecTest.kt`.

## How the differential works

One shared dispatcher, two callers:

```
tests/conformance/title-rules-differential.mjs      builds the corpus, runs the TS copy
        |  [{op, input}, …]  (one JSON batch, one process)
        v
crates/futo-notes-model/examples/title_rule_oracle.rs
        |  include!
        v
crates/futo-notes-model/tests/support/rule_ops.rs   ← ALSO include!d by
                                                      tests/conformance.rs
```

`rule_ops.rs` is `include!`d rather than imported because an integration test and an
example are separate compilation units that cannot share a module, and this is test
scaffolding that must not leak into the shipped library. The point of sharing it is
that the goldens and the differential cannot end up asking about different op sets.

Everything is deterministic: fixed-seed xorshift32 per corpus, no `Math.random()`, no
clock. A red run reproduces byte-for-byte, and the failure report escapes every
non-printable character - U+0085, U+00A0, U+200B, and U+FEFF are exactly the inputs
that fail, so a report printing them raw would be useless. For the same reason every
invisible code point in the harness source is written as a `\uXXXX` escape, never as
a literal.

The corpora aim at where two languages actually part company, not at happy paths:
whitespace-ish code points, case-folding traps (final sigma, `ß`, dotted/dotless I,
Kelvin sign, ligatures), astral and combining sequences, the C0/DEL/C1 range, fence
nesting and unclosed fences, CRLF, length and depth boundaries (199/200/201,
99/100/101, 9/10/11 path components), slash runs, and ambiguous wikilink universes.

### Guards against a silent pass

A differential that skips something quietly is worse than no differential (M11):

1. **Coverage guard.** Every `op` in a `groups`-shaped fixture must be probed. A
   fixture file that is neither driven nor listed in
   `FIXTURES_OUTSIDE_THE_DIFFERENTIAL` (with the reason) fails the run — so a new
   corpus cannot arrive without a decision.
2. **Closure probes.** Each `KNOWN_DIVERGENCES` entry carries minimal inputs that
   must STILL diverge. Fix the cause and the run goes red until the entry is
   deleted, so an exclusion cannot outlive its reason.
3. **Visible suppression.** Suppressed counts print on a _green_ run. A divergence
   nobody sees is a divergence nobody fixes.

### What it deliberately does not compare

- `extractHeaderTagBlock`'s `endOffset` is a UTF-8 **byte** offset in Rust and a
  UTF-16 code-unit offset in TypeScript. Each is right for its own string type; they
  only coincide for ASCII. The differential compares `endOffset` for ASCII inputs and
  always compares the representation-independent `remainder`, so the block boundary
  itself stays fully locked.
- **Lone surrogates.** A Rust `&str` cannot hold one, so there is no answer to
  compare. They are absent from every corpus on purpose.
- **`server-url.json`.** `validateServerUrl` has no Rust implementation at all: it is
  hand-written three times, in TypeScript, Swift, and Kotlin (see the
  `validate-server-url` entry in `scripts/drift-registry.json`), and each shell
  asserts this fixture from its own unit test. With no second implementation
  reachable from Node there is nothing to differentiate against — for this rule the
  fixture _is_ the lock. Growing it means also bumping the hard-coded case count in
  `SyncManagerDefaultsTest.kt` and re-running both native suites.
- **`path-safety.json`.** `safe_note_path` takes a vault root and returns a resolved
  path, so it is not answerable through the pure `futo-notes-model` oracle. Locked by
  the fixture plus the TS and Rust tests listed above.

## Recorded divergence

One entry is live in `KNOWN_DIVERGENCES` today, found the first time the differential
reached past the title family:

> **`js-\s-versus-unicode-white_space`** — JS `/\s/` and `String.prototype.trim()`
> versus Rust `char::is_whitespace()` (Unicode White_Space) and the regex crate's
> `\s` disagree on exactly two code points, in opposite directions. **U+0085** (NEL)
> is White_Space but not JS `\s`; **U+FEFF** (BOM/ZWNBSP) is JS `\s` but not
> White_Space. Every rule that asks "is this whitespace?" parts company there: tag
> left/right boundaries, the header tag-block line test, tag-name normalization, and
> the preview trim (374 probes). The reviewed goldens are ASCII, so they never saw
> it. The realistic case is a BOM-prefixed note written by a Windows editor: its
> sidebar preview and tag set differ depending on which side computed them.

Closing it means teaching the TypeScript copies Unicode White_Space
(`/\p{White_Space}/u` plus a matching trim). That is a real behavior change on a
per-keystroke path, so it belongs in its own MR with a `docs/spec/` line — not
smuggled in with test tooling.

## Adding to this

**A new case for an existing rule.** If it is a _behavior_ you want pinned, add it to
the golden JSON by hand, with its reviewed `expected`, and make sure both languages
pass. If you just want more agreement pressure, add the input to the matching corpus
builder in the differential — no `expected` to author.

**A new op.** Three places, one commit: the TypeScript function in `TS_OPS`, a `match`
arm in `crates/futo-notes-model/tests/support/rule_ops.rs`, and an entry in the
owning family's `probes()`. If the op appears in a golden fixture but you forget the
last step, the coverage guard fails and names it.

**A new rule family.** Add a `FAMILIES` entry with a `probes()` that yields
`{ op, input }` for every op its fixture uses, plus a corpus builder that goes after
the adversarial cases rather than the easy ones. If the rule has no Rust
implementation, it does not belong in the differential — say so in
`FIXTURES_OUTSIDE_THE_DIFFERENTIAL` and lock it with a fixture instead.

**A rule change (M7).** Change canonical Rust _and_ the TypeScript copy, update the
reviewed goldens, run `just test-rust` and `pnpm run test:editor:minimal`, and record
the behavior change in `docs/spec/`. If the change is title-shaped, also
`just title-spec` for the native constants.

## What this replaces

This supersedes `tests/conformance/generate.mjs`, a 679-line fixture generator that
was deleted in !201. The generator computed each golden's `expected` by _executing the
TypeScript implementation_, which had two problems: the goldens encoded whatever TS
did rather than what a human had approved, and the only cross-language check was
whichever inputs someone had hand-listed in the generator (a few hundred, almost all
ASCII).

Its two jobs are now split, and both are stronger:

- _Holding the corpora honest_ → the goldens are hand-reviewed and edited directly;
  no generator can quietly rewrite an expectation to match a regression.
- _Proving TypeScript and Rust agree_ → this differential, over ~22,500 adversarial
  probes across 21 ops instead of a few hundred curated ones. It found a real
  divergence the generator's corpus could not reach.

Where the differential is red-proofed: perturb one side of one rule (drop a
character from a class, shorten a limit, drop an extension) and it must fail naming
the family, the op, the input, and both answers. Do that before trusting a green run
you have changed the harness for.
