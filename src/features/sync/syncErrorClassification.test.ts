import { describe, it, expect } from 'vitest';
import { classifySyncError, syncErrorDedupeKey } from './syncErrorClassification';

describe('classifySyncError — browser fetch TypeErrors', () => {
  it('classifies opaque fetch TypeErrors as transient', () => {
    expect(classifySyncError(new TypeError('Failed to fetch'))).toBe('transient');
    expect(classifySyncError(new TypeError('Load failed'))).toBe('transient');
    expect(classifySyncError(new TypeError('NetworkError when attempting to fetch'))).toBe(
      'transient',
    );
  });
});

describe('classifySyncError — desktop invoke() rejects with Rust reqwest strings', () => {
  it('classifies the exact observed connect-failure string (plain string, not an Error)', () => {
    expect(
      classifySyncError(
        'transport error: error sending request for url (http://127.0.0.1:9/api/auth/password/login)',
      ),
    ).toBe('transient');
  });

  it('classifies the same string when re-wrapped in an Error (autoSyncV2 background path)', () => {
    expect(
      classifySyncError(
        new Error('transport error: error sending request for url (http://127.0.0.1:9/api/notes)'),
      ),
    ).toBe('transient');
  });

  it('classifies other reqwest transport variants as transient', () => {
    expect(
      classifySyncError(
        'transport error: error trying to connect: tcp connect error: Connection refused (os error 61)',
      ),
    ).toBe('transient');
    expect(
      classifySyncError(
        'error sending request for url (https://notes.example.com/api/keys): dns error: failed to lookup address information',
      ),
    ).toBe('transient');
    expect(classifySyncError('connection refused')).toBe('transient');
    expect(classifySyncError('transport error: operation timed out')).toBe('transient');
  });
});

describe('classifySyncError — real server/auth errors stay actionable', () => {
  it('classifies auth, HTTP-status, and unknown failures as actionable', () => {
    expect(classifySyncError('HTTP 401: {"error":"invalid credentials"}')).toBe('actionable');
    expect(classifySyncError(new Error('401 Unauthorized'))).toBe('actionable');
    expect(classifySyncError('invalid password')).toBe('actionable');
    expect(classifySyncError(new Error('Sync not configured'))).toBe('actionable');
    expect(classifySyncError('HTTP 500 Internal Server Error')).toBe('actionable');
    expect(classifySyncError('error sending request: HTTP 500 Internal Server Error')).toBe(
      'actionable',
    );
    expect(classifySyncError('stream lost')).toBe('actionable');
    expect(classifySyncError('plain string failure')).toBe('actionable');
  });
});

describe('syncErrorDedupeKey', () => {
  it('collapses every transport variant onto one key so a flapping outage toasts once', () => {
    expect(syncErrorDedupeKey(new TypeError('Failed to fetch'))).toBe('transport');
    expect(syncErrorDedupeKey(new TypeError('Load failed'))).toBe('transport');
    expect(
      syncErrorDedupeKey(
        'connect: error sending request for url (https://notes.example.com/objects)',
      ),
    ).toBe('transport');
    expect(syncErrorDedupeKey('transport error: operation timed out')).toBe('transport');
  });

  it('keeps distinct actionable failures distinct so each one still toasts', () => {
    expect(syncErrorDedupeKey(new Error('401 Unauthorized'))).toBe('401 Unauthorized');
    expect(syncErrorDedupeKey('invalid password')).toBe('invalid password');
    expect(syncErrorDedupeKey('HTTP 500 Internal Server Error')).toBe(
      'HTTP 500 Internal Server Error',
    );
  });
});
