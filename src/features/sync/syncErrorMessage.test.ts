import { describe, it, expect } from 'vitest';
import { getSyncErrorMessage } from './syncErrorMessage';

const ACTIONABLE = "Could not reach server — check the URL and make sure it's running";

describe('getSyncErrorMessage — browser fetch TypeErrors', () => {
  it('rewrites opaque fetch TypeErrors to an actionable message', () => {
    expect(getSyncErrorMessage(new TypeError('Failed to fetch'))).toBe(ACTIONABLE);
    expect(getSyncErrorMessage(new TypeError('Load failed'))).toBe(ACTIONABLE);
    expect(getSyncErrorMessage(new TypeError('NetworkError when attempting to fetch'))).toBe(
      ACTIONABLE,
    );
  });
});

describe('getSyncErrorMessage — desktop invoke() rejects with Rust reqwest strings', () => {
  it('rewrites the exact observed connect-failure string (plain string, not an Error)', () => {
    expect(
      getSyncErrorMessage(
        'transport error: error sending request for url (http://127.0.0.1:9/api/auth/password/login)',
      ),
    ).toBe(ACTIONABLE);
  });

  it('rewrites the same string when re-wrapped in an Error (autoSyncV2 background path)', () => {
    expect(
      getSyncErrorMessage(
        new Error('transport error: error sending request for url (http://127.0.0.1:9/api/notes)'),
      ),
    ).toBe(ACTIONABLE);
  });

  it('rewrites other reqwest transport variants', () => {
    expect(
      getSyncErrorMessage(
        'transport error: error trying to connect: tcp connect error: Connection refused (os error 61)',
      ),
    ).toBe(ACTIONABLE);
    expect(
      getSyncErrorMessage(
        'error sending request for url (https://notes.example.com/api/keys): dns error: failed to lookup address information',
      ),
    ).toBe(ACTIONABLE);
    expect(getSyncErrorMessage('connection refused')).toBe(ACTIONABLE);
    expect(getSyncErrorMessage('transport error: operation timed out')).toBe(ACTIONABLE);
  });
});

describe('getSyncErrorMessage — real server/auth errors are NOT rewritten', () => {
  it('passes an HTTP error body through verbatim (e.g. wrong password → 401)', () => {
    expect(getSyncErrorMessage('HTTP 401: {"error":"invalid credentials"}')).toBe(
      'HTTP 401: {"error":"invalid credentials"}',
    );
    expect(getSyncErrorMessage(new Error('401 Unauthorized'))).toBe('401 Unauthorized');
  });

  it('passes crypto/config errors through verbatim', () => {
    expect(getSyncErrorMessage('invalid password')).toBe('invalid password');
    expect(getSyncErrorMessage(new Error('Sync not configured'))).toBe('Sync not configured');
  });

  it('stringifies other non-Error throwables verbatim', () => {
    expect(getSyncErrorMessage('plain string failure')).toBe('plain string failure');
  });
});
