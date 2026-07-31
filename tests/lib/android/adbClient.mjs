/**
 * `adb` access for the native Android app: one process spawn per call, with the
 * quoting, line-ending, and multi-command batching rules that every Android
 * harness otherwise re-derives.
 *
 * Honors $ANDROID_SERIAL the same way `adb` itself does, so a caller that claimed
 * a pooled device with `just qa-claim android` needs no extra wiring.
 */

import { execFileSync } from 'node:child_process';

/** Marks the boundary between batched commands' output. */
const BATCH_DELIMITER = '__futo_adb_batch__';

export function createAdbClient({ pkg, serial = process.env.ANDROID_SERIAL ?? null } = {}) {
  if (!pkg) throw new Error('createAdbClient requires the app package id');

  /** Every invocation goes through here so the device selection cannot drift
   *  between the text and binary paths. */
  const argv = (args) => (serial ? ['-s', serial, ...args] : args);

  function adb(args, { allowFailure = false, input } = {}) {
    try {
      const output = execFileSync('adb', argv(args), {
        encoding: 'utf8',
        input,
        maxBuffer: 64 * 1024 * 1024,
        // Capture stderr rather than leaking adb's chatter into the harness
        // output — `am start` prints "Activity not started" when the app is
        // already foregrounded, which is not a failure.
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      // adb's shell protocol reports CRLF; normalizing here keeps every caller
      // from having to trim stray \r off values it compares.
      return output.replace(/\r\n/g, '\n');
    } catch (error) {
      if (allowFailure) return '';
      throw new Error(`adb ${args.join(' ')} failed: ${error.stderr || error.message}`);
    }
  }

  const shell = (command, options) => adb(['shell', command], options);

  /**
   * Run several device commands in ONE adb round-trip and return their outputs in
   * order. A predicate that reads three facts costs one spawn instead of three,
   * which matters inside a poll loop; it also narrows the window in which the
   * facts can disagree with each other.
   *
   * Each command's failure is its own business — a non-zero exit leaves that
   * entry empty rather than failing the batch.
   */
  function shellBatch(commands) {
    if (commands.length === 0) return [];
    const script = commands.map((command) => `${command}\necho '${BATCH_DELIMITER}'`).join('\n');
    return splitBatchOutput(shell(script, { allowFailure: true }), commands.length);
  }

  // ── Preconditions ───────────────────────────────────────────────

  const isReachable = () => shell('echo ok', { allowFailure: true }).includes('ok');

  const isInstalled = () => shell(`pm path ${pkg}`, { allowFailure: true }).includes('package:');

  // ── App lifecycle ───────────────────────────────────────────────

  /** `am start -n` is the reliable launcher; `monkey -p` exits 251 without
   *  launching on some emulators. */
  const launch = () => shell(`am start -n ${pkg}/com.futo.notes.MainActivity`);

  const forceStop = () => shell(`am force-stop ${pkg}`);

  const isRunning = () => shell(`pidof ${pkg}`, { allowFailure: true }).trim().length > 0;

  /** Wipes the vault, preferences, and sync state — a fresh first-run install. */
  const clearData = () => shell(`pm clear ${pkg}`);

  // ── Files ───────────────────────────────────────────────────────
  //
  // Vault paths contain spaces ("FUTO Notes Dev"), and `adb shell` hands the
  // whole command to the DEVICE shell, so the path needs quoting there — passing
  // it as a separate argv entry does not help.

  const quote = quoteForDeviceShell;

  /** Reads pair with [shellBatch], so the command and its execution are separate:
   *  several files cost one round-trip. Feed the output to [parseDirListing]. */
  const readFileCommand = (path) => `cat ${quote(path)} 2>/dev/null`;

  const listDirCommand = (path) => `ls -a ${quote(path)} 2>/dev/null`;

  const writeFile = (path, body) => shell(`cat > ${quote(path)}`, { input: body });

  const exists = (path) =>
    shell(`[ -e ${quote(path)} ] && echo yes || echo no`, { allowFailure: true }).trim() === 'yes';

  const removeDir = (path) => shell(`rm -rf ${quote(path)}`, { allowFailure: true });

  // ── Logs ────────────────────────────────────────────────────────

  /**
   * `-b main` is where `Log.i` lands, and naming it skips the system and crash
   * buffers.
   *
   * Do NOT add `-t <count>` to make this faster. It looks like a big win — 17ms
   * against 64ms — because it tails the raw log BEFORE applying the tag filter,
   * so on a busy device the last N lines contain none of the tagged ones and the
   * read comes back empty. Measured: `-t 200 -s FutoTestHook` returned 0 of 88
   * acks. Every hook call would time out for no visible reason.
   */
  const readLogcat = (...tags) =>
    shell(`logcat -d -b main -s ${tags.join(' ')}`, { allowFailure: true });

  // ── Input ───────────────────────────────────────────────────────

  const tapPoint = (x, y) => shell(`input tap ${x} ${y}`);

  const swipe = (x1, y1, x2, y2, durationMs = 200) =>
    shell(`input swipe ${x1} ${y1} ${x2} ${y2} ${durationMs}`);

  const keyevent = (code) => shell(`input keyevent ${code}`);

  /** `input text` needs %s for spaces; it cannot reach the editor WebView. The
   *  text is shell-quoted like a path — an apostrophe in it would otherwise end
   *  the quoting and hand the rest to the device shell as commands. */
  const typeText = (text) => shell(`input text ${quote(text.replaceAll(' ', '%s'))}`);

  /**
   * The accessibility tree as XML. This is the expensive call in the whole client
   * — a measured ~1.9s, because uiautomator waits for the window to go idle.
   * `--compressed` does not help (measured identical); the cost is the idle wait,
   * not the XML size. Prefer a test hook whenever the UI is not what you are
   * verifying.
   */
  const dumpUiXml = () =>
    adb(['exec-out', 'uiautomator', 'dump', '/dev/tty'], { allowFailure: true });

  /** Raw bytes, so this cannot go through `adb()`, which decodes as UTF-8. */
  const screencapPng = () =>
    execFileSync('adb', argv(['exec-out', 'screencap', '-p']), {
      maxBuffer: 64 * 1024 * 1024,
    });

  const broadcast = (args) => shell(`am broadcast ${args}`, { allowFailure: true });

  return {
    pkg,
    serial,
    adb,
    shell,
    shellBatch,
    isReachable,
    isInstalled,
    launch,
    forceStop,
    isRunning,
    clearData,
    readFileCommand,
    writeFile,
    exists,
    listDirCommand,
    removeDir,
    readLogcat,
    tapPoint,
    swipe,
    keyevent,
    typeText,
    dumpUiXml,
    screencapPng,
    broadcast,
  };
}

/**
 * Wrap a value so the DEVICE shell sees it as one argument.
 *
 * `adb shell` hands the whole command line to a shell on the device, so quoting
 * has to survive that hop — passing a path as its own local argv entry does not
 * help. Vault paths contain spaces ("FUTO Notes Dev") and note titles can contain
 * an apostrophe, which would otherwise close the quoting and hand the remainder to
 * the device shell as commands.
 */
export function quoteForDeviceShell(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * One entry per batched command, byte-exact.
 *
 * `echo` terminates the marker with a newline, so splitting on marker-plus-newline
 * yields each command's output verbatim whether or not it ended with a newline of
 * its own. Do not trim: a note's trailing newline is content, and stripping it
 * turned byte-for-byte vault comparisons into false failures.
 */
export function splitBatchOutput(output, count) {
  const parts = output.split(`${BATCH_DELIMITER}\n`);
  return Array.from({ length: count }, (_, index) => parts[index] ?? '');
}

/** Entry names from `ls -a`, without the `.`/`..` self-links. */
export function parseDirListing(output) {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((name) => name && name !== '.' && name !== '..');
}
