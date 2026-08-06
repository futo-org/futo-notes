// Generates the native shells' title-validation constants from the
// @futo-notes/editor title-rule manifest (packages/editor/src/filename.ts —
// the single source of truth for MAX_TITLE_LENGTH and the visible
// forbidden-title characters).
//
//   pnpm exec tsx scripts/gen-title-spec.ts --write   (just title-spec)
//   pnpm exec tsx scripts/gen-title-spec.ts --check   (just title-spec-check)
//
// Targets:
//   apps/ios/Sources/Editor/GeneratedContracts/TitleSpec.swift    (consumed by NoteEditorView.swift)
//   apps/android/app/src/main/java/com/futo/notes/ui/TitleSpec.kt (consumed by NoteEditorScreen.kt)
//
// What is generated: the visible forbidden characters and MAX_TITLE_LENGTH —
// the two pieces of data shared by every implementation. Control characters are
// spelled per language because each has its own syntax for them, but every
// template covers the same Unicode Cc set (C0, DEL, C1) that Rust's
// `char::is_control()` and the TS `CONTROL_CHARS` range reject.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FORBIDDEN_TITLE_CHARS_VISIBLE,
  MAX_TITLE_LENGTH,
} from '../packages/editor/src/filename.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function swiftString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function kotlinEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$');
}

// The visible forbidden chars need TWO escaping passes for the generated
// Kotlin regex literal: first, double the literal backslash so the
// character class matches it (regex semantics); then Kotlin-escape the
// result (backslash + quote) so it round-trips through a Kotlin string
// literal unchanged.
function kotlinRegexVisibleChars(visible: string): string {
  return kotlinEscape(visible.replace(/\\/g, '\\\\'));
}

function renderSwiftFile(): string {
  return [
    '// GENERATED FILE — DO NOT EDIT.',
    '// Source of truth: packages/editor/src/filename.ts (@futo-notes/editor).',
    '// Regenerate: `just title-spec`. `just title-spec-check` (part of',
    '// `just check`) fails when this file drifts from the manifest.',
    '',
    'import Foundation',
    '',
    '/// Characters forbidden in a note title: `< > : " / \\ | ? *` plus Unicode',
    '/// control characters, matching the canonical Rust rule. Used only for live',
    '/// input filtering; authoritative validation + messages come from Rust FFI.',
    'enum TitleSpec {',
    `    static let forbiddenScalars: CharacterSet =`,
    `        CharacterSet(charactersIn: ${swiftString(FORBIDDEN_TITLE_CHARS_VISIBLE)}).union(.controlCharacters)`,
    '',
    '    /// Max title length (chars) — matches the shared `MAX_TITLE_LENGTH`.',
    `    static let maxLength = ${MAX_TITLE_LENGTH}`,
    '}',
    '',
  ].join('\n');
}

function renderKotlinFile(): string {
  return [
    '// GENERATED FILE — DO NOT EDIT.',
    '// Source of truth: packages/editor/src/filename.ts (@futo-notes/editor).',
    '// Regenerate: `just title-spec`. `just title-spec-check` (part of',
    '// `just check`) fails when this file drifts from the manifest.',
    '',
    'package com.futo.notes.ui',
    '',
    '/**',
    ' * Characters stripped by the Android live title filter: `< > : " / \\ | ? *`',
    ' * plus the Unicode Cc control characters (C0, DEL, C1), matching the',
    ' * canonical Rust rule. The Rust FFI validator supplies authoritative',
    ' * validation + messages.',
    ' */',
    'object TitleSpec {',
    `    val forbiddenChars = Regex("[${kotlinRegexVisibleChars(FORBIDDEN_TITLE_CHARS_VISIBLE)}\\\\u0000-\\\\u001F\\\\u007F-\\\\u009F]")`,
    '',
    '    /** Max title length (chars) — matches the shared `MAX_TITLE_LENGTH`. */',
    `    const val maxLength = ${MAX_TITLE_LENGTH}`,
    '}',
    '',
  ].join('\n');
}

const TARGETS: Array<{ rel: string; render: () => string }> = [
  {
    rel: 'apps/ios/Sources/Editor/GeneratedContracts/TitleSpec.swift',
    render: renderSwiftFile,
  },
  {
    rel: 'apps/android/app/src/main/java/com/futo/notes/ui/TitleSpec.kt',
    render: renderKotlinFile,
  },
];

const mode = process.argv.includes('--check') ? 'check' : 'write';
let stale = false;

for (const target of TARGETS) {
  const abs = path.join(ROOT, target.rel);
  const next = target.render();
  const current = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  if (current === next) {
    console.log(`${target.rel}: up to date`);
    continue;
  }
  if (mode === 'check') {
    console.error(
      `${target.rel} is STALE vs packages/editor/src/filename.ts — run \`just title-spec\` and commit.`,
    );
    stale = true;
  } else {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, next);
    console.log(`${target.rel}: written`);
  }
}

if (stale) process.exit(1);
