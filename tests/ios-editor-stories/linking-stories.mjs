/**
 * Stories: wikilink pop and quick back out of a large edited note.
 */

import { describeVaultViolations, vaultInvariant } from '../lib/vaultInvariant.mjs';
import { device } from './story-runner.mjs';
import { TXT_MIGRATION_SENTINEL } from './sustained-typing-story.mjs';

// RC-04 / RC-09 (2026-09-28): a system pop from a note opened through a
// wikilink re-attaches the linking note's editor BEFORE the popped note's exit
// runs. Bridge v9 flushes the outgoing edit with its note id before the
// incoming load. This story verifies the complete native navigation chain.
// docs/qa/wikilink-pop-large-edited-note.md.
const LINKING_NOTE = 'Parent.md';
const LINKING_BODY = 'Parent note body line\n\n[[Child]]\n';
const LINKED_NOTE = 'Child.md';
const LINKED_SECTIONS = 40_000;
/** A note large enough that its tail is still streaming while the story types. */
export const largeNoteBody = (sections) =>
  Array.from(
    { length: sections },
    (_, i) => `## Section ${i}\n\nBody line ${i} with some **bold** text.`,
  ).join('\n\n') + '\n';
const LINKED_BODY = largeNoteBody(LINKED_SECTIONS);
const POP_MARKER = 'POPMARKER';
// The chip has no AX node. It renders on the third body line of the linking
// note, at this point on the pool's iPhone 17 Pro (402 pt wide).
const LINK_CHIP_POINT = { x: 40, y: 221 };
// The linked note's first body line, on the same device.
const LINKED_BODY_POINT = { x: 120, y: 181 };

/**
 * Straight into the first body paragraph: the title-first dance of
 * focusEditorBody outlasts a large note's stream. The native accessory's Bold
 * button exists only while the body owns focus. A large note on a loaded host
 * can take well over 10 s to accept it; this is a precondition wait, not a
 * budget.
 */
export async function focusFirstBodyParagraph(what) {
  let lastTapAt = 0;
  await device.waitFor(
    `${what} to take focus`,
    () => {
      if (JSON.stringify(device.client.describeUiTree()).includes('"Bold"')) return true;
      if (Date.now() - lastTapAt >= 1_000) {
        device.client.tapPoint(LINKED_BODY_POINT.x, LINKED_BODY_POINT.y);
        lastTapAt = Date.now();
      }
      return false;
    },
    { timeoutMs: 20_000 },
  );
}

/** Whether the native title field shows `title` (the open note's name). */
export function titleFieldReads(title) {
  const visit = (node) =>
    Array.isArray(node)
      ? node.some(visit)
      : (node?.type === 'TextField' && node.AXValue === title) ||
        (node?.children ?? []).some(visit);
  return visit(device.client.describeUiTree());
}

export async function wikilinkPopOfALargeEditedNote() {
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
  await focusFirstBodyParagraph('the linked note body');
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

// RC-77 (2026-09-29): a system Back straight after typing into a large note
// whose tail is still streaming. The editor withholds `change` while it
// streams, so only the exit's own read of the editor carries the edit — and
// the system-pop exit never made it: the attachment token it reads through was
// written into SwiftUI state from inside makeUIView, where the write is
// discarded. The whole edit was lost, with no conflict copy.
const QUICK_BACK_NOTE = 'Quick back.md';
const QUICK_BACK_TITLE = 'Quick back';
const QUICK_BACK_MARKER = 'QUICKBACK';

export async function quickBackFromAStreamingEditedNote() {
  device.resetVault();
  device.seedNote(QUICK_BACK_NOTE, LINKED_BODY);
  const before = device.vaultFiles();
  device.launch();

  await device.tapLabel(QUICK_BACK_TITLE);
  await device.waitFor('the note to open', () => titleFieldReads(QUICK_BACK_TITLE), {
    timeoutMs: 10_000,
  });
  await focusFirstBodyParagraph('the note body');
  await device.typeText(QUICK_BACK_MARKER, { keySettleMs: 60 });
  await device.tapLabel('BackButton');

  await device.waitFor(
    'the typed marker to reach the note',
    () => device.readNote(QUICK_BACK_NOTE).includes(QUICK_BACK_MARKER),
    {
      timeoutMs: 60_000,
      describeFailure: () =>
        `vault: ${JSON.stringify(device.vaultFiles())}; note ${device.readNote(QUICK_BACK_NOTE).length} bytes (seeded ${LINKED_BODY.length})`,
    },
  );
  const violations = vaultInvariant(before, device.vaultFiles(), [TXT_MIGRATION_SENTINEL]);
  if (violations.length > 0) throw new Error(describeVaultViolations(violations));
  if (!device.readNote(QUICK_BACK_NOTE).includes(`## Section ${LINKED_SECTIONS - 1}\n`)) {
    throw new Error('the note lost its tail');
  }
}
