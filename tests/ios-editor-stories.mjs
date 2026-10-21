#!/usr/bin/env node
/**
 * User-level iOS editor stories against one explicitly claimed simulator.
 *
 * The sustained-typing story guards the v1.7.0 autosave regression where the
 * next keystroke canceled an in-flight save after its flush was already
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
 *   IOS_TEXT_INPUT=softwareKeyboard just test-ios-stories # iOS 27 HID fallback
 */

import { homeFromAStreamingEditedNote } from './ios-editor-stories/background-story.mjs';
import {
  quickBackFromAStreamingEditedNote,
  wikilinkPopOfALargeEditedNote,
} from './ios-editor-stories/linking-stories.mjs';
import { selfLinkRenameThenType } from './ios-editor-stories/self-link-story.mjs';
import { check, device, results } from './ios-editor-stories/story-runner.mjs';
import { sustainedTyping } from './ios-editor-stories/sustained-typing-story.mjs';

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
