#!/usr/bin/env node
// Create the App Store version for a tag, attach the TestFlight build, write
// the release notes, and submit it for review — the clicking that used to
// follow every `publish:ios` upload.
//
//   node scripts/submit-appstore.mjs \
//     --bundle-id com.futo.notes --version 1.7.2 --build-number 431 \
//     --notes-file release-notes/v1.7.2.md
//
// Auth: ASC_KEY_ID + ASC_ISSUER_ID (CI variables, already used by altool) and
// the .p8 private key, via --key-file or ASC_PRIVATE_KEY.
//
// Idempotent by design. `publish:ios:appstore` is a retryable CI job and the
// build can take half an hour to process, so every step reuses what is already
// there: an existing version row in an editable state, an open review
// submission, the localization rows Apple creates with the version. Re-running
// after a timeout picks up where it stopped instead of creating a second
// version Apple will reject.
//
// What it deliberately does NOT do: screenshots, description, keywords, age
// rating, pricing, and the App Privacy answers. Those change rarely, are not in
// the repo, and a script that rewrites them on every release is a way to ship a
// wrong store listing. docs/release/store-submission.md owns them.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  AppStoreConnectClient,
  AppStoreConnectError,
  EDITABLE_VERSION_STATES,
  classifyBuild,
  findBuild,
  findOpenReviewSubmission,
  findVersion,
  versionState,
} from './lib/appstore-api.mjs';
import { APP_STORE_LIMIT, parseReleaseNotes, validateReleaseNotes } from './lib/release-notes.mjs';

const PLATFORM = 'IOS';
const DEFAULT_LOCALE = 'en-US';
// Apple's own processing regularly takes 15-30 minutes after an altool upload.
const DEFAULT_TIMEOUT_MINUTES = 45;
const POLL_INTERVAL_MS = 30_000;

// Quiet under test: these are progress lines for a human watching a CI job.
const log = (message) => {
  if (!process.env.SUBMIT_APPSTORE_QUIET) process.stdout.write(`${message}\n`);
};

function parseArgs(argv) {
  const args = {
    bundleId: 'com.futo.notes',
    version: '',
    buildNumber: '',
    notesFile: '',
    locale: DEFAULT_LOCALE,
    releaseType: 'AFTER_APPROVAL',
    keyFile: '',
    timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
    dryRun: false,
  };
  const map = {
    '--bundle-id': 'bundleId',
    '--version': 'version',
    '--build-number': 'buildNumber',
    '--notes-file': 'notesFile',
    '--locale': 'locale',
    '--release-type': 'releaseType',
    '--key-file': 'keyFile',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--timeout-minutes') args.timeoutMinutes = Number(argv[++i]);
    else if (map[arg]) args[map[arg]] = argv[++i] ?? '';
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function loadPrivateKey({ keyFile }) {
  if (keyFile) return readFileSync(keyFile, 'utf8');
  if (process.env.ASC_PRIVATE_KEY) return process.env.ASC_PRIVATE_KEY;
  throw new Error(
    'No App Store Connect private key: pass --key-file <AuthKey_XXX.p8> or set ASC_PRIVATE_KEY.',
  );
}

function loadNotes({ notesFile, tag }) {
  const source = readFileSync(notesFile, 'utf8');
  const notes = parseReleaseNotes(source);
  const problems = validateReleaseNotes(notes, { tag });
  if (problems.length > 0) throw new Error(problems.join('\n'));
  return notes.appStore;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Flow steps ────────────────────────────────────────────────────────────

export async function resolveApp(client, bundleId) {
  const response = await client.get('/v1/apps', { query: { 'filter[bundleId]': bundleId } });
  const app = response?.data?.[0];
  if (!app) {
    throw new Error(
      `No app with bundle id ${bundleId} is visible to this API key. ` +
        'The key needs App Manager access, and the app must already exist in App Store Connect.',
    );
  }
  return app;
}

// Wait for the uploaded binary to finish Apple-side processing. A version
// cannot reference a build until then, so this is the long pole of the job.
export async function waitForBuild(
  client,
  { appId, version, buildNumber, timeoutMinutes, pollIntervalMs = POLL_INTERVAL_MS },
) {
  const deadline = Date.now() + timeoutMinutes * 60_000;
  let lastReason = '';

  for (;;) {
    const response = await client.get('/v1/builds', {
      query: {
        'filter[app]': appId,
        'filter[preReleaseVersion.version]': version,
        'filter[version]': buildNumber,
        limit: 50,
      },
    });
    const build = findBuild(response?.data, { buildNumber });
    const verdict = classifyBuild(build);

    if (verdict.done && verdict.ok) return build;
    if (verdict.done && !verdict.ok) throw new Error(verdict.reason);

    if (verdict.reason !== lastReason) {
      lastReason = verdict.reason;
      log(`Build ${version} (${buildNumber}): ${verdict.reason} — waiting`);
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Build ${version} (${buildNumber}) was ${lastReason} after ${timeoutMinutes} minutes. ` +
          'Nothing was submitted. The upload itself succeeded (publish:ios), so retry THIS job ' +
          'once App Store Connect shows the build as processed — no rebuild is needed.',
      );
    }
    await sleep(pollIntervalMs);
  }
}

// Reuse the version row if one exists and is still editable; create it otherwise.
export async function ensureVersion(client, { appId, version, releaseType }) {
  const existing = await client.get(`/v1/apps/${appId}/appStoreVersions`, {
    query: { 'filter[versionString]': version, 'filter[platform]': PLATFORM, limit: 10 },
  });
  const found = findVersion(existing?.data, version);

  if (found) {
    const state = versionState(found);
    if (!EDITABLE_VERSION_STATES.has(state)) {
      throw new Error(
        `App Store version ${version} is in state ${state}, which this job must not overwrite. ` +
          'It has already been submitted or released. Resolve it in App Store Connect; ' +
          'if you meant to ship a different build, tag a new version.',
      );
    }
    log(`Reusing App Store version ${version} (state ${state})`);
    return found;
  }

  log(`Creating App Store version ${version} (releaseType ${releaseType})`);
  const created = await client.post('/v1/appStoreVersions', {
    data: {
      type: 'appStoreVersions',
      attributes: { platform: PLATFORM, versionString: version, releaseType },
      relationships: { app: { data: { type: 'apps', id: appId } } },
    },
  });
  return created.data;
}

export async function attachBuild(client, { versionId, buildId }) {
  await client.patch(`/v1/appStoreVersions/${versionId}`, {
    data: {
      type: 'appStoreVersions',
      id: versionId,
      relationships: { build: { data: { type: 'builds', id: buildId } } },
    },
  });
}

// Apple creates one localization row per locale with the version; we only
// rewrite whatsNew on the one we own, leaving description/keywords untouched.
export async function writeWhatsNew(client, { versionId, locale, whatsNew }) {
  const response = await client.get(
    `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations`,
    {
      query: { limit: 50 },
    },
  );
  const localizations = response?.data ?? [];
  const target = localizations.find((l) => l?.attributes?.locale === locale);

  if (!target) {
    const available = localizations.map((l) => l?.attributes?.locale).join(', ') || 'none';
    throw new Error(
      `App Store version ${versionId} has no ${locale} localization (has: ${available}). ` +
        'Pass --locale with one of those, or add the locale in App Store Connect.',
    );
  }

  await client.patch(`/v1/appStoreVersionLocalizations/${target.id}`, {
    data: { type: 'appStoreVersionLocalizations', id: target.id, attributes: { whatsNew } },
  });
}

// Create (or adopt) the review submission, put this version in it, and submit.
export async function submitForReview(client, { appId, versionId, version }) {
  const open = await client.get(`/v1/apps/${appId}/reviewSubmissions`, {
    query: { 'filter[state]': 'READY_FOR_REVIEW,UNRESOLVED_ISSUES', limit: 10 },
  });
  let submission = findOpenReviewSubmission(open?.data);

  if (submission) {
    log(`Reusing open review submission ${submission.id}`);
  } else {
    const created = await client.post('/v1/reviewSubmissions', {
      data: {
        type: 'reviewSubmissions',
        attributes: { platform: PLATFORM },
        relationships: { app: { data: { type: 'apps', id: appId } } },
      },
    });
    submission = created.data;
    log(`Created review submission ${submission.id}`);
  }

  const items = await client.get(`/v1/reviewSubmissions/${submission.id}/items`, {
    query: { limit: 50 },
  });
  const alreadyIncluded = (items?.data ?? []).some(
    (item) => item?.relationships?.appStoreVersion?.data?.id === versionId,
  );

  if (alreadyIncluded) {
    log(`Version ${version} is already an item on submission ${submission.id}`);
  } else {
    await client.post('/v1/reviewSubmissionItems', {
      data: {
        type: 'reviewSubmissionItems',
        relationships: {
          reviewSubmission: { data: { type: 'reviewSubmissions', id: submission.id } },
          appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } },
        },
      },
    });
    log(`Added version ${version} to submission ${submission.id}`);
  }

  await client.patch(`/v1/reviewSubmissions/${submission.id}`, {
    data: { type: 'reviewSubmissions', id: submission.id, attributes: { submitted: true } },
  });
  return submission;
}

// ── Entry point ───────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.version) throw new Error('Pass --version <marketing version>, e.g. 1.7.2.');
  if (!args.buildNumber) throw new Error('Pass --build-number <CFBundleVersion>.');
  if (!args.notesFile) throw new Error('Pass --notes-file release-notes/vX.Y.Z.md.');

  const keyId = process.env.ASC_KEY_ID;
  const issuerId = process.env.ASC_ISSUER_ID;
  if (!keyId || !issuerId) {
    throw new Error('ASC_KEY_ID and ASC_ISSUER_ID must be set (the same values publish:ios uses).');
  }

  const whatsNew = loadNotes({ notesFile: args.notesFile, tag: `v${args.version}` });
  log(`Release notes: ${whatsNew.length}/${APP_STORE_LIMIT} characters`);

  const client = new AppStoreConnectClient({
    keyId,
    issuerId,
    privateKey: loadPrivateKey({ keyFile: args.keyFile }),
  });

  const app = await resolveApp(client, args.bundleId);
  log(`App ${args.bundleId} → id ${app.id}`);

  const build = await waitForBuild(client, {
    appId: app.id,
    version: args.version,
    buildNumber: args.buildNumber,
    timeoutMinutes: args.timeoutMinutes,
  });
  log(`Build ${args.version} (${args.buildNumber}) → id ${build.id}, processed`);

  if (args.dryRun) {
    log('--dry-run: the build is ready and the notes validate; nothing was created or submitted.');
    return;
  }

  const version = await ensureVersion(client, {
    appId: app.id,
    version: args.version,
    releaseType: args.releaseType,
  });

  await attachBuild(client, { versionId: version.id, buildId: build.id });
  log(`Attached build ${args.buildNumber} to version ${args.version}`);

  await writeWhatsNew(client, { versionId: version.id, locale: args.locale, whatsNew });
  log(`Wrote ${args.locale} release notes`);

  const submission = await submitForReview(client, {
    appId: app.id,
    versionId: version.id,
    version: args.version,
  });

  log(
    `Submitted ${args.bundleId} ${args.version} (build ${args.buildNumber}) for App Store review ` +
      `— submission ${submission.id}, releaseType ${args.releaseType}.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    const detail =
      error instanceof AppStoreConnectError ? error.message : String(error.message ?? error);
    process.stderr.write(`${detail}\n`);
    process.exit(1);
  });
}
