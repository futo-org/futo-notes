/**
 * Story: sending a streaming edited note to the background.
 */

import { describeVaultViolations, vaultInvariant } from '../lib/vaultInvariant.mjs';
import { focusFirstBodyParagraph, largeNoteBody, titleFieldReads } from './linking-stories.mjs';
import { device } from './story-runner.mjs';
import { TXT_MIGRATION_SENTINEL } from './sustained-typing-story.mjs';

// RC-92 (2026-09-30): the Home button (the app switcher) straight after typing
// into a large note whose tail is still streaming. The editor withholds `change`
// while it streams, and the lifecycle flush saved only what the editor had
// reported, so the whole edit was lost. Backgrounding now reads the live editor
// first, inside a background task.
//
// The window is bounded on purpose: it is the time the OS leaves a backgrounded
// app, not a patient wait. Measured on the broken build the edit is on disk
// never (60 s of waiting in a live simulator changed nothing), while the fix
// saves it 4-10 s after Home, when the read of the settling tail answers.
const BACKGROUND_NOTE = 'Background.md';
const BACKGROUND_TITLE = 'Background';
const BACKGROUND_MARKER = 'qbackgroundmarkz';
const BACKGROUND_SAVE_WINDOW_MS = 30_000;
// 1.5x the pop story's note: the body must still be streaming when the story
// gets to type, and a cold first launch of a freshly booted simulator can take
// the 40,000-section note past its stream before the body takes focus. Not
// larger: the mailbox flush still has to settle the tail within its deadline.
const BACKGROUND_SECTIONS = 60_000;
const BACKGROUND_BODY = largeNoteBody(BACKGROUND_SECTIONS);

export async function homeFromAStreamingEditedNote() {
  device.resetVault();
  device.seedNote(BACKGROUND_NOTE, BACKGROUND_BODY);
  const before = device.vaultFiles();
  device.launch();

  await device.tapLabel(BACKGROUND_TITLE);
  await device.waitFor('the note to open', () => titleFieldReads(BACKGROUND_TITLE), {
    timeoutMs: 10_000,
  });
  await focusFirstBodyParagraph('the note body');
  await device.typeText(BACKGROUND_MARKER, { keySettleMs: 60 });
  device.pressHome();

  await device.waitFor(
    'the typed marker to reach the note before the app is suspended',
    // Case-blind: the keyboard capitalizes the first letter typed at the start
    // of a line when the simulator has just been rebooted.
    () => device.readNote(BACKGROUND_NOTE).toLowerCase().includes(BACKGROUND_MARKER),
    {
      timeoutMs: BACKGROUND_SAVE_WINDOW_MS,
      describeFailure: () =>
        `vault: ${JSON.stringify(device.vaultFiles())}; note ${device.readNote(BACKGROUND_NOTE).length} bytes (seeded ${BACKGROUND_BODY.length})`,
    },
  );
  // Nothing may run after the check: the story ends the process the way the OS
  // ends a suspended one.
  device.terminate();
  const violations = vaultInvariant(before, device.vaultFiles(), [TXT_MIGRATION_SENTINEL]);
  if (violations.length > 0) throw new Error(describeVaultViolations(violations));
  if (!device.readNote(BACKGROUND_NOTE).includes(`## Section ${BACKGROUND_SECTIONS - 1}\n`)) {
    throw new Error('the note lost its tail');
  }
}
