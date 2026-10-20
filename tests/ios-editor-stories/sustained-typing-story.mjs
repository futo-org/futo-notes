/**
 * Story: sustained human-cadence typing into a seeded note.
 */

import { describeVaultViolations, vaultInvariant } from '../lib/vaultInvariant.mjs';
import { device } from './story-runner.mjs';

const SEEDED_NOTE = 'Autosave cadence.md';
const SEEDED_TITLE = 'Autosave cadence';
const SEEDED_BODY = '';
export const TXT_MIGRATION_SENTINEL = '.txt-migration-done';
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

export async function sustainedTyping() {
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
