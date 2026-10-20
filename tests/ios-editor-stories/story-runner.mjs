/**
 * The claimed simulator, the story filter and `check`, which runs one story and records its result.
 */

import { iosStoryScreenshotPath } from '../lib/ios/axeClient.mjs';
import { createIosDevice } from '../lib/ios/device.mjs';

export const device = createIosDevice();
export const results = [];
// `node tests/ios-editor-stories.mjs self-link` runs only the stories whose
// name contains the argument.
// IOS_STORY_FILTER=<substring> is the same filter for a loop of fresh runs.
const storyFilter = (process.argv[2] ?? process.env.IOS_STORY_FILTER)?.toLowerCase();

export async function check(name, fn) {
  if (storyFilter && !name.toLowerCase().includes(storyFilter)) return;
  const start = Date.now();
  try {
    await fn();
    results.push({ name, pass: true });
    console.log(`  ✓ ${name} (${Date.now() - start}ms)`);
  } catch (error) {
    let screenshot = null;
    try {
      screenshot = device.screenshot(
        iosStoryScreenshotPath(device.client.udid, 'ios-editor-story-failure.png'),
      );
    } catch {
      // A failed screenshot must not mask the original story failure.
    }
    const detail = screenshot ? `${error.message} (screenshot: ${screenshot})` : error.message;
    results.push({ name, pass: false, error: detail });
    console.log(`  ✗ ${name} (${Date.now() - start}ms) — ${detail}`);
  }
}
