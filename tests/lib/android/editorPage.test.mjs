import { describe, expect, it, vi } from 'vitest';
import { createAndroidDevice } from './device.mjs';
import { openEditorPage } from './editorPage.mjs';

describe('opening a seeded Android editor note', () => {
  it.each(['offscreen', 'visible composite label'])(
    'resolves the %s root note before its single label-based tap',
    async (kind) => {
      const opened = new Error('fixture tap reached the seeded note');
      let visible = kind === 'visible composite label';
      const adb = {
        forceStop: vi.fn(),
        launch: vi.fn(),
        writeFile: vi.fn(),
        shell: vi.fn((command) =>
          command === 'wm size'
            ? 'Physical size: 720x1600'
            : 'InsetsSource type=statusBars frame=[0,0][720,48]',
        ),
        dumpUiXml: vi.fn(() =>
          visible
            ? `<node text="${kind === 'visible composite label' ? 'ZZZ seeded&#10;body' : 'ZZZ seeded'}" bounds="[32,1000][600,1100]" clickable="true" />`
            : '<node text="AAA already visible" bounds="[32,300][600,400]" clickable="true" />',
        ),
        swipe: vi.fn(() => {
          visible = true;
        }),
        tapPoint: vi.fn(() => {
          throw opened;
        }),
      };
      const device = createAndroidDevice({ adbClientFactory: () => adb });
      // Engine/bootstrap readiness does not make a LazyColumn row visible.
      device.state = vi.fn(async () => ({
        vaultPath: '/fixture/vault',
        notes: 25,
        shellVisible: true,
      }));
      device.waitForState = vi.fn(async () => ({ shellVisible: true, onboarding: false }));
      const waitFor = device.waitFor;
      device.waitFor = (description, predicate, options) =>
        waitFor(description, predicate, { ...options, timeoutMs: 30, pollIntervalMs: 0 });

      await expect(
        openEditorPage(device, { root: '/fixture/worktree', noteTitle: 'ZZZ seeded' }),
      ).rejects.toBe(opened);
      if (kind === 'offscreen') expect(adb.swipe).toHaveBeenCalled();
      else expect(adb.swipe).not.toHaveBeenCalled();
      expect(adb.tapPoint).toHaveBeenCalledExactlyOnceWith(316, 1050);
    },
  );
});
