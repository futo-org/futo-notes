// App Store Connect API v1 client, plus the pure decisions the submit flow makes.
//
// Deliberately dependency-free: the JWT is ES256, which node:crypto signs
// natively, and `fetch` is built in. That keeps the submitter runnable on the
// plain Linux CI image alongside every other scripts/*.mjs, instead of needing
// Ruby + fastlane on the single macOS runner. Only the IPA upload needs macOS
// (xcrun altool, .cirrus.yml publishFutoNotesIOS); everything after it is REST.
//
// Request shapes are the ones fastlane's spaceship uses against the same API
// (spaceship/lib/spaceship/connect_api/tunes/tunes.rb).

import { createSign } from 'node:crypto';

const BASE_URL = 'https://api.appstoreconnect.apple.com';

// Apple rejects a token older than 20 minutes. 15 leaves room for clock skew
// while still outliving any single request.
const TOKEN_LIFETIME_SECONDS = 15 * 60;

const base64url = (input) =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Build the signed ES256 JWT App Store Connect expects.
//
// `nowSeconds` is injectable so the claim set can be asserted without freezing
// the clock. The signature must be raw r||s (JOSE), NOT the DER encoding
// node:crypto emits by default — hence `dsaEncoding: 'ieee-p1363'`. A DER
// signature is well-formed to OpenSSL and rejected by Apple as 401 NOT_AUTHORIZED,
// which reads like a bad key rather than a bad encoding.
export function createToken({
  keyId,
  issuerId,
  privateKey,
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
  const payload = {
    iss: issuerId,
    iat: nowSeconds,
    exp: nowSeconds + TOKEN_LIFETIME_SECONDS,
    aud: 'appstoreconnect-v1',
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = createSign('SHA256')
    .update(signingInput)
    .sign({ key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${base64url(signature)}`;
}

// Flatten Apple's JSON:API error array into one readable line per error.
// Apple's `detail` is the only field that says what to actually change.
export function formatApiErrors(body) {
  const errors = body?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return '';
  return errors
    .map((error) => {
      const pointer = error?.source?.pointer ? ` (${error.source.pointer})` : '';
      return `  ${error.title ?? 'Error'}${pointer}: ${error.detail ?? error.code ?? ''}`.trimEnd();
    })
    .join('\n');
}

export class AppStoreConnectError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'AppStoreConnectError';
    this.status = status;
    this.body = body;
  }
}

export class AppStoreConnectClient {
  constructor({ keyId, issuerId, privateKey, fetchImpl = fetch, baseUrl = BASE_URL }) {
    this.keyId = keyId;
    this.issuerId = issuerId;
    this.privateKey = privateKey;
    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl;
  }

  // Minted per request: a long poll for build processing easily outlives one
  // token, and signing is cheap.
  token() {
    return createToken({
      keyId: this.keyId,
      issuerId: this.issuerId,
      privateKey: this.privateKey,
    });
  }

  async request(method, path, { query, body } = {}) {
    const url = new URL(path.startsWith('http') ? path : `${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const response = await this.fetchImpl(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${this.token()}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (response.status === 204) return null;

    const text = await response.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    if (!response.ok) {
      const details = formatApiErrors(parsed);
      throw new AppStoreConnectError(
        `App Store Connect ${method} ${url.pathname} failed (HTTP ${response.status})` +
          (details ? `\n${details}` : `\n  ${text.slice(0, 500)}`),
        { status: response.status, body: parsed },
      );
    }

    return parsed;
  }

  get = (path, options) => this.request('GET', path, options);
  post = (path, body) => this.request('POST', path, { body });
  patch = (path, body) => this.request('PATCH', path, { body });
}

// ── Pure decisions ────────────────────────────────────────────────────────

// An App Store version can only be edited before it is submitted. Any other
// state means a human already moved this version along, and overwriting it
// would either fail confusingly or silently retract a live submission.
export const EDITABLE_VERSION_STATES = new Set([
  'PREPARE_FOR_SUBMISSION',
  'DEVELOPER_REJECTED',
  'REJECTED',
  'METADATA_REJECTED',
  'INVALID_BINARY',
]);

// Apple returns both the modern `appVersionState` and the deprecated
// `appStoreState`; older apps have only the latter. Read whichever is present
// so this doesn't break when Apple finishes the deprecation.
export function versionState(version) {
  return version?.attributes?.appVersionState ?? version?.attributes?.appStoreState ?? null;
}

// Find the version row matching `versionString`, if App Store Connect already
// has one (a re-run of this job, or a version a human started by hand).
export function findVersion(versions, versionString) {
  return (versions ?? []).find((v) => v?.attributes?.versionString === versionString) ?? null;
}

// Pick the uploaded build for THIS pipeline by its build number, never "the
// newest build": two tag pipelines can be in flight at once, and attaching the
// wrong binary to a version is invisible until a reviewer opens it. The caller
// already constrains the query to this app and marketing version, so the build
// number is what disambiguates within the answer.
export function findBuild(builds, { buildNumber }) {
  return (builds ?? []).find((b) => String(b?.attributes?.version) === String(buildNumber)) ?? null;
}

// What to do with a build we found (or didn't) while polling.
// Separated from the polling loop so every outcome is asserted without waiting.
export function classifyBuild(build) {
  if (!build) return { done: false, ok: false, reason: 'not yet visible in App Store Connect' };
  const state = build?.attributes?.processingState;
  if (state === 'VALID') return { done: true, ok: true, state };
  if (state === 'PROCESSING') return { done: false, ok: false, state, reason: 'still processing' };
  return {
    done: true,
    ok: false,
    state,
    reason: `App Store Connect rejected the binary (processingState ${state}).`,
  };
}

// Reuse an open review submission rather than creating a second one: Apple
// allows only one per app at a time and answers a duplicate with a 409 that
// says nothing useful.
export function findOpenReviewSubmission(submissions) {
  return (
    (submissions ?? []).find((s) =>
      ['READY_FOR_REVIEW', 'UNRESOLVED_ISSUES'].includes(s?.attributes?.state),
    ) ?? null
  );
}
