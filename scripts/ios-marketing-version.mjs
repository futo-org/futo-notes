#!/usr/bin/env node
// Resolve the CFBundleShortVersionString (Xcode MARKETING_VERSION) for a native
// iOS build and print it to stdout.
//
//   * On a SemVer release tag (e.g. v1.6.0)      -> that version (1.6.0).
//   * Otherwise (main / dogfood builds)          -> the latest GitLab release
//     with its patch bumped (latest 1.6.0 -> 1.6.1), so main builds read as one
//     patch ahead of the last release in TestFlight.
//
// The build NUMBER (CFBundleVersion), not this string, is what must strictly
// increase per TestFlight upload; CI passes CI_PIPELINE_IID for that. This value
// is cosmetic version labeling only, so a temporarily out-of-order latest
// release cannot break the upload — the build number still governs ordering.
//
// Mirrors the convention in polycentric's tools/expo/resolve-version.js.
// Reads CI_COMMIT_TAG, CI_API_V4_URL, CI_PROJECT_ID, CI_JOB_TOKEN.

import { pathToFileURL } from 'node:url';

const TAG_PATTERN = /^v(\d+\.\d+\.\d+.*)$/;
const FALLBACK_VERSION = '0.0.1';

// Bump the patch component, dropping any leading `v` and prerelease suffix:
// "1.6.0" -> "1.6.1", "v1.6.0-rc.1" -> "1.6.1", "2" -> "2.0.1".
export function bumpPatch(version) {
  const core = String(version).replace(/^v/, '').split('-')[0];
  const [major = '0', minor = '0', patch = '0'] = core.split('.');
  return `${major}.${minor}.${Number(patch) + 1}`;
}

// Pure resolution: a release tag maps to its own version; anything else maps to
// the latest release patch-bumped, or the fallback when no release is known.
export function resolveMarketingVersion({ tag, latestReleaseTag }) {
  const tagMatch = (tag ?? '').match(TAG_PATTERN);
  if (tagMatch) return tagMatch[1];
  if (latestReleaseTag) return bumpPatch(latestReleaseTag);
  return FALLBACK_VERSION;
}

// Fetch the newest GitLab release's tag. Returns null on any missing input or
// network/API failure so the caller falls back to a safe default.
async function fetchLatestReleaseTag({ apiUrl, projectId, token }) {
  if (!apiUrl || !projectId || !token) return null;
  try {
    const res = await fetch(`${apiUrl}/projects/${projectId}/releases?per_page=1`, {
      headers: { 'JOB-TOKEN': token },
    });
    if (!res.ok) return null;
    const releases = await res.json();
    const latest = Array.isArray(releases) ? releases[0] : null;
    return latest?.tag_name ?? latest?.name ?? null;
  } catch {
    return null;
  }
}

async function main() {
  const tag = process.env.CI_COMMIT_TAG || '';
  // Skip the network call entirely on tag builds — the version comes from the tag.
  const latestReleaseTag = TAG_PATTERN.test(tag)
    ? null
    : await fetchLatestReleaseTag({
        apiUrl: process.env.CI_API_V4_URL,
        projectId: process.env.CI_PROJECT_ID,
        token: process.env.CI_JOB_TOKEN,
      });
  process.stdout.write(resolveMarketingVersion({ tag, latestReleaseTag }));
}

// Run only when invoked directly so the test can import the pure helpers.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
