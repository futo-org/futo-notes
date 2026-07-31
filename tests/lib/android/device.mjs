/**
 * A native Android app under test, as one object: adb access, label-anchored UI
 * driving, the debug build's named hooks, and waits that poll observable
 * conditions.
 *
 * Two rules shape the design, both learned the hard way (AGENTS.md M15, M21):
 *
 * - Never sleep for a fixed duration; wait for a condition. A re-introduced hang
 *   then fails loudly instead of turning into a flake.
 * - Prefer the cheapest true signal. An accessibility dump costs ~2s and reports
 *   what Compose last managed to render; a hook-reported state snapshot costs
 *   ~100ms and reports what the app actually holds. Reach for the UI tree when the
 *   UI itself is what is under test.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createAdbClient } from './adbClient.mjs';
import { describeUiNodes, parseUiNodes } from './uiTree.mjs';
import {
  createTokenSource,
  describeHookFailure,
  formatBroadcastExtras,
  parseHookAck,
  parseStateAck,
  TEST_HOOK_TAG,
} from './testHooks.mjs';

const DEFAULT_PACKAGE = 'com.futo.notes.dev';
const DEFAULT_ACTIVITY_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
/** A hook body returns promptly — it starts work, it does not finish it. */
const HOOK_ACK_TIMEOUT_MS = 10_000;
const HOOK_ACK_POLL_MS = 100;

export function createAndroidDevice({
  pkg = DEFAULT_PACKAGE,
  serial,
  timeoutMs = DEFAULT_ACTIVITY_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  screenshotDir = 'test-screenshots',
} = {}) {
  const adb = createAdbClient({ pkg, serial });
  const nextToken = createTokenSource();

  let cachedNodes = null;
  let cachedScreen = null;

  // ── Waiting ─────────────────────────────────────────────────────

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Poll [predicate] until it returns something truthy, then return that. The
   * failure message asks the predicate for context via [describeFailure] so a
   * timeout says what the app looked like, not just that time ran out.
   */
  async function waitFor(description, predicate, options = {}) {
    const {
      timeoutMs: limit = timeoutMs,
      pollIntervalMs: interval = pollIntervalMs,
      describeFailure,
    } = options;
    const deadline = Date.now() + limit;
    for (;;) {
      const result = await predicate();
      if (result) return result;
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out after ${limit}ms waiting for ${description}${await describeContext(describeFailure)}`,
        );
      }
      await sleep(interval);
    }
  }

  /** Context is a nicety, so a device that died while we were waiting must not
   *  replace "timed out waiting for X" with the failure of the diagnostic. */
  async function describeContext(describeFailure) {
    if (!describeFailure) return '';
    try {
      return `\n  when it timed out: ${await describeFailure()}`;
    } catch (error) {
      return `\n  (could not read the app's state either: ${error.message})`;
    }
  }

  // ── App state, via the debug build's hooks ───────────────────────

  /**
   * Run a named hook and wait for its ack. Returns the reported fields, or null
   * for a hook that reports none.
   *
   * The ack means the hook RAN. Work it starts — a vault migration, a relaunch —
   * is still in flight, so follow it with a wait on the state it changes.
   *
   * A broadcast sent before the app has registered its receiver is simply
   * dropped, which is what happens for the first call after a launch. [retry]
   * re-sends until the ack arrives; it is only safe for a hook that changes
   * nothing, so a state-changing hook is sent ONCE and fails loudly rather than
   * risk running twice.
   */
  async function callHook(name, extras = {}, { retry = false, timeoutMs: limit } = {}) {
    const token = nextToken();
    const args = formatBroadcastExtras({ hook: name, token, ...extras });
    adb.broadcast(args);
    const ack = await waitFor(
      `the app to acknowledge the "${name}" hook`,
      () => {
        const found = parseHookAck(adb.readLogcat(TEST_HOOK_TAG), token);
        if (!found && retry) adb.broadcast(args);
        return found;
      },
      {
        timeoutMs: limit ?? HOOK_ACK_TIMEOUT_MS,
        // One log read is cheap, and the ack lands as soon as the hook body
        // returns — there is no reason to sit out a UI-length poll interval.
        pollIntervalMs: HOOK_ACK_POLL_MS,
        describeFailure: () =>
          adb.isRunning()
            ? 'the app is running but did not answer — is this a DEBUG build? release builds register no hooks'
            : `${pkg} is not running`,
      },
    );
    const failure = describeHookFailure(name, ack);
    if (failure) throw new Error(failure);
    return ack.detail ? parseStateAck(ack) : null;
  }

  /** Reading state changes nothing, so this may be re-sent until the app answers. */
  const state = () => callHook('state', {}, { retry: true });

  /**
   * Wait until the app is up and listening. Worth calling after a launch or a
   * storage switch, both of which restart the process, before any hook that must
   * not be sent twice.
   */
  const waitUntilReady = (options = {}) =>
    callHook('state', {}, { retry: true, timeoutMs: options.timeoutMs ?? timeoutMs });

  /** Wait until the app's own state satisfies [predicate]. */
  const waitForState = (description, predicate, options = {}) =>
    waitFor(
      description,
      async () => {
        const snapshot = await state();
        return predicate(snapshot) ? snapshot : null;
      },
      {
        ...options,
        describeFailure: options.describeFailure ?? (async () => JSON.stringify(await state())),
      },
    );

  // ── UI tree ─────────────────────────────────────────────────────

  /** The tree goes stale the moment anything is tapped, so every input path
   *  clears this and the next read pays for one dump. */
  const invalidateUi = () => {
    cachedNodes = null;
  };

  function uiNodes({ refresh = false } = {}) {
    if (refresh) invalidateUi();
    cachedNodes ??= parseUiNodes(adb.dumpUiXml());
    return cachedNodes;
  }

  const findLabel = (label, options) =>
    uiNodes(options).find((node) => node.label === label) ?? null;

  /** Physical size, read once — swipe distances derive from it so the driver is
   *  not tuned to one AVD's resolution. */
  function screenSize() {
    cachedScreen ??= (() => {
      const match = adb.shell('wm size', { allowFailure: true }).match(/(\d+)x(\d+)/);
      return match
        ? { width: Number(match[1]), height: Number(match[2]) }
        : { width: 1080, height: 1920 };
    })();
    return cachedScreen;
  }

  /** One scroll gesture up the middle of the screen. */
  function scrollDown() {
    const { width, height } = screenSize();
    adb.swipe(
      Math.round(width / 2),
      Math.round(height * 0.75),
      Math.round(width / 2),
      Math.round(height * 0.3),
    );
    invalidateUi();
  }

  /**
   * Tap the control carrying [label], scrolling to reach it if needed.
   *
   * Deliberately taps ONCE. Re-tapping until something changes reads as
   * robustness, but a dialog that closes between the look and the tap leaves the
   * extra taps landing on whatever is underneath — which is how a retry loop
   * ended up hitting the Settings screen's Danger zone.
   */
  async function tap(label, { scroll = true, timeoutMs: limit } = {}) {
    const node = await waitFor(
      `"${label}" to appear`,
      () => {
        const hit = findLabel(label, { refresh: true });
        if (hit) return hit;
        if (scroll) scrollDown();
        return null;
      },
      { timeoutMs: limit, describeFailure: () => `on screen: ${describeUiNodes(uiNodes())}` },
    );
    adb.tapPoint(node.x, node.y);
    invalidateUi();
    return node;
  }

  const waitForLabel = (label, options) =>
    waitFor(`"${label}" to appear`, () => findLabel(label, { refresh: true }), {
      ...options,
      describeFailure: () => `on screen: ${describeUiNodes(uiNodes())}`,
    });

  // ── Input that invalidates the tree ─────────────────────────────

  const back = () => {
    adb.keyevent(4);
    invalidateUi();
  };

  /** HOME also flushes the open editor's pending edit to disk. */
  const home = () => {
    adb.keyevent(3);
    invalidateUi();
  };

  const typeText = (text) => {
    adb.typeText(text);
    invalidateUi();
  };

  // ── Lifecycle ───────────────────────────────────────────────────

  const launch = () => {
    adb.launch();
    invalidateUi();
  };

  const relaunch = () => {
    adb.forceStop();
    launch();
  };

  function screenshot(name) {
    mkdirSync(screenshotDir, { recursive: true });
    const path = join(screenshotDir, `${name}.png`);
    writeFileSync(path, adb.screencapPng());
    return path;
  }

  /** Fail with an actionable message before any story runs. */
  function requireReady() {
    if (!adb.isReachable()) {
      throw new Error(
        'no Android device reachable — set $ANDROID_SERIAL, or run: just qa-claim android',
      );
    }
    if (!adb.isInstalled()) {
      throw new Error(`${pkg} is not installed — run: just android-native`);
    }
  }

  return {
    adb,
    pkg,
    serial: adb.serial,
    // waiting
    waitFor,
    // hooks
    callHook,
    state,
    waitForState,
    waitUntilReady,
    // ui reads
    uiNodes,
    invalidateUi,
    waitForLabel,
    // ui writes
    tap,
    back,
    home,
    typeText,
    // lifecycle
    launch,
    relaunch,
    screenshot,
    requireReady,
  };
}
