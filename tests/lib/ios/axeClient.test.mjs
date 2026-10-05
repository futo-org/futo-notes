import { describe, expect, it } from 'vitest';

import { iosStoryScreenshotPath } from './axeClient.mjs';

describe('iOS story screenshot paths', () => {
  it('separates the same screenshot name by worktree slot and simulator', () => {
    const simulator = '6DEFEA56-0FEA-4994-9AB4-CBDC759E05FA';
    const firstWorktree = iosStoryScreenshotPath(
      simulator,
      'ios-editor-story-failure.png',
      '/worktrees/ios-story-first',
    );
    const secondWorktree = iosStoryScreenshotPath(
      simulator,
      'ios-editor-story-failure.png',
      '/worktrees/ios-story-second',
    );
    const secondDevice = iosStoryScreenshotPath(
      'another-simulator',
      'ios-editor-story-failure.png',
      '/worktrees/ios-story-first',
    );

    expect(firstWorktree).toBe(
      'test-screenshots/ios/s43/6DEFEA56-0FEA-4994-9AB4-CBDC759E05FA/ios-editor-story-failure.png',
    );
    expect(secondWorktree).not.toBe(firstWorktree);
    expect(secondDevice).not.toBe(firstWorktree);
  });
});
