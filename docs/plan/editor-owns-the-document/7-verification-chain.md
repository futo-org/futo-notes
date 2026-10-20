## 7. Verification chain (report every command and result; M18)

- Bundle: `pnpm run test:editor:minimal`; `npx playwright test --config playwright.editor-embed.config.ts`
  (all three `editor-embed-milkdown*.spec.ts`); `pnpm exec vitest run packages/editor src/features/editor`.
- Contract: `just bridge-spec-check`, `just check-drift`, `pnpm run check:languages` (new catalog key).
- Desktop regression: `just check`; the desktop Playwright suite; `tests/note-never-emptied.spec.ts`.
- Android: `just test-android-native` (unit); device: `just android-native` on a claimed pool
  device (`eval "$(just qa-claim android)"`), then the stories in §8.
- iOS (Mac over Tailscale, see memory `reference_mac_ssh_ios_builds`): `just test-ios-native`,
  `just test-ios-stories` (runs the wikilink-pop story's automated steps), then §8 by hand.
- Cleanup: the §10.5 proof gates print nothing; `just lint-swift` clean on `EditorWebView.swift`.
- Before merge: `just prepush`.

Perf guard (M5): typing must not post per keystroke. Assert in a Playwright test that N
keystrokes inside one debounce window produce exactly one `edited` and one `change`.
