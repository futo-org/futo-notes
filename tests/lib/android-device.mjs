/**
 * adb/uiautomator mechanics for harnesses that drive the REAL native Android
 * app (apps/android). No sync or scenario knowledge lives here — see
 * android-native-instance.mjs for the cross-platform-sync client built on this.
 *
 * Every wait is on an observable device condition, never a fixed sleep, and
 * every tap is anchored to a label read from the accessibility tree: Compose
 * coordinates move between builds, and a screenshot can show a stale frame on
 * an unfocused emulator (AGENTS.md M21).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import net from 'node:net';

import {
  createTokenSource,
  describeHookFailure,
  formatBroadcastExtras,
  parseHookAck,
  TEST_HOOK_TAG,
} from './android/testHooks.mjs';

const POLL_INTERVAL_MS = 500;
/** A hook body returns promptly — it starts work, it does not finish it. */
const HOOK_ACK_TIMEOUT_MS = 10_000;

export const DEBUG_PACKAGE = 'com.futo.notes.dev';
const MAIN_ACTIVITY = `${DEBUG_PACKAGE}/com.futo.notes.MainActivity`;

/** Debug-build vault roots, keyed by the `storage_mode` preference. The dev/prod
 *  split (AGENTS.md M3) makes these "FUTO Notes Dev" / the `.dev` app id. */
const APP_STORAGE_VAULT = `/sdcard/Android/data/${DEBUG_PACKAGE}/files/futo-notes`;
const DEVICE_STORAGE_VAULT = '/sdcard/Documents/FUTO Notes Dev';
const PREFS_FILE = `/data/data/${DEBUG_PACKAGE}/shared_prefs/futo_prefs.xml`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** &amp; last, so a decoded "&lt;" is not decoded twice. */
function decodeXmlEntities(value) {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Devices in `device` state, as `adb devices` reports them. */
export function listAttachedDevices() {
  const result = spawnSync('adb', ['devices'], { encoding: 'utf8' });
  if (result.status !== 0) return [];
  return (result.stdout || '')
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state === 'device')
    .map(([serial]) => serial);
}

export class AndroidDevice {
  constructor(serial) {
    this.serial = serial;
    this.forwardedPorts = [];
    this.nextHookToken = createTokenSource();
  }

  get isEmulator() {
    return this.serial.startsWith('emulator-');
  }

  adb(args, { allowFailure = false, input } = {}) {
    try {
      return execFileSync('adb', ['-s', this.serial, ...args], {
        encoding: 'utf8',
        input,
        maxBuffer: 64 * 1024 * 1024,
        // Capture adb's chatter (e.g. `am start`'s "Activity not started")
        // instead of leaking it into the harness log.
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      if (allowFailure) return '';
      throw new Error(`adb ${args.join(' ')} failed: ${err.stderr || err.message}`);
    }
  }

  shell(command, options) {
    return this.adb(['shell', command], options);
  }

  isResponsive() {
    return this.shell('echo ok', { allowFailure: true }).includes('ok');
  }

  isPackageInstalled(pkg = DEBUG_PACKAGE) {
    return this.shell(`pm path ${pkg}`, { allowFailure: true }).includes('package:');
  }

  // ── Conditions ────────────────────────────────────────────────

  async waitFor(description, timeoutMs, predicate) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await predicate();
      if (last) return last;
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`timed out after ${timeoutMs}ms waiting for ${description}`);
  }

  // ── Debug-build hooks ─────────────────────────────────────────

  /**
   * Run one of the debug build's named hooks (`MainActivity.testHooks`) and wait
   * for the app's own ack. Returns the fields the hook reported, or null when it
   * reports none.
   *
   * `am broadcast` exits 0 whether or not anything received the intent, so the
   * ack is the only evidence the hook ran — a release build, or a hook name that
   * does not exist, therefore fails HERE naming the reason instead of timing out
   * later on whatever it was supposed to change. The protocol itself lives in
   * `tests/lib/android/testHooks.mjs`, shared with the storage harness.
   */
  async callHook(name, extras = {}, { timeoutMs = HOOK_ACK_TIMEOUT_MS } = {}) {
    const token = this.nextHookToken();
    const args = formatBroadcastExtras({ hook: name, token, ...extras });
    this.shell(`am broadcast ${args}`, { allowFailure: true });
    let ack;
    try {
      ack = await this.waitFor(`the app to acknowledge the "${name}" hook`, timeoutMs, () =>
        parseHookAck(
          this.adb(['logcat', '-d', '-b', 'main', '-s', `${TEST_HOOK_TAG}:I`], {
            allowFailure: true,
          }),
          token,
        ),
      );
    } catch (error) {
      // Say WHY nothing answered. An unreached broadcast otherwise reads as a
      // hung app, and the two real causes have different fixes.
      const alive = this.shell(`pidof ${DEBUG_PACKAGE}`, { allowFailure: true }).trim();
      throw new Error(
        `${error.message} — ${
          alive
            ? `${DEBUG_PACKAGE} is running but registered no hook: is this a DEBUG build?`
            : `${DEBUG_PACKAGE} is not running`
        }`,
      );
    }
    const failure = describeHookFailure(name, ack);
    if (failure) throw new Error(failure);
    return ack.detail ? JSON.parse(ack.detail) : null;
  }

  // ── Screen reading and tapping ────────────────────────────────

  /** Every visible text/content-description with its tap point. */
  visibleNodes() {
    const xml = this.adb(['exec-out', 'uiautomator', 'dump', '/dev/tty'], { allowFailure: true });
    const nodes = [];
    const pattern =
      /(?:text|content-desc)="([^"]+)"[^>]*?bounds="\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]"/g;
    for (const [, label, x1, y1, x2, y2] of xml.matchAll(pattern)) {
      nodes.push({
        // The dump is XML: "Connect & Sync" arrives as "Connect &amp; Sync" and
        // would never match a caller's plain label.
        label: decodeXmlEntities(label),
        x: Math.round((Number(x1) + Number(x2)) / 2),
        y: Math.round((Number(y1) + Number(y2)) / 2),
      });
    }
    return nodes;
  }

  /** One dump, reused for several lookups. A dump costs ~2 s on an emulator, so
   *  a navigation step that inspects four labels must not pay for four of them
   *  — that alone is enough to blow a 30 s wait. */
  screen() {
    const nodes = this.visibleNodes();
    return {
      nodes,
      has: (label) => nodes.some((node) => node.label === label),
      node: (label) => nodes.find((node) => node.label === label),
    };
  }

  findNode(label) {
    return this.visibleNodes().find((node) => node.label === label);
  }

  isVisible(label) {
    return Boolean(this.findNode(label));
  }

  /** Physical screen size — swipe/scroll distances are derived from it because
   *  pool AVDs are not all the same resolution. */
  screenSize() {
    if (!this.cachedScreenSize) {
      const out = this.shell('wm size', { allowFailure: true });
      const [, width, height] = out.match(/Physical size:\s*(\d+)x(\d+)/) ?? [];
      this.cachedScreenSize = { width: Number(width) || 1080, height: Number(height) || 1920 };
    }
    return this.cachedScreenSize;
  }

  scrollDown() {
    const { width, height } = this.screenSize();
    const x = Math.round(width / 2);
    this.shell(
      `input swipe ${x} ${Math.round(height * 0.78)} ${x} ${Math.round(height * 0.25)} 200`,
    );
  }

  /** Scroll the current screen until `label` is on screen, then tap its centre. */
  async tap(label, { scroll = true, timeoutMs = 30_000 } = {}) {
    const node = await this.waitFor(`"${label}"`, timeoutMs, async () => {
      const hit = this.findNode(label);
      if (hit) return hit;
      if (scroll) this.scrollDown();
      return null;
    });
    this.shell(`input tap ${node.x} ${node.y}`);
    return node;
  }

  tapPoint(x, y) {
    this.shell(`input tap ${x} ${y}`);
  }

  /** Replace a focused text field's content: select-all (Ctrl+A), delete, type.
   *  `input text` takes spaces as %s and cannot type a newline; the single-quote
   *  wrapping means callers must not pass a value containing one. */
  typeReplacingSelection(text) {
    if (text.includes("'")) throw new Error(`cannot type ${JSON.stringify(text)} with adb input`);
    this.shell('input keycombination 113 29'); // CTRL_LEFT + A
    this.shell('input keyevent 67'); // DEL — clears the selection
    this.shell(`input text '${text.replace(/ /g, '%s')}'`);
  }

  pressBack() {
    this.shell('input keyevent 4');
  }

  /** Is the soft keyboard up? Taps aimed at the app land on keys while it is,
   *  and uiautomator's dump does not show it. */
  isImeVisible() {
    const out = this.shell('dumpsys input_method', { allowFailure: true });
    return /mInputShown=true/.test(out);
  }

  // ── App lifecycle ─────────────────────────────────────────────

  launch() {
    this.shell(`am start -n ${MAIN_ACTIVITY}`);
  }

  /** Airplane mode — the only way to give the phone a REAL offline window: the
   *  harness server runs on the host, which the emulator reaches through its own
   *  NAT, so cutting the radios cuts sync too. */
  setAirplaneMode(enabled) {
    this.shell(`cmd connectivity airplane-mode ${enabled ? 'enable' : 'disable'}`);
  }

  canReach(host) {
    return this.shell(`ping -c1 -W1 ${host}`, { allowFailure: true }).includes('1 received');
  }

  isForeground(pkg = DEBUG_PACKAGE) {
    const out = this.shell('dumpsys activity activities', { allowFailure: true });
    // API 30 named it mResumedActivity, API 36 topResumedActivity — match either.
    return new RegExp(`ResumedActivity[^\\n]*${pkg.replace(/\./g, '\\.')}`).test(out);
  }

  // ── Files ─────────────────────────────────────────────────────

  /** The vault root for the app's current storage-location preference. */
  vaultPath() {
    const prefs = this.shell(`run-as ${DEBUG_PACKAGE} cat ${PREFS_FILE}`, { allowFailure: true });
    const mode = prefs.match(/name="storage_mode">([A-Z]+)</)?.[1];
    return mode === 'DEVICE' ? DEVICE_STORAGE_VAULT : APP_STORAGE_VAULT;
  }

  listDir(path) {
    const out = this.shell(`ls -a '${path}' 2>/dev/null`, { allowFailure: true });
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter((name) => name && name !== '.' && name !== '..');
  }

  readFile(path) {
    return this.shell(`cat '${path}' 2>/dev/null`, { allowFailure: true });
  }

  writeFile(path, contents) {
    this.shell(`cat > '${path}'`, { input: contents });
  }

  fileExists(path) {
    return (
      this.shell(`[ -e '${path}' ] && echo yes || echo no`, { allowFailure: true }).trim() === 'yes'
    );
  }

  removeFile(path) {
    this.shell(`rm -f '${path}'`, { allowFailure: true });
  }

  // ── WebView DevTools (CDP) ────────────────────────────────────

  /** Forward the app's WebView DevTools socket to a free host port. The socket
   *  is named after the app's pid, so this must be redone after every restart. */
  async forwardWebViewDebugger({ timeoutMs = 60_000 } = {}) {
    const socket = await this.waitFor('the WebView DevTools socket', timeoutMs, () => {
      const pid = this.shell(`pidof ${DEBUG_PACKAGE}`, { allowFailure: true }).trim();
      if (!pid) return null;
      const unix = this.shell('cat /proc/net/unix', { allowFailure: true });
      return unix.match(new RegExp(`webview_devtools_remote_${pid}\\b`))?.[0] ?? null;
    });
    const port = await findFreePort();
    this.adb(['forward', `tcp:${port}`, `localabstract:${socket}`]);
    this.forwardedPorts.push(port);
    return port;
  }

  releaseForwards() {
    for (const port of this.forwardedPorts) {
      this.adb(['forward', '--remove', `tcp:${port}`], { allowFailure: true });
    }
    this.forwardedPorts = [];
  }
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}
