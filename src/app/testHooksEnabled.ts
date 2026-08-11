/**
 * Whether this build may install a test-automation hook on `window`.
 *
 * True for a dev server and for a build made with `VITE_INCLUDE_TEST_HOOKS=true`
 * (how `just test-cross-platform` builds the desktop binary it drives); false for
 * anything shipped.
 *
 * One function because every hook surface has to answer this the same way, and
 * one of them didn't: `installDevelopmentHooks` was gated while
 * `installNotesShellTestHook` was installed unconditionally. That was survivable
 * while the shell hook only read state, and stopped being survivable when it
 * gained `setEditorFocused`, which drives real sync code — a shipped build was
 * then one `window.__notesShellTest.setEditorFocused(true)` away from believing
 * the editor is focused forever, which parks every incoming peer edit.
 */
export function testHooksEnabled(): boolean {
  return import.meta.env.DEV || import.meta.env.VITE_INCLUDE_TEST_HOOKS === 'true';
}
