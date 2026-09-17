// Release-notes source of truth for the two app stores.
//
// One file per stable release, `release-notes/v<X.Y.Z>.md`, feeds BOTH store
// submissions: App Store Connect's "What's New" (whatsNew, 4000 chars) and
// Google Play's release notes (500 chars). The two limits are far apart, so the
// file may carry a shorter Play variant under a `## Short` heading; without one
// the same text serves both and a body over 500 chars is a hard error rather
// than a silent truncation — a release note cut mid-sentence ships to every
// Play user and cannot be edited without a new release.
//
// The file is REQUIRED on a stable tag. `scripts/release-notes.mjs --check`
// runs in the test stage and feeds release:gate, so a missing or oversized file
// fails the pipeline in its first minutes instead of after the binaries are
// built and one store has already been published to.

// App Store Connect appStoreVersionLocalizations.whatsNew.
export const APP_STORE_LIMIT = 4000;
// Google Play Edits.tracks releases[].releaseNotes[].text.
export const PLAY_LIMIT = 500;

const SHORT_HEADING = /^##\s+Short\s*$/im;

export const STABLE_TAG_PATTERN = /^v\d+\.\d+\.\d+$/;

// `release-notes/v1.7.2.md` for tag `v1.7.2`. Exported so the CLI, the CI gate
// and the error messages all name the same path.
export function releaseNotesPath(tag) {
  return `release-notes/${tag}.md`;
}

// Split a release-notes file into its two store texts.
//
// The leading `# <tag>` title is a human affordance for reading the file in a
// diff; it is never part of what the stores show, so it is dropped. Everything
// up to `## Short` is the App Store text; everything after it is the Play text.
// With no `## Short`, the App Store text serves both.
export function parseReleaseNotes(source) {
  const withoutTitle = String(source).replace(/^\s*#\s+[^\n]*\n/, '');
  const shortMatch = withoutTitle.match(SHORT_HEADING);

  if (!shortMatch) {
    const body = withoutTitle.trim();
    return { appStore: body, play: body, hasShort: false };
  }

  const appStore = withoutTitle.slice(0, shortMatch.index).trim();
  const play = withoutTitle.slice(shortMatch.index + shortMatch[0].length).trim();
  return { appStore, play, hasShort: true };
}

// Every reason this file cannot be submitted, as complete sentences naming the
// file. Returning all of them at once matters: the gate runs on a tag pipeline,
// and a fix-one-error-at-a-time loop costs a tag push per problem.
export function validateReleaseNotes(notes, { tag } = {}) {
  const path = tag ? releaseNotesPath(tag) : 'the release notes';
  const problems = [];

  if (!notes.appStore) {
    problems.push(`${path} has no App Store text (the body above \`## Short\` is empty).`);
  } else if (notes.appStore.length > APP_STORE_LIMIT) {
    problems.push(
      `${path}: the App Store text is ${notes.appStore.length} characters; ` +
        `App Store Connect accepts at most ${APP_STORE_LIMIT}.`,
    );
  }

  if (!notes.play) {
    problems.push(`${path} has no Google Play text (the body under \`## Short\` is empty).`);
  } else if (notes.play.length > PLAY_LIMIT) {
    const remedy = notes.hasShort
      ? `shorten the \`## Short\` section`
      : `add a \`## Short\` section of at most ${PLAY_LIMIT} characters for Play`;
    problems.push(
      `${path}: the Google Play text is ${notes.play.length} characters; ` +
        `Play accepts at most ${PLAY_LIMIT} — ${remedy}.`,
    );
  }

  return problems;
}
