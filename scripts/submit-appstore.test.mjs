// Flow tests for the App Store submission, against a fake App Store Connect.
//
// This code path runs for real exactly once per release, on a tag, after an
// hour of builds — so a scripted fake is the only way to see its branches
// before they matter. The fake asserts the requests Apple actually receives:
// the right build attached to the right version, the notes written to the
// right localization, and the submission submitted last.

import { generateKeyPairSync } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';

import { AppStoreConnectClient } from './lib/appstore-api.mjs';
import {
  attachBuild,
  ensureVersion,
  resolveApp,
  submitForReview,
  waitForBuild,
  writeWhatsNew,
} from './submit-appstore.mjs';

process.env.SUBMIT_APPSTORE_QUIET = '1';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

// A fake App Store Connect: `routes` maps "METHOD /path" to a handler, and
// every request is recorded so order and payloads can be asserted.
function fakeAsc(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    const method = init.method;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, pathname, body, query: Object.fromEntries(searchParams) });

    const handler = routes[`${method} ${pathname}`];
    if (!handler) {
      return {
        ok: false,
        status: 404,
        text: async () =>
          JSON.stringify({ errors: [{ title: 'Not Found', detail: `${method} ${pathname}` }] }),
      };
    }
    const result =
      typeof handler === 'function'
        ? handler({ body, query: Object.fromEntries(searchParams), calls })
        : handler;
    if (result?.__status && !(result.__status >= 200 && result.__status < 300)) {
      return {
        ok: false,
        status: result.__status,
        text: async () => JSON.stringify(result.payload),
      };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(result) };
  };

  return {
    calls,
    client: new AppStoreConnectClient({ keyId: 'k', issuerId: 'i', privateKey, fetchImpl }),
  };
}

describe('resolveApp', () => {
  it('resolves the bundle id to an app id', async () => {
    const { client, calls } = fakeAsc({ 'GET /v1/apps': { data: [{ id: '99', type: 'apps' }] } });
    const app = await resolveApp(client, 'com.futo.notes');

    expect(app.id).toBe('99');
    expect(calls[0].query['filter[bundleId]']).toBe('com.futo.notes');
  });

  it('explains the likely cause when the key cannot see the app', async () => {
    const { client } = fakeAsc({ 'GET /v1/apps': { data: [] } });
    await expect(resolveApp(client, 'com.futo.notes')).rejects.toThrow(/App Manager access/);
  });
});

describe('waitForBuild', () => {
  const query = {
    appId: '99',
    version: '1.7.2',
    buildNumber: '431',
    timeoutMinutes: 45,
    pollIntervalMs: 0,
  };

  it('filters on the app, marketing version and build number together', async () => {
    const { client, calls } = fakeAsc({
      'GET /v1/builds': {
        data: [{ id: 'b1', attributes: { version: '431', processingState: 'VALID' } }],
      },
    });
    const build = await waitForBuild(client, query);

    expect(build.id).toBe('b1');
    expect(calls[0].query).toMatchObject({
      'filter[app]': '99',
      'filter[preReleaseVersion.version]': '1.7.2',
      'filter[version]': '431',
    });
  });

  it('polls until the build finishes processing', async () => {
    let poll = 0;
    const { client } = fakeAsc({
      'GET /v1/builds': () => {
        poll += 1;
        const state = poll < 3 ? 'PROCESSING' : 'VALID';
        return { data: [{ id: 'b1', attributes: { version: '431', processingState: state } }] };
      },
    });

    await expect(waitForBuild(client, query)).resolves.toMatchObject({ id: 'b1' });
    expect(poll).toBe(3);
  });

  it('never attaches a different pipeline’s build', async () => {
    const { client } = fakeAsc({
      'GET /v1/builds': {
        data: [{ id: 'other', attributes: { version: '999', processingState: 'VALID' } }],
      },
    });

    await expect(waitForBuild(client, { ...query, timeoutMinutes: 0 })).rejects.toThrow(
      /not yet visible/,
    );
  });

  it('fails immediately on a rejected binary rather than polling to the timeout', async () => {
    let poll = 0;
    const { client } = fakeAsc({
      'GET /v1/builds': () => {
        poll += 1;
        return { data: [{ id: 'b1', attributes: { version: '431', processingState: 'INVALID' } }] };
      },
    });

    await expect(waitForBuild(client, query)).rejects.toThrow(/processingState INVALID/);
    expect(poll).toBe(1);
  });

  it('says the upload survived and the job is retryable when it times out', async () => {
    const { client } = fakeAsc({
      'GET /v1/builds': {
        data: [{ id: 'b1', attributes: { version: '431', processingState: 'PROCESSING' } }],
      },
    });

    await expect(waitForBuild(client, { ...query, timeoutMinutes: 0 })).rejects.toThrow(
      /Nothing was submitted[\s\S]*no rebuild is needed/,
    );
  });
});

describe('ensureVersion', () => {
  const args = { appId: '99', version: '1.7.2', releaseType: 'AFTER_APPROVAL' };

  it('creates the version when App Store Connect has none', async () => {
    const { client, calls } = fakeAsc({
      'GET /v1/apps/99/appStoreVersions': { data: [] },
      'POST /v1/appStoreVersions': { data: { id: 'v1' } },
    });

    await expect(ensureVersion(client, args)).resolves.toMatchObject({ id: 'v1' });
    expect(calls[1].body).toEqual({
      data: {
        type: 'appStoreVersions',
        attributes: { platform: 'IOS', versionString: '1.7.2', releaseType: 'AFTER_APPROVAL' },
        relationships: { app: { data: { type: 'apps', id: '99' } } },
      },
    });
  });

  it('reuses a version left behind by an earlier run instead of creating a second', async () => {
    const { client, calls } = fakeAsc({
      'GET /v1/apps/99/appStoreVersions': {
        data: [
          {
            id: 'v1',
            attributes: { versionString: '1.7.2', appVersionState: 'PREPARE_FOR_SUBMISSION' },
          },
        ],
      },
    });

    await expect(ensureVersion(client, args)).resolves.toMatchObject({ id: 'v1' });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('reuses a version Apple sent back so a re-run can resubmit it', async () => {
    const { client } = fakeAsc({
      'GET /v1/apps/99/appStoreVersions': {
        data: [{ id: 'v1', attributes: { versionString: '1.7.2', appVersionState: 'REJECTED' } }],
      },
    });
    await expect(ensureVersion(client, args)).resolves.toMatchObject({ id: 'v1' });
  });

  it('refuses to overwrite a version that is already live', async () => {
    const { client } = fakeAsc({
      'GET /v1/apps/99/appStoreVersions': {
        data: [
          {
            id: 'v1',
            attributes: { versionString: '1.7.2', appVersionState: 'READY_FOR_DISTRIBUTION' },
          },
        ],
      },
    });

    await expect(ensureVersion(client, args)).rejects.toThrow(
      /state READY_FOR_DISTRIBUTION, which this job must not overwrite/,
    );
  });

  it('refuses to overwrite a version already in review', async () => {
    const { client } = fakeAsc({
      'GET /v1/apps/99/appStoreVersions': {
        data: [{ id: 'v1', attributes: { versionString: '1.7.2', appVersionState: 'IN_REVIEW' } }],
      },
    });
    await expect(ensureVersion(client, args)).rejects.toThrow(/must not overwrite/);
  });
});

describe('attachBuild', () => {
  it('points the version at the build with a relationship patch', async () => {
    const { client, calls } = fakeAsc({ 'PATCH /v1/appStoreVersions/v1': { data: { id: 'v1' } } });
    await attachBuild(client, { versionId: 'v1', buildId: 'b1' });

    expect(calls[0].body).toEqual({
      data: {
        type: 'appStoreVersions',
        id: 'v1',
        relationships: { build: { data: { type: 'builds', id: 'b1' } } },
      },
    });
  });
});

describe('writeWhatsNew', () => {
  it('writes only whatsNew, and only on the requested locale', async () => {
    const { client, calls } = fakeAsc({
      'GET /v1/appStoreVersions/v1/appStoreVersionLocalizations': {
        data: [
          { id: 'loc-de', attributes: { locale: 'de-DE' } },
          { id: 'loc-en', attributes: { locale: 'en-US' } },
        ],
      },
      'PATCH /v1/appStoreVersionLocalizations/loc-en': { data: { id: 'loc-en' } },
    });

    await writeWhatsNew(client, {
      versionId: 'v1',
      locale: 'en-US',
      whatsNew: 'Fixed folder sync.',
    });

    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch.pathname).toBe('/v1/appStoreVersionLocalizations/loc-en');
    expect(patch.body.data.attributes).toEqual({ whatsNew: 'Fixed folder sync.' });
  });

  it('names the locales that do exist when the requested one does not', async () => {
    const { client } = fakeAsc({
      'GET /v1/appStoreVersions/v1/appStoreVersionLocalizations': {
        data: [{ id: 'loc-de', attributes: { locale: 'de-DE' } }],
      },
    });

    await expect(
      writeWhatsNew(client, { versionId: 'v1', locale: 'en-US', whatsNew: 'x' }),
    ).rejects.toThrow(/no en-US localization \(has: de-DE\)/);
  });
});

describe('submitForReview', () => {
  const args = { appId: '99', versionId: 'v1', version: '1.7.2' };
  let routes;

  beforeEach(() => {
    routes = {
      'GET /v1/apps/99/reviewSubmissions': { data: [] },
      'POST /v1/reviewSubmissions': {
        data: { id: 's1', attributes: { state: 'READY_FOR_REVIEW' } },
      },
      'GET /v1/reviewSubmissions/s1/items': { data: [] },
      'POST /v1/reviewSubmissionItems': { data: { id: 'i1' } },
      'PATCH /v1/reviewSubmissions/s1': {
        data: { id: 's1', attributes: { state: 'WAITING_FOR_REVIEW' } },
      },
    };
  });

  it('creates the submission, adds the version, then submits — in that order', async () => {
    const { client, calls } = fakeAsc(routes);
    await submitForReview(client, args);

    expect(calls.map((c) => `${c.method} ${c.pathname}`)).toEqual([
      'GET /v1/apps/99/reviewSubmissions',
      'POST /v1/reviewSubmissions',
      'GET /v1/reviewSubmissions/s1/items',
      'POST /v1/reviewSubmissionItems',
      'PATCH /v1/reviewSubmissions/s1',
    ]);

    const item = calls.find((c) => c.pathname === '/v1/reviewSubmissionItems');
    expect(item.body.data.relationships).toEqual({
      reviewSubmission: { data: { type: 'reviewSubmissions', id: 's1' } },
      appStoreVersion: { data: { type: 'appStoreVersions', id: 'v1' } },
    });

    const submit = calls.at(-1);
    expect(submit.body.data.attributes).toEqual({ submitted: true });
  });

  it('adopts an open submission rather than creating a second one Apple would reject', async () => {
    routes['GET /v1/apps/99/reviewSubmissions'] = {
      data: [{ id: 's1', attributes: { state: 'READY_FOR_REVIEW' } }],
    };
    const { client, calls } = fakeAsc(routes);
    await submitForReview(client, args);

    expect(calls.some((c) => c.pathname === '/v1/reviewSubmissions' && c.method === 'POST')).toBe(
      false,
    );
  });

  it('does not add the version twice when a retry finds it already on the submission', async () => {
    routes['GET /v1/apps/99/reviewSubmissions'] = {
      data: [{ id: 's1', attributes: { state: 'READY_FOR_REVIEW' } }],
    };
    routes['GET /v1/reviewSubmissions/s1/items'] = {
      data: [{ id: 'i1', relationships: { appStoreVersion: { data: { id: 'v1' } } } }],
    };
    const { client, calls } = fakeAsc(routes);
    await submitForReview(client, args);

    expect(calls.some((c) => c.pathname === '/v1/reviewSubmissionItems')).toBe(false);
    expect(calls.at(-1).body.data.attributes).toEqual({ submitted: true });
  });

  it('adds this version when the open submission holds a different one', async () => {
    routes['GET /v1/apps/99/reviewSubmissions'] = {
      data: [{ id: 's1', attributes: { state: 'READY_FOR_REVIEW' } }],
    };
    routes['GET /v1/reviewSubmissions/s1/items'] = {
      data: [{ id: 'i0', relationships: { appStoreVersion: { data: { id: 'other' } } } }],
    };
    const { client, calls } = fakeAsc(routes);
    await submitForReview(client, args);

    expect(calls.some((c) => c.pathname === '/v1/reviewSubmissionItems')).toBe(true);
  });
});
