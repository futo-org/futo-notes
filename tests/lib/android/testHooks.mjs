/**
 * The caller's half of the debug build's named-hook protocol
 * (`apps/android/app/src/debug/java/com/futo/notes/testhook/`).
 *
 * `am broadcast` succeeds whether or not anything received the intent, so every
 * call here waits for the app's own ack. A hook that never ran therefore fails at
 * the call, naming the reason, instead of timing out later on whatever it was
 * supposed to change.
 */

import { quoteForDeviceShell } from './adbClient.mjs';

/** Must match TEST_HOOK_ACTION / TEST_HOOK_TAG in TestHookProtocol.kt. */
const TEST_HOOK_ACTION = 'com.futo.notes.TEST_HOOK';
export const TEST_HOOK_TAG = 'FutoTestHook';

/**
 * Fields the `state` hook reports (MainActivity.testHooks). Listed so a snapshot
 * that has drifted from this reader fails saying which field went missing, rather
 * than yielding `undefined` and a confusing assertion further along.
 */
export const STATE_FIELDS = [
  'storageMode',
  'vaultPath',
  'notes',
  'onboarding',
  'movingNotes',
  'awaitingStorageConfirmation',
  'shellVisible',
];

const ACK_PATTERN = /testhook (ok|unknown|failed|missing) (\S+)(?: (.*))?$/;

/**
 * The ack for [token], or null if it has not been logged yet.
 *
 * Matching on the token rather than on the most recent line is what lets this
 * read the log without clearing it first — clearing is a device-wide side effect,
 * and a cleared log races anything else watching it.
 */
export function parseHookAck(logcat, token) {
  for (const line of logcat.split('\n').reverse()) {
    const match = line.match(ACK_PATTERN);
    if (!match) continue;
    const [, status, ackToken, rest = ''] = match;
    if (ackToken !== token) continue;
    if (status === 'missing') return { status, name: null };
    const [name, ...payloadWords] = rest.split(' ');
    return { status, name, detail: payloadWords.join(' ') };
  }
  return null;
}

/** The reported fields of a successful ack, checked against [STATE_FIELDS]. */
export function parseStateAck(ack) {
  if (!ack.detail) throw new Error(`the ${ack.name} hook reported no fields`);
  let state;
  try {
    state = JSON.parse(ack.detail);
  } catch {
    throw new Error(`the ${ack.name} hook reported unparseable fields: ${ack.detail}`);
  }
  const missing = STATE_FIELDS.filter((field) => !(field in state));
  if (missing.length > 0) {
    throw new Error(
      `the app's state snapshot is missing ${missing.join(', ')} — ` +
        'MainActivity.testHooks and STATE_FIELDS have drifted apart',
    );
  }
  return state;
}

/** The message for an ack that is not a success, or null when it is one. */
export function describeHookFailure(name, ack) {
  switch (ack.status) {
    case 'ok':
      return null;
    case 'unknown':
      return `the app has no "${name}" hook (${ack.detail || 'no hooks registered'})`;
    case 'failed':
      return `the "${name}" hook failed: ${ack.detail}`;
    default:
      return `the broadcast reached the app without a hook name`;
  }
}

/**
 * Extras, as `am broadcast` argument text. All values go over as strings; a hook
 * parses its own.
 *
 * Caller-supplied words are quoted with the adb client's rule rather than a local
 * one. The local version dropped apostrophes instead of escaping them, which
 * silently changed the argument the app received — the failure mode of a rule
 * implemented twice.
 */
export function formatBroadcastExtras({ hook, token, ...extras }) {
  const args = [
    `-a ${TEST_HOOK_ACTION}`,
    `--es hook ${quoteForDeviceShell(hook)}`,
    `--es token ${quoteForDeviceShell(token)}`,
  ];
  for (const [key, value] of Object.entries(extras)) {
    args.push(`--es ${key} ${quoteForDeviceShell(String(value))}`);
  }
  return args.join(' ');
}

/** Unique per call within a run, and per run, so one harness cannot read
 *  another's ack out of a shared log. */
export function createTokenSource() {
  let next = 0;
  return () => `${process.pid}-${(next += 1)}`;
}
