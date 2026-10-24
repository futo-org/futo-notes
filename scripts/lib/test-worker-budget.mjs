// Canonical app and editor unit suites share a process budget in local runs
// and CI. Uncapped local pools compete with native builds and peer worktrees;
// several such pools can starve tests past their deadlines. This bounds our
// own concurrency; it cannot remove CPU starvation from unrelated processes.
export const UNIT_TEST_MAX_WORKERS = 4;
