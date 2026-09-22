// Generates native bridge specs from the @futo-notes/editor
// futoBridge contract (packages/editor/src/bridge.ts — the single source of
// truth for the editor <-> native host contract; see BRIDGE_VERSION there).
//
//   pnpm exec tsx scripts/gen-bridge-spec.ts --write   (just bridge-spec)
//   pnpm exec tsx scripts/gen-bridge-spec.ts --check    (just bridge-spec-check)
//
// Android consumes its generated list in BridgeCoverageTest. iOS switches on
// its generated enum, so adding a message makes the host fail to compile until
// the handler becomes exhaustive.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRIDGE_VERSION, OUTBOUND_MESSAGE_TYPES } from '../packages/editor/src/bridge';
import { updateGeneratedFiles, type GeneratedTarget } from './lib/generated-files';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function kotlinString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function swiftCase(s: string): string {
  return `    case ${s}`;
}

function renderKotlinFile(): string {
  const types = OUTBOUND_MESSAGE_TYPES.map((t) => `        ${kotlinString(t)},`).join('\n');

  return [
    '// GENERATED FILE — DO NOT EDIT.',
    '// Source of truth: packages/editor/src/bridge.ts (@futo-notes/editor).',
    '// Regenerate: `just bridge-spec`. `just bridge-spec-check` (part of',
    '// `just check`) fails when this file drifts from the contract.',
    '',
    'package com.futo.notes.ui',
    '',
    'object BridgeSpec {',
    '    /** bridge.ts BRIDGE_VERSION. EditorWebView.kt declares it in the',
    '     *  host config it sends to `FutoEditor.initialize`; the bundle compares',
    '     *  it with its own and posts `bridgeVersionMismatch` when they differ.',
    '     */',
    `    const val BRIDGE_VERSION: Int = ${BRIDGE_VERSION}`,
    '',
    '    /** Every `type` value FutoEditorOutboundMessage can carry',
    '     *  (bridge.ts OUTBOUND_MESSAGE_TYPES). BridgeCoverageTest asserts',
    '     *  EditorWebView.kt handles — or explicitly exempts — every one. */',
    '    val OUTBOUND_MESSAGE_TYPES: List<String> = listOf(',
    types,
    '    )',
    '}',
    '',
  ].join('\n');
}

function renderSwiftFile(): string {
  const cases = OUTBOUND_MESSAGE_TYPES.map(swiftCase).join('\n');

  return [
    '// GENERATED FILE — DO NOT EDIT.',
    '// Source of truth: packages/editor/src/bridge.ts (@futo-notes/editor).',
    '// Regenerate: `just bridge-spec`. `just bridge-spec-check` (part of',
    '// `just check`) fails when this file drifts from the contract.',
    '',
    'enum BridgeSpec {',
    `    static let version = ${BRIDGE_VERSION}`,
    '}',
    '',
    'enum BridgeMessageType: String {',
    cases,
    '}',
    '',
  ].join('\n');
}

const TARGETS: GeneratedTarget[] = [
  {
    rel: 'apps/android/app/src/main/java/com/futo/notes/ui/BridgeSpec.kt',
    render: renderKotlinFile,
  },
  {
    rel: 'apps/ios/Sources/Editor/GeneratedContracts/BridgeSpec.swift',
    render: renderSwiftFile,
  },
];

updateGeneratedFiles(ROOT, TARGETS, 'packages/editor/src/bridge.ts', 'bridge-spec');
