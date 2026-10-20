/**
 * Story: renaming a note that links to itself, then typing.
 */

import { describeVaultViolations, vaultInvariant } from '../lib/vaultInvariant.mjs';
import { titleFieldReads } from './linking-stories.mjs';
import { device } from './story-runner.mjs';
import { TXT_MIGRATION_SENTINEL } from './sustained-typing-story.mjs';

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

export async function selfLinkRenameThenType() {
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
