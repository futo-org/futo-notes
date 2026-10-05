import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  AppStoreConnectClient,
  AppStoreConnectError,
  EDITABLE_VERSION_STATES,
  classifyBuild,
  createToken,
  findBuild,
  findOpenReviewSubmission,
  findVersion,
  formatApiErrors,
  versionState,
} from './appstore-api.mjs';

// A throwaway P-256 key: App Store Connect keys are ES256, and the encoding of
// the signature is the part that must be right.
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

const decodeSegment = (segment) =>
  JSON.parse(Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());

describe('createToken', () => {
  it('builds the header and claims App Store Connect requires', () => {
    const token = createToken({
      keyId: 'ABC123',
      issuerId: 'issuer-uuid',
      privateKey,
      nowSeconds: 1_700_000_000,
    });
    const [header, payload] = token.split('.');

    expect(decodeSegment(header)).toEqual({ alg: 'ES256', kid: 'ABC123', typ: 'JWT' });
    expect(decodeSegment(payload)).toEqual({
      iss: 'issuer-uuid',
      iat: 1_700_000_000,
      exp: 1_700_000_900,
      aud: 'appstoreconnect-v1',
    });
  });

  it('expires within the 20 minutes Apple allows', () => {
    const { iat, exp } = decodeSegment(
      createToken({ keyId: 'k', issuerId: 'i', privateKey }).split('.')[1],
    );
    expect(exp - iat).toBeLessThanOrEqual(20 * 60);
    expect(exp - iat).toBeGreaterThan(0);
  });

  it('signs with raw r||s, not DER — Apple answers a DER signature with 401', () => {
    const token = createToken({ keyId: 'k', issuerId: 'i', privateKey });
    const [header, payload, signature] = token.split('.');
    const raw = Buffer.from(signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

    // A P-256 JOSE signature is exactly 64 bytes; DER is variable-length and
    // starts with 0x30. Both checks fail if the encoding regresses.
    expect(raw).toHaveLength(64);
    expect(raw[0]).not.toBe(0x30);

    const verified = createVerify('SHA256')
      .update(`${header}.${payload}`)
      .verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, raw);
    expect(verified).toBe(true);
  });

  it('accepts a PEM string, which is how the .p8 file is read', () => {
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    expect(typeof pem).toBe('string');
    expect(() => createToken({ keyId: 'k', issuerId: 'i', privateKey: pem })).not.toThrow();
  });
});

describe('formatApiErrors', () => {
  it('shows each error detail and its source pointer', () => {
    const formatted = formatApiErrors({
      errors: [
        {
          title: 'Conflict',
          detail: 'The version already exists.',
          source: { pointer: '/data/attributes/versionString' },
        },
        { title: 'Forbidden', detail: 'Not enough permission.' },
      ],
    });
    expect(formatted).toBe(
      '  Conflict (/data/attributes/versionString): The version already exists.\n' +
        '  Forbidden: Not enough permission.',
    );
  });

  it('returns an empty string when there is nothing to format', () => {
    expect(formatApiErrors(null)).toBe('');
    expect(formatApiErrors({ errors: [] })).toBe('');
  });
});

describe('AppStoreConnectClient', () => {
  const makeClient = (fetchImpl) =>
    new AppStoreConnectClient({ keyId: 'k', issuerId: 'i', privateKey, fetchImpl });

  const jsonResponse = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  });

  it('sends a bearer token and serialises query filters', async () => {
    const calls = [];
    const client = makeClient(async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(200, { data: [] });
    });

    await client.get('/v1/builds', {
      query: { 'filter[app]': '42', limit: 50, 'filter[x]': undefined },
    });

    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/v1/builds');
    expect(url.searchParams.get('filter[app]')).toBe('42');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.has('filter[x]')).toBe(false);
    expect(calls[0].init.headers.Authorization).toMatch(/^Bearer eyJ/);
  });

  it('raises the API error detail rather than a bare status code', async () => {
    const client = makeClient(async () =>
      jsonResponse(409, {
        errors: [{ title: 'Conflict', detail: 'Version 1.7.2 already exists.' }],
      }),
    );

    await expect(client.post('/v1/appStoreVersions', { data: {} })).rejects.toThrow(
      /HTTP 409[\s\S]*Version 1\.7\.2 already exists\./,
    );
    await expect(client.post('/v1/appStoreVersions', { data: {} })).rejects.toBeInstanceOf(
      AppStoreConnectError,
    );
  });

  it('treats 204 as an empty success', async () => {
    const client = makeClient(async () => ({ ok: true, status: 204, text: async () => '' }));
    await expect(client.patch('/v1/reviewSubmissions/1', { data: {} })).resolves.toBeNull();
  });
});

describe('findBuild', () => {
  const builds = [
    { id: 'a', attributes: { version: '430' } },
    { id: 'b', attributes: { version: '431' } },
  ];

  it('matches this pipeline’s build number, not the newest upload', () => {
    expect(findBuild(builds, { buildNumber: '430' }).id).toBe('a');
  });

  it('compares as a string so a numeric build number still matches', () => {
    expect(findBuild(builds, { buildNumber: 431 }).id).toBe('b');
  });

  it('returns null when the build is not there yet', () => {
    expect(findBuild(builds, { buildNumber: '999' })).toBeNull();
    expect(findBuild(undefined, { buildNumber: '430' })).toBeNull();
  });
});

describe('classifyBuild', () => {
  it('waits when the build has not appeared', () => {
    expect(classifyBuild(null)).toMatchObject({ done: false, ok: false });
  });

  it('waits while Apple is processing', () => {
    expect(classifyBuild({ attributes: { processingState: 'PROCESSING' } })).toMatchObject({
      done: false,
      ok: false,
    });
  });

  it('proceeds once the build is VALID', () => {
    expect(classifyBuild({ attributes: { processingState: 'VALID' } })).toMatchObject({
      done: true,
      ok: true,
    });
  });

  it.each(['INVALID', 'FAILED'])(
    'stops immediately on %s instead of waiting out the timeout',
    (state) => {
      const verdict = classifyBuild({ attributes: { processingState: state } });
      expect(verdict).toMatchObject({ done: true, ok: false });
      expect(verdict.reason).toContain(state);
    },
  );
});

describe('versionState', () => {
  it('prefers the modern appVersionState', () => {
    expect(
      versionState({
        attributes: { appVersionState: 'PREPARE_FOR_SUBMISSION', appStoreState: 'READY_FOR_SALE' },
      }),
    ).toBe('PREPARE_FOR_SUBMISSION');
  });

  it('falls back to the deprecated appStoreState', () => {
    expect(versionState({ attributes: { appStoreState: 'READY_FOR_SALE' } })).toBe(
      'READY_FOR_SALE',
    );
  });

  it('returns null when neither is present', () => {
    expect(versionState({ attributes: {} })).toBeNull();
    expect(versionState(null)).toBeNull();
  });
});

describe('EDITABLE_VERSION_STATES', () => {
  it('allows a version still being prepared or sent back by review', () => {
    for (const state of [
      'PREPARE_FOR_SUBMISSION',
      'DEVELOPER_REJECTED',
      'REJECTED',
      'METADATA_REJECTED',
    ]) {
      expect(EDITABLE_VERSION_STATES.has(state)).toBe(true);
    }
  });

  it('refuses a version that is already live or in review', () => {
    for (const state of [
      'READY_FOR_SALE',
      'IN_REVIEW',
      'WAITING_FOR_REVIEW',
      'PENDING_DEVELOPER_RELEASE',
    ]) {
      expect(EDITABLE_VERSION_STATES.has(state)).toBe(false);
    }
  });
});

describe('findVersion', () => {
  it('finds the row for this version string', () => {
    const versions = [
      { id: '1', attributes: { versionString: '1.7.1' } },
      { id: '2', attributes: { versionString: '1.7.2' } },
    ];
    expect(findVersion(versions, '1.7.2').id).toBe('2');
    expect(findVersion(versions, '1.8.0')).toBeNull();
    expect(findVersion(undefined, '1.7.2')).toBeNull();
  });
});

describe('findOpenReviewSubmission', () => {
  it('adopts a submission that is still open', () => {
    const submissions = [
      { id: 'old', attributes: { state: 'COMPLETE' } },
      { id: 'open', attributes: { state: 'READY_FOR_REVIEW' } },
    ];
    expect(findOpenReviewSubmission(submissions).id).toBe('open');
  });

  it('adopts one Apple flagged with unresolved issues', () => {
    expect(
      findOpenReviewSubmission([{ id: 'x', attributes: { state: 'UNRESOLVED_ISSUES' } }]).id,
    ).toBe('x');
  });

  it('does not adopt a submission already in review or finished', () => {
    expect(
      findOpenReviewSubmission([
        { id: 'a', attributes: { state: 'IN_REVIEW' } },
        { id: 'b', attributes: { state: 'COMPLETE' } },
      ]),
    ).toBeNull();
    expect(findOpenReviewSubmission([])).toBeNull();
  });
});
