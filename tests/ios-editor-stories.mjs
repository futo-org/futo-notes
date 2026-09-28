#!/usr/bin/env node
/**
 * User-level iOS editor stories against one explicitly claimed simulator.
 *
 * The sustained-typing story guards the v1.7.0 autosave regression where the
 * next keystroke cancelled an in-flight save after its flush was already
 * durable. The shell skipped its baseline advance, so the following flush saw
 * its own earlier write as a peer edit and parked the draft into conflict copy
 * after conflict copy.
 *
 * The wikilink-pop story guards RC-04: the linking note overwritten with the
 * body of the large note popped off it, whose own edit was lost.
 *
 * Usage:
 *   eval "$(just qa-claim ios)"
 *   just test-ios-stories
 */

import { join } from 'node:path';

import { createIosDevice } from './lib/ios/device.mjs';
import { describeVaultViolations, vaultInvariant } from './lib/vaultInvariant.mjs';

const SEEDED_NOTE = 'Autosave cadence.md';
const SEEDED_TITLE = 'Autosave cadence';
const SEEDED_BODY = '';
const TXT_MIGRATION_SENTINEL = '.txt-migration-done';
// Exactly 45 single HID text events. A one-character AXe invocation plus the
// explicit 250ms settle interval puts the next event in the hot window around
// the 400ms autosave debounce and the durable FFI flush.
const TYPED_TEXT = '123456789012345678901234567890123456789012345';
const EXPECTED_BODY = SEEDED_BODY + TYPED_TEXT;
// The story's contract is NEVER LOSE (tiers 1–2), not byte identity: ADR-0002
// relaxed tier 3, and the Milkdown editor's normalize-once save appends exactly
// one trailing newline (docs/plan/milkdown-transition.md §5 records it). Accept
// that one designed difference and nothing else, so a lost or duplicated
// keystroke still fails byte-exactly.
const savedBodyMatches = (actual) => actual === EXPECTED_BODY || actual === `${EXPECTED_BODY}\n`;

const device = createIosDevice();
const results = [];

async function check(name, fn) {
  const start = Date.now();
  try {
    await fn();
    results.push({ name, pass: true });
    console.log(`  ✓ ${name} (${Date.now() - start}ms)`);
  } catch (error) {
    let screenshot = null;
    try {
      screenshot = device.screenshot(join('test-screenshots', 'ios-editor-story-failure.png'));
    } catch {
      // A failed screenshot must not mask the original story failure.
    }
    const detail = screenshot ? `${error.message} (screenshot: ${screenshot})` : error.message;
    results.push({ name, pass: false, error: detail });
    console.log(`  ✗ ${name} (${Date.now() - start}ms) — ${detail}`);
  }
}

async function sustainedTyping() {
  device.resetVault();
  device.seedNote(SEEDED_NOTE, SEEDED_BODY);
  const before = device.vaultFiles();

  device.launch();
  await device.waitForLabel(SEEDED_TITLE);
  await device.tapLabel(SEEDED_TITLE);
  await device.focusEditorBody();
  await device.typeText(TYPED_TEXT);

  // Finish on a condition, not a fixed post-story sleep. A conflict copy is a
  // terminal condition too: surface the vault invariant immediately instead of
  // timing out while waiting for bytes that the broken editor stopped writing.
  await device.waitFor(
    'the final autosave or a conflict-copy failure',
    () => {
      const after = device.vaultFiles();
      const violations = vaultInvariant(before, after, [TXT_MIGRATION_SENTINEL]);
      if (violations.some(({ kind }) => kind === 'conflict-copy')) return true;
      return savedBodyMatches(device.readNote(SEEDED_NOTE));
    },
    {
      timeoutMs: 30_000,
      describeFailure: () =>
        `vault: ${JSON.stringify(device.vaultFiles())}; original bytes: ${JSON.stringify(device.readNote(SEEDED_NOTE))}`,
    },
  );

  const after = device.vaultFiles();
  const violations = vaultInvariant(before, after, [TXT_MIGRATION_SENTINEL]);
  if (violations.length > 0) {
    throw new Error(describeVaultViolations(violations));
  }
  const expectedFiles = [TXT_MIGRATION_SENTINEL, SEEDED_NOTE].sort();
  if (JSON.stringify(after) !== JSON.stringify(expectedFiles)) {
    throw new Error(
      `expected one note plus the canonical migration sentinel, vault holds ${JSON.stringify(after)}`,
    );
  }
  const actual = device.readNote(SEEDED_NOTE);
  if (!savedBodyMatches(actual)) {
    throw new Error(
      `saved bytes differ: expected ${JSON.stringify(EXPECTED_BODY)}, got ${JSON.stringify(actual)}`,
    );
  }
}

// RC-04 / RC-09 (2026-09-28): a system pop from a note opened through a
// wikilink re-attaches the linking note's editor BEFORE the popped note's exit
// runs. A `change` names no note, so the popped note's edit — the whole body of
// a large note edited while its tail streamed — was saved over the linking
// note, and the popped note kept nothing. docs/qa/wikilink-pop-large-edited-note.md.
const LINKING_NOTE = 'Parent.md';
const LINKING_BODY = 'Parent note body line\n\n[[Child]]\n';
const LINKED_NOTE = 'Child.md';
const LINKED_SECTIONS = 40_000;
const LINKED_BODY =
  Array.from(
    { length: LINKED_SECTIONS },
    (_, i) => `## Section ${i}\n\nBody line ${i} with some **bold** text.`,
  ).join('\n\n') + '\n';
const POP_MARKER = 'POPMARKER';
// The chip has no AX node. It renders on the third body line of the linking
// note, at this point on the pool's iPhone 17 Pro (402 pt wide).
const LINK_CHIP_POINT = { x: 40, y: 221 };
// The linked note's first body line, on the same device.
const LINKED_BODY_POINT = { x: 120, y: 181 };

/** Whether the native title field shows `title` (the open note's name). */
function titleFieldReads(title) {
  const visit = (node) =>
    Array.isArray(node)
      ? node.some(visit)
      : (node?.type === 'TextField' && node.AXValue === title) ||
        (node?.children ?? []).some(visit);
  return visit(device.client.describeUiTree());
}

async function wikilinkPopOfALargeEditedNote() {
  device.resetVault();
  device.seedNote(LINKING_NOTE, LINKING_BODY);
  device.seedNote(LINKED_NOTE, LINKED_BODY);
  device.launch();

  await device.tapLabel('Parent');
  // The chip is page content with no AX node, so nothing on the AX tree says
  // it has rendered; the linked note's own open is the terminal condition.
  await new Promise((resolveWait) => setTimeout(resolveWait, 2_500));
  device.client.tapPoint(LINK_CHIP_POINT.x, LINK_CHIP_POINT.y);
  await device.waitFor('the linked note to open', () => titleFieldReads('Child'), {
    timeoutMs: 10_000,
  });
  // Straight into the first body paragraph: the title-first dance of
  // focusEditorBody outlasts a large note's stream. The native accessory's
  // Bold button exists only while the body owns focus.
  let lastTapAt = 0;
  await device.waitFor(
    'the linked note body to take focus',
    () => {
      if (JSON.stringify(device.client.describeUiTree()).includes('"Bold"')) return true;
      if (Date.now() - lastTapAt >= 1_000) {
        device.client.tapPoint(LINKED_BODY_POINT.x, LINKED_BODY_POINT.y);
        lastTapAt = Date.now();
      }
      return false;
    },
    { timeoutMs: 10_000 },
  );
  await device.typeText(POP_MARKER, { keySettleMs: 60 });
  await device.tapLabel('BackButton');

  await device.waitFor(
    'the popped note to save its edit, or the linking note to be overwritten',
    () =>
      device.readNote(LINKED_NOTE).includes(POP_MARKER) ||
      device.readNote(LINKING_NOTE) !== LINKING_BODY,
    { timeoutMs: 120_000 },
  );
  // A cross-note write lands after the popped note's save; give it the time
  // the original failure took to show.
  await new Promise((resolveWait) => setTimeout(resolveWait, 5_000));

  const linking = device.readNote(LINKING_NOTE);
  const linked = device.readNote(LINKED_NOTE);
  const problems = [];
  if (linking !== LINKING_BODY) {
    problems.push(
      `the linking note was overwritten (${linking.length} bytes, holds the linked body: ${linking.includes('## Section 0')})`,
    );
  }
  if (!linked.includes(POP_MARKER)) problems.push('the linked note lost the typed marker');
  if (!linked.includes(`## Section ${LINKED_SECTIONS - 1}`)) {
    problems.push('the linked note lost its tail');
  }
  if (problems.length > 0) throw new Error(problems.join('; '));
}

async function main() {
  device.requireReady();
  // Reboot only this explicitly claimed simulator so the story begins from a
  // known device state, with the boot-attached hardware keyboard disconnected
  // (while it is attached the software keyboard's keys park below the screen).
  device.restartSimulator();
  device.requireReady();
  console.log(`iOS editor stories on ${device.client.udid}:\n`);

  await check('sustained typing keeps one note and every keystroke', sustainedTyping);
  await check(
    'a wikilink pop of a large, edited note saves the edit into that note only',
    wikilinkPopOfALargeEditedNote,
  );

  const failed = results.filter((result) => !result.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    console.log('\nFailures:');
    for (const result of failed) console.log(`  ${result.name}: ${result.error}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
