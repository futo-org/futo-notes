# Store release notes

One file per stable release, named for its tag: `release-notes/v1.7.2.md`.

This is what users read on the App Store and Google Play. The tag pipeline
submits both stores automatically, so these files are the only place that copy
comes from — there is no console step left to fix it in.

## Format

```markdown
# v1.7.2

Folders now sync to Windows correctly — a note filed in a folder your other
device created no longer fails to arrive.

Also in this release:

- Faster opening of very large notes.
- Fixed the cursor jumping when you clicked into a note.

## Short

Fixes folder sync on Windows, opens large notes faster, and stops the cursor
jumping when you click into a note.
```

- The `# v1.7.2` title is for reading the diff. It is never shown to users.
- Everything above `## Short` is the **App Store** "What's New" (≤ 4000 chars).
- Everything under `## Short` is the **Google Play** release note (≤ 500 chars).
- `## Short` is optional. Without it the same text serves both, and a body over
  500 characters fails the gate rather than being truncated mid-sentence.

## It is required, and it is checked early

`check:release-notes` runs in the test stage of every stable-tag pipeline and
feeds `release:gate`. A missing, empty, or oversized file fails the pipeline in
its first minutes — before any binary is built and long before either store is
published to.

The notes must exist **on the tagged commit**. Committing them after the fact
does not help; you have to re-tag. Write the file as part of the release MR.

Check a file before tagging:

```bash
node scripts/release-notes.mjs --tag v1.7.2 --check
```

Prerelease tags (`v1.7.2-4`) publish to nothing and need no file.

## Writing them

Lead with the fix or feature a user would notice, in their words, not the
subsystem's. "Folders now sync to Windows correctly" beats "fixed vault_fs
parent-absence handling on the non-unix branch". The `/release` skill's
changelog is a good starting point, but it is written for a reviewer reading a
diff — cut anything that only means something to someone who has seen the code.
