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
 * The quick-Back story guards RC-77: a system Back straight after typing into
 * a large note that is still streaming committed the pre-edit copy.
 *
 * The self-link rename story guards RC-71: renaming a note whose body links to
 * itself relinks that body in Rust, but the editor kept the pre-relink draft as
 * its baseline, so the next save parked a conflict copy and the typed text
 * landed in the copy.
 *
 * The backgrounding story guards RC-92: the Home button straight after typing
 * into the same kind of note flushed only what the editor had reported, which
 * for a streaming note is nothing.
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
// `node tests/ios-editor-stories.mjs self-link` runs only the stories whose
// name contains the argument.
// IOS_STORY_FILTER=<substring> is the same filter for a loop of fresh runs.
const storyFilter = (process.argv[2] ?? process.env.IOS_STORY_FILTER)?.toLowerCase();

async function check(name, fn) {
  if (storyFilter && !name.toLowerCase().includes(storyFilter)) return;
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
/** A note large enough that its tail is still streaming while the story types. */
const largeNoteBody = (sections) =>
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
async function focusFirstBodyParagraph(what) {
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

async function quickBackFromAStreamingEditedNote() {
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

// RC-71 (2026-09-30): rename a note whose body links to itself, through the
// native title field, then type into the body. The rename relinks the note's
// own link in Rust; the editor's baseline stayed at the pre-relink draft, so
// the next save saw disk != baseline, parked the draft as a conflict copy and
// left the typed text out of the note. docs/plan/editor-release-hardening.md.
const SELF_NOTE = 'Selfy.md';
const SELF_TITLE = 'Selfy';
const SELF_BODY = 'back to [[Selfy]]\n';
const SELF_RENAMED_NOTE = 'SelfyX.md';
const SELF_TYPED = 'qq77';
const SELF_RELINKED_BODY = 'back to [[SelfyX]]\n';
// The iOS keyboard autocapitalizes and its shift state can bend the typed
// characters; what must hold is that SOMETHING typed landed in the note, next to
// the relinked self-link. `typedLanded` checks exactly that.
const typedLanded = (body) => body.includes(SELF_RELINKED_BODY) && body !== SELF_RELINKED_BODY;

/** The native title field's centre: tapping past a short title puts the caret at its end. */
function titleFieldCentre() {
  const find = (node) => {
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = find(child);
        if (hit) return hit;
      }
      return null;
    }
    if (node?.type === 'TextField' && node.frame) return node.frame;
    return find(node?.children ?? []);
  };
  const frame = find(device.client.describeUiTree());
  if (!frame) throw new Error('no native title field on screen');
  return { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
}

async function selfLinkRenameThenType() {
  device.resetVault();
  device.seedNote(SELF_NOTE, SELF_BODY);
  const before = device.vaultFiles();
  device.launch();

  await device.tapLabel(SELF_TITLE);
  await device.waitFor('the note to open', () => titleFieldReads(SELF_TITLE), {
    timeoutMs: 10_000,
  });
  const title = titleFieldCentre();
  device.client.tapPoint(title.x, title.y);
  // The keyboard's own `done` key is the readiness signal focusEditorBody uses;
  // typing needs only the title field to hold focus.
  await device.waitFor(
    'the title field to hold focus',
    () => JSON.stringify(device.client.describeUiTree()).includes('"Caps Lock"'),
    { timeoutMs: 10_000 },
  );
  await device.typeText('X');
  await device.waitFor(
    'the title rename to relink the note to itself',
    () =>
      device.vaultFiles().includes(SELF_RENAMED_NOTE) &&
      device.readNote(SELF_RENAMED_NOTE).includes('[[SelfyX]]'),
    {
      timeoutMs: 20_000,
      describeFailure: () => `vault: ${JSON.stringify(device.vaultFiles())}`,
    },
  );

  // Tap into the first body line (the title field's frame ends just above it). The
  // typed text landing in the note is the oracle, so no toolbar wait is needed.
  device.client.tapPoint(40, title.y + 60);
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
  await device.typeText(SELF_TYPED, { keySettleMs: 60 });
  await device.waitFor(
    'the typed text to reach the renamed note, or a conflict copy',
    () => {
      const violations = vaultInvariant(before, device.vaultFiles(), [TXT_MIGRATION_SENTINEL]);
      if (violations.some(({ kind }) => kind === 'conflict-copy')) return true;
      return typedLanded(device.readNote(SELF_RENAMED_NOTE));
    },
    {
      timeoutMs: 30_000,
      describeFailure: () =>
        `vault: ${JSON.stringify(device.vaultFiles())}; note: ${JSON.stringify(device.readNote(SELF_RENAMED_NOTE))}`,
    },
  );
  // A parked copy is minted on the same save; give it the time to show.
  await new Promise((resolveWait) => setTimeout(resolveWait, 3_000));

  const files = device.vaultFiles();
  // The rename itself is a legitimate new file name; only a parked copy is a violation.
  const violations = vaultInvariant(before, files, [TXT_MIGRATION_SENTINEL]).filter(
    ({ kind }) => kind === 'conflict-copy',
  );
  const body = device.readNote(SELF_RENAMED_NOTE);
  const problems = [];
  if (violations.length > 0) problems.push(describeVaultViolations(violations));
  const expectedFiles = [TXT_MIGRATION_SENTINEL, SELF_RENAMED_NOTE].sort();
  if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) {
    problems.push(
      `vault holds ${JSON.stringify(files)}, expected ${JSON.stringify(expectedFiles)}`,
    );
  }
  if (!typedLanded(body))
    problems.push(`the renamed note lost the typed text: ${JSON.stringify(body)}`);
  if (!body.includes('[[SelfyX]]'))
    problems.push(`the renamed note lost its relinked self-link: ${JSON.stringify(body)}`);
  if (problems.length > 0) throw new Error(problems.join('; '));
}

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
// larger: the fix's read of the settling tail must still answer inside the
// three capture attempts on a loaded host.
const BACKGROUND_SECTIONS = 60_000;
const BACKGROUND_BODY = largeNoteBody(BACKGROUND_SECTIONS);

async function homeFromAStreamingEditedNote() {
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
    // Case-blind: the keyboard capitalises the first letter typed at the start
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

async function main() {
  device.requireReady();
  // Reboot only this explicitly claimed simulator so the story begins from a
  // known device state, with the boot-attached hardware keyboard disconnected
  // (while it is attached the software keyboard's keys park below the screen).
  // IOS_STORY_NO_RESTART=1 skips the reboot, for a loop of fresh runs of one
  // story on a simulator an earlier run has already put in that state.
  if (!process.env.IOS_STORY_NO_RESTART) device.restartSimulator();
  device.requireReady();
  console.log(`iOS editor stories on ${device.client.udid}:\n`);

  await check('sustained typing keeps one note and every keystroke', sustainedTyping);
  await check(
    'a wikilink pop of a large, edited note saves the edit into that note only',
    wikilinkPopOfALargeEditedNote,
  );
  await check(
    'a quick Back from a large note typed into while it streams keeps the edit',
    quickBackFromAStreamingEditedNote,
  );
  await check(
    'a self-link rename keeps one note and the text typed after it',
    selfLinkRenameThenType,
  );
  await check(
    'backgrounding a large note typed into while it streams keeps the edit',
    homeFromAStreamingEditedNote,
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
