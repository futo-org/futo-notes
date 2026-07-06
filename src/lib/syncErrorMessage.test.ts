// Spec (sync.md): "Opaque fetch TypeErrors (server unreachable) are rewritten
// to an actionable message."
//
// Two transports produce those opaque errors:
//  - Browser/webview fetch: rejects with a TypeError ("Failed to fetch", …).
//  - Desktop Tauri invoke(): rejects with the PLAIN STRING Display of the Rust
//    error — reqwest transport failures surface as
//    `E2eeHttpError::Transport` → "transport error: {reqwest}" (see
//    crates/futo-notes-sync/src/client.rs). Regression (2026-07-02 QA):
//    these strings were shown verbatim in Settings.
//
// Real server responses (e.g. HTTP 401 wrong password) must still pass
// through untouched — only network-layer failures are rewritten.
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
    // Verbatim QA capture: desktop connect to an unreachable server.
    expect(
      getSyncErrorMessage(
        'transport error: error sending request for url (http://127.0.0.1:9/api/auth/password/login)',
      ),
    ).toBe(ACTIONABLE);
  });

  it('rewrites the same string when re-wrapped in an Error (autoSyncV2 background path)', () => {
    // autoSyncV2.performSync wraps non-Errors: new Error(String(e)).
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
    // E2eeHttpError::Http Display: "HTTP {status}: {body}".
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
