import { describe, expect, it } from 'vitest';

import {
  createTokenSource,
  describeHookFailure,
  formatBroadcastExtras,
  parseHookAck,
  parseStateAck,
  STATE_FIELDS,
} from './testHooks.mjs';

const STATE_JSON = JSON.stringify({
  storageMode: 'DEVICE',
  vaultPath: '/sdcard/Documents/FUTO Notes Dev',
  notes: 2,
  onboarding: false,
  movingNotes: false,
  awaitingStorageConfirmation: false,
  shellVisible: true,
});

const logLine = (payload) => `07-27 15:12:33.123  4021  4021 I FutoTestHook: ${payload}`;

describe('parseHookAck', () => {
  it('finds the ack for the token it was given', () => {
    const logcat = [
      logLine('testhook ok 9-1 storage-mode'),
      logLine('testhook ok 9-2 state {}'),
    ].join('\n');
    expect(parseHookAck(logcat, '9-1')).toEqual({
      status: 'ok',
      name: 'storage-mode',
      detail: '',
    });
  });

  /** Matching by token is what lets this read the log without clearing it, so an
   *  earlier run's acks must not be mistaken for this call's. */
  it('ignores acks belonging to other tokens', () => {
    expect(parseHookAck(logLine('testhook ok 9-1 state {}'), '9-2')).toBeNull();
  });

  it('returns null while the ack has not been logged, so the caller keeps waiting', () => {
    expect(parseHookAck('', '9-1')).toBeNull();
    expect(parseHookAck(logLine('some other message'), '9-1')).toBeNull();
  });

  it('keeps a payload intact, spaces and all', () => {
    const ack = parseHookAck(logLine(`testhook ok 9-1 state ${STATE_JSON}`), '9-1');
    expect(ack.name).toBe('state');
    expect(JSON.parse(ack.detail).vaultPath).toBe('/sdcard/Documents/FUTO Notes Dev');
  });

  it('reads the unknown-hook ack and the names it offers', () => {
    const ack = parseHookAck(logLine('testhook unknown 9-1 stat known=state,storage-mode'), '9-1');
    expect(ack).toEqual({ status: 'unknown', name: 'stat', detail: 'known=state,storage-mode' });
  });

  it('reads a failure with its reason', () => {
    const ack = parseHookAck(
      logLine('testhook failed 9-1 storage-mode no such mode: SDCARD'),
      '9-1',
    );
    expect(ack).toEqual({
      status: 'failed',
      name: 'storage-mode',
      detail: 'no such mode: SDCARD',
    });
  });

  it('reads a broadcast that named no hook', () => {
    expect(parseHookAck(logLine('testhook missing 9-1'), '9-1')).toEqual({
      status: 'missing',
      name: null,
    });
  });

  /** A retried call logs a second ack for the same token; the latest one wins. */
  it('prefers the most recent ack for a token', () => {
    const logcat = [
      logLine('testhook failed 9-1 state transient'),
      logLine('testhook ok 9-1 state {}'),
    ].join('\n');
    expect(parseHookAck(logcat, '9-1').status).toBe('ok');
  });
});

describe('parseStateAck', () => {
  it('returns the reported fields', () => {
    const state = parseStateAck({ name: 'state', detail: STATE_JSON });
    expect(state.storageMode).toBe('DEVICE');
    expect(state.notes).toBe(2);
    expect(state.shellVisible).toBe(true);
  });

  /**
   * Nothing links the app's field names to this reader at compile time, so a
   * renamed field has to fail here — saying which one — rather than yielding
   * undefined and a confusing assertion further along.
   */
  it('names the fields that went missing when the app and this reader drift apart', () => {
    const stale = JSON.stringify({ storageMode: 'APP', notes: 0 });
    expect(() => parseStateAck({ name: 'state', detail: stale })).toThrow(
      /missing vaultPath, onboarding, movingNotes, awaitingStorageConfirmation, shellVisible/,
    );
  });

  it('reports an explicitly null field as present', () => {
    const withoutVault = JSON.stringify(
      Object.fromEntries(STATE_FIELDS.map((field) => [field, field === 'vaultPath' ? null : 0])),
    );
    expect(parseStateAck({ name: 'state', detail: withoutVault }).vaultPath).toBeNull();
  });

  it('explains an unparseable payload instead of throwing a JSON error', () => {
    expect(() => parseStateAck({ name: 'state', detail: '{not json' })).toThrow(
      /unparseable fields: \{not json/,
    );
  });

  it('explains a hook that reported nothing', () => {
    expect(() => parseStateAck({ name: 'state', detail: '' })).toThrow(/reported no fields/);
  });
});

describe('describeHookFailure', () => {
  it('passes a success through', () => {
    expect(describeHookFailure('state', { status: 'ok' })).toBeNull();
  });

  it('points an unknown hook at the names the app does register', () => {
    const message = describeHookFailure('stat', {
      status: 'unknown',
      detail: 'known=state,storage-mode',
    });
    expect(message).toMatch(/no "stat" hook/);
    expect(message).toMatch(/known=state,storage-mode/);
  });

  it('surfaces the app-side reason for a failed hook', () => {
    expect(
      describeHookFailure('storage-mode', { status: 'failed', detail: 'no such mode: X' }),
    ).toMatch(/"storage-mode" hook failed: no such mode: X/);
  });
});

describe('formatBroadcastExtras', () => {
  it('sends the hook name and token, and any extras as strings', () => {
    expect(formatBroadcastExtras({ hook: 'storage-mode', token: '9-1', mode: 'DEVICE' })).toBe(
      "-a com.futo.notes.TEST_HOOK --es hook 'storage-mode' --es token '9-1' --es mode 'DEVICE'",
    );
  });

  it('quotes a value with spaces so am parses it as one argument', () => {
    expect(formatBroadcastExtras({ hook: 'open', token: '9-1', title: 'grocery list' })).toContain(
      `--es title 'grocery list'`,
    );
  });

  /** The previous local quoting deleted apostrophes, so the app silently received
   *  a different value than the caller passed. */
  it('escapes an apostrophe rather than dropping it', () => {
    expect(formatBroadcastExtras({ hook: 'open', token: '9-1', title: "Dad's list" })).toContain(
      `--es title 'Dad'\\''s list'`,
    );
  });
});

describe('createTokenSource', () => {
  it('never repeats a token within a run', () => {
    const nextToken = createTokenSource();
    const tokens = [nextToken(), nextToken(), nextToken()];
    expect(new Set(tokens).size).toBe(3);
  });

  /** Two harnesses share one device log, so tokens carry the process. */
  it('scopes tokens to this process', () => {
    expect(createTokenSource()()).toBe(`${process.pid}-1`);
  });
});
