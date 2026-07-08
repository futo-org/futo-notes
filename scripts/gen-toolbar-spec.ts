// Generates the native shells' toolbar specs from the @futo-notes/editor
// toolbar manifest (packages/editor/src/toolbar.ts — the single source of
// truth for the mobile toolbar surface).
//
//   pnpm exec tsx scripts/gen-toolbar-spec.ts --write   (just toolbar-spec)
//   pnpm exec tsx scripts/gen-toolbar-spec.ts --check   (just toolbar-spec-check)
//
// Targets:
//   apps/ios/Sources/ToolbarSpec.swift                              (consumed by EditorToolbar.swift)
//   apps/android/app/src/main/java/com/futo/notes/ui/ToolbarSpec.kt (consumed by EditorToolbar.kt)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLBAR_GROUPS, TOOLBAR_DISMISS, type ToolbarItem } from '../packages/editor/src/toolbar';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function swiftString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function swiftAction(item: ToolbarItem): string {
  const a = item.action;
  switch (a.kind) {
    case 'exec':
      return '.exec';
    case 'pickImage':
      return `.pickImage(source: ${swiftString(a.source)})`;
    case 'dismiss':
      return '.dismiss';
  }
}

function swiftItem(item: ToolbarItem, indent: string): string {
  return (
    `${indent}ToolbarItemSpec(\n` +
    `${indent}    id: ${swiftString(item.id)},\n` +
    `${indent}    label: ${swiftString(item.label)},\n` +
    `${indent}    sfSymbol: ${swiftString(item.sfSymbol)},\n` +
    `${indent}    onlyOnListLine: ${item.when === 'onListLine'},\n` +
    `${indent}    action: ${swiftAction(item)}\n` +
    `${indent})`
  );
}

function renderSwiftFile(): string {
  const groups = TOOLBAR_GROUPS.map(
    (group) =>
      `        [\n${group.map((i) => swiftItem(i, '            ')).join(',\n')},\n        ]`,
  ).join(',\n');

  const dismissBody = swiftItem(TOOLBAR_DISMISS, '    ')
    .split('\n')
    .slice(1) // drop the "ToolbarItemSpec(" line; we open it ourselves
    .join('\n');

  return [
    '// GENERATED FILE — DO NOT EDIT.',
    '// Source of truth: packages/editor/src/toolbar.ts (@futo-notes/editor).',
    '// Regenerate: `just toolbar-spec`. `just toolbar-spec-check` (part of',
    '// `just check`) fails when this file drifts from the manifest.',
    '',
    '/// What tapping a toolbar item does. `exec` dispatches',
    '/// `FutoEditor.exec(item.id)` over the bridge into the SHARED',
    '/// markdownToolbar.ts command (TOOLBAR_EXEC) — the native toolbar never',
    '/// reimplements editing semantics, so behavior is identical to the web',
    '/// toolbar by construction.',
    'enum ToolbarItemAction: Equatable {',
    '    case exec',
    '    case pickImage(source: String)',
    '    case dismiss',
    '}',
    '',
    'struct ToolbarItemSpec: Identifiable, Equatable {',
    '    let id: String',
    "    /// Accessibility label — same text as the web toolbar's aria-label.",
    '    let label: String',
    '    let sfSymbol: String',
    '    /// Only visible while the cursor is on a list line (bridge cursorContext).',
    '    let onlyOnListLine: Bool',
    '    let action: ToolbarItemAction',
    '}',
    '',
    'enum ToolbarSpec {',
    '    /// The scrollable toolbar body; groups render with a separator between.',
    '    static let groups: [[ToolbarItemSpec]] = [',
    groups + ',',
    '    ]',
    '',
    '    /// The fixed (non-scrolling) collapse chevron at the right edge.',
    '    static let dismiss = ToolbarItemSpec(',
    dismissBody,
    '}',
    '',
  ].join('\n');
}

function kotlinString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$')}"`;
}

function kotlinAction(item: ToolbarItem): string {
  const a = item.action;
  switch (a.kind) {
    case 'exec':
      return 'ToolbarItemAction.Exec';
    case 'pickImage':
      return `ToolbarItemAction.PickImage(source = ${kotlinString(a.source)})`;
    case 'dismiss':
      return 'ToolbarItemAction.Dismiss';
  }
}

function kotlinItem(item: ToolbarItem, indent: string): string {
  return (
    `${indent}ToolbarItemSpec(\n` +
    `${indent}    id = ${kotlinString(item.id)},\n` +
    `${indent}    label = ${kotlinString(item.label)},\n` +
    `${indent}    material = ${kotlinString(item.material)},\n` +
    `${indent}    onlyOnListLine = ${item.when === 'onListLine'},\n` +
    `${indent}    action = ${kotlinAction(item)},\n` +
    `${indent})`
  );
}

function renderKotlinFile(): string {
  const groups = TOOLBAR_GROUPS.map(
    (group) =>
      `        listOf(\n${group.map((i) => kotlinItem(i, '            ')).join(',\n')},\n        )`,
  ).join(',\n');

  return [
    '// GENERATED FILE — DO NOT EDIT.',
    '// Source of truth: packages/editor/src/toolbar.ts (@futo-notes/editor).',
    '// Regenerate: `just toolbar-spec`. `just toolbar-spec-check` (part of',
    '// `just check`) fails when this file drifts from the manifest.',
    '',
    'package com.futo.notes.ui',
    '',
    '/**',
    ' * What tapping a toolbar item does. `Exec` dispatches',
    ' * `FutoEditor.exec(item.id)` over the bridge into the SHARED',
    ' * markdownToolbar.ts command (TOOLBAR_EXEC) — the native toolbar never',
    ' * reimplements editing semantics, so behavior is identical to the web',
    ' * toolbar by construction.',
    ' */',
    'sealed interface ToolbarItemAction {',
    '    object Exec : ToolbarItemAction',
    '    data class PickImage(val source: String) : ToolbarItemAction',
    '    object Dismiss : ToolbarItemAction',
    '}',
    '',
    'data class ToolbarItemSpec(',
    '    val id: String,',
    "    /** Accessibility label — same text as the web toolbar's aria-label. */",
    '    val label: String,',
    '    /** Material Symbols name; EditorToolbar.kt maps it to an ImageVector. */',
    '    val material: String,',
    '    /** Only visible while the cursor is on a list line (bridge cursorContext). */',
    '    val onlyOnListLine: Boolean,',
    '    val action: ToolbarItemAction,',
    ')',
    '',
    'object ToolbarSpec {',
    '    /** The scrollable toolbar body; groups render with a separator between. */',
    '    val groups: List<List<ToolbarItemSpec>> = listOf(',
    groups + ',',
    '    )',
    '',
    '    /** The fixed (non-scrolling) collapse chevron at the right edge. */',
    '    val dismiss = ' + kotlinItem(TOOLBAR_DISMISS, '    ').trimStart(),
    '}',
    '',
  ].join('\n');
}

const TARGETS: Array<{ rel: string; render: () => string }> = [
  { rel: 'apps/ios/Sources/ToolbarSpec.swift', render: renderSwiftFile },
  {
    rel: 'apps/android/app/src/main/java/com/futo/notes/ui/ToolbarSpec.kt',
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
      `${target.rel} is STALE vs packages/editor/src/toolbar.ts — run \`just toolbar-spec\` and commit.`,
    );
    stale = true;
  } else {
    fs.writeFileSync(abs, next);
    console.log(`${target.rel}: written`);
  }
}

if (stale) process.exit(1);
