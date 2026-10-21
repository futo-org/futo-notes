// remote-test.mjs recipe policy: which `just` recipes a Linux box can run, refuses, or runs
// with a caveat.

// ---------------------------------------------------------------------------
// Policy: what may and may not run on a Linux box
// ---------------------------------------------------------------------------

const REASONS = {
  macos: 'needs Xcode, the iOS simulator, or swift-format — macOS-only tooling. Run it on the Mac.',
  wkwebview:
    'drives the real desktop app, whose web engine is WKWebView on macOS and WebKitGTK on Linux. ' +
    'A green Linux run can neither confirm nor refute a paint/compositing/timing regression in the ' +
    'engine we ship on macOS (the same reasoning as M22 for WebView2). Run it on the Mac.',
  interactive: 'is an interactive dev/QA command, not a suite — it needs a display and a human.',
  sudo: 'installs a system package; jfedora has no passwordless sudo, so it would hang or fail.',
  localMachine:
    'manages THIS machine’s device pool / worktrees. Run remotely it would claim devices and ' +
    'directories you cannot reach.',
};

// Matched against the recipe name AFTER justfile alias resolution, so
// `node scripts/remote-test.mjs in` (alias for ios-native) is refused too.
const REFUSED = [
  // Xcode / iOS simulator / Swift toolchain.
  ['build-rust-ios', 'macos'],
  ['build-ios-native', 'macos'],
  ['test-ios-native', 'macos'],
  ['test-ios-stories', 'macos'],
  ['ios-native', 'macos'],
  ['ios-native-device', 'macos'],
  ['deploy-ios', 'macos'],
  ['lint-swift', 'macos'],
  [/^sim-/, 'macos'],
  // Runs the shipped desktop app or the editor in a browser engine.
  ['test-desktop-smoke', 'wkwebview'],
  // Interactive.
  ['tauri-dev', 'interactive'],
  ['android-drive', 'localMachine'],
  ['journal', 'localMachine'],
  // Needs root.
  ['deploy-deb', 'sudo'],
  ['deploy-rpm', 'sudo'],
  // Device-pool bookkeeping for the machine you are sitting at.
  ['qa-claim', 'localMachine'],
  ['qa-release', 'localMachine'],
  ['qa-gc', 'localMachine'],
  ['qa-clone-target', 'localMachine'],
];

// Allowed, but the reader gets told what a green run does and does not prove.
// `check` is deliberately NOT here: it is tsc + eslint + prettier +
// svelte-check + vitest (jsdom) + vite build + the Rust conformance tests, none
// of which touch a real web engine, so a Linux `check` is equivalent to a macOS
// one. `prepush` IS here, because it adds the full Playwright suite and
// cross-platform sync (both of which boot a browser engine) on top of `check`.
const CAVEATED = [
  [
    /^(test-e2e|test-e2e-rest)$/,
    'Playwright here runs Linux Chromium/WebKit builds. Behavior and state are equivalent; ' +
      'paint, compositing and IME/timing are not (M22).',
  ],
  [
    'test-cross-platform',
    'boots the real Tauri desktop app, which is WebKitGTK on Linux. The assertions are on sync ' +
      'state and files, which are engine-independent — but a rendering regression will not show up here. ' +
      'It also needs a Wayland/X display that a bare ssh shell lacks: without one it fails in ~9s ' +
      '(`no DISPLAY or WAYLAND_DISPLAY`); see docs/remote-testing.md "Suites that need a display".',
  ],
  [
    'prepush',
    'the maximal gate, minus everything only a Mac can see: no iOS build/tests, no swift-format, ' +
      'and its Playwright + cross-platform legs run on WebKitGTK, not WKWebView. A green remote ' +
      'prepush is NOT a license to skip the Mac.',
  ],
  [
    /^(test-cross-platform|prepush)$/,
    'derives its ports and its SQLite database from the worktree slot, so two DIFFERENT ' +
      'worktrees can run it at once — but two runs in the same remote worktree are the same ' +
      'slot, and the second now aborts on the busy port instead of adopting the first server. ' +
      'The remote worktree lock is what stops that happening at all.',
  ],
];

function matches(matcher, name) {
  return typeof matcher === 'string' ? matcher === name : matcher.test(name);
}

/**
 * @returns {{ recipe: string, allowed: boolean, reason?: string, caveats: string[] }}
 */
export function classifyRecipe(name, { aliases = new Map(), recipes = null } = {}) {
  const resolved = aliases.get(name) ?? name;
  const via = resolved === name ? '' : ` (alias for \`${resolved}\`)`;

  for (const [matcher, reasonKey] of REFUSED) {
    if (matches(matcher, resolved)) {
      return {
        recipe: resolved,
        allowed: false,
        reason: `\`just ${name}\`${via} ${REASONS[reasonKey]}`,
        caveats: [],
      };
    }
  }

  if (recipes && !recipes.has(resolved)) {
    return {
      recipe: resolved,
      allowed: false,
      reason: `\`just ${name}\` is not a recipe in this checkout's justfile. Check the spelling with \`just --list\`.`,
      caveats: [],
    };
  }

  const caveats = CAVEATED.filter(([matcher]) => matches(matcher, resolved)).map(
    ([, text]) => `\`just ${resolved}\` ${text}`,
  );
  return { recipe: resolved, allowed: true, caveats };
}
