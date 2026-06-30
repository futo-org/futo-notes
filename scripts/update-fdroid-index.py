#!/usr/bin/env python3
"""Add (or update) this release's APK entry in the FUTO F-Droid repo.

Runs on tag pipelines (see the `update-fdroid` job in .gitlab-ci.yml). Modeled
on grayjay-android's update_fdroid_index.py, with one deliberate difference:
Grayjay publishes to a *fixed* "latest" URL and rewrites a single entry in
place. Our durable URL is **version-pinned** — it points at the GitLab generic
package registry asset the `release` job uploads for this exact tag:

    {CI_API_V4_URL}/projects/{CI_PROJECT_ID}/packages/generic/futo-notes/{tag}/futo-notes-{version}.apk

So instead of mutating one entry, we upsert a new `{url, sha256sum, date,
version-code}` block keyed by version-code (idempotent across pipeline re-runs)
and let repo-v2's `keep-latest` prune old versions. This preserves a short
version history on F-Droid, matching how the Voice/Keyboard entries look.

The sha256 is computed from the release APK built in this same pipeline
(needs: build:android-native) — byte-identical to the uploaded package, since
`release` uploads that same file without repacking.

Stdlib only (no PyYAML): the edit is line-based so the file's formatting and
any comments survive untouched.
"""
from __future__ import annotations

import datetime
import glob
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
from typing import Optional

FDROID_REPO_SSH = "git@gitlab.futo.org:fdroid/repo-v2.git"
FDROID_INDEX_PATH = "apps/Notes/index.yml"
APK_GLOB = "apps/android/app/build/outputs/apk/release/*.apk"

GIT_USER_NAME = os.environ.get("FDROID_GIT_NAME", "FUTO Notes CI")
GIT_USER_EMAIL = os.environ.get("FDROID_GIT_EMAIL", "futo-notes-ci@futo.org")


class Fatal(Exception):
    pass


def run(cmd: list[str], *, cwd: Optional[str] = None) -> str:
    p = subprocess.run(
        cmd, cwd=cwd, check=False, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    if p.returncode != 0:
        raise Fatal(f"Command failed ({p.returncode}): {' '.join(cmd)}\n{p.stdout}")
    return p.stdout.strip()


def sha256_of_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def pick_release_apk() -> str:
    matches = sorted(glob.glob(APK_GLOB))
    if not matches:
        raise Fatal(f"No release APK found via glob: {APK_GLOB}")
    for m in matches:
        if "release" in os.path.basename(m):
            return m
    return matches[-1]


def parse_tag() -> tuple[str, str, int]:
    """Return (tag, version, version_code) using the repo's release scheme:
    versionCode = MAJOR*1_000_000 + MINOR*1_000 + PATCH  (matches .gitlab-ci.yml).
    """
    tag = os.environ.get("CI_COMMIT_TAG", "").strip()
    if not tag:
        tag = run(["git", "describe", "--tags"]).strip()
    if not tag:
        raise Fatal("No tag: set CI_COMMIT_TAG or run on a tagged commit.")

    version = tag[1:] if tag.lower().startswith("v") else tag

    def lead_int(s: str) -> int:
        m = re.match(r"\d+", s)
        return int(m.group(0)) if m else 0

    parts = version.split(".")
    maj = lead_int(parts[0]) if len(parts) > 0 else 0
    minr = lead_int(parts[1]) if len(parts) > 1 else 0
    pat = lead_int(parts[2]) if len(parts) > 2 else 0
    return tag, version, maj * 1_000_000 + minr * 1_000 + pat


def build_apk_url(tag: str, version: str) -> str:
    api = os.environ.get("CI_API_V4_URL", "https://gitlab.futo.org/api/v4").rstrip("/")
    project = os.environ.get("CI_PROJECT_ID", "488")
    return f"{api}/projects/{project}/packages/generic/futo-notes/{tag}/futo-notes-{version}.apk"


def today_utc() -> str:
    return datetime.datetime.now(datetime.timezone.utc).date().isoformat()


def upsert_apk_entry(path: str, url: str, sha: str, date_str: str, version_code: int) -> str:
    """Upsert a 4-field apk entry keyed by version-code. Returns 'added'/'updated'."""
    with open(path, "r", encoding="utf-8") as f:
        lines = f.read().splitlines()

    apks_idx = next(
        (i for i, l in enumerate(lines) if re.match(r"^apks:\s*$", l)),
        None,
    )
    if apks_idx is None:
        raise Fatal(f"No top-level 'apks:' key in {path}")

    head, body = lines[: apks_idx + 1], lines[apks_idx + 1 :]

    # Detect indentation from the first existing list item (fall back to 2/4).
    item_indent, child_indent = "  ", "    "
    for l in body:
        if l.lstrip().startswith("- "):
            item_indent = l[: len(l) - len(l.lstrip())]
            child_indent = item_indent + "  "
            break

    # Split body into entries (each starts with a `- ` line at item_indent);
    # anything dedented below apks ends the list and is preserved as trailer.
    entries: list[list[str]] = []
    trailer: list[str] = []
    cur: Optional[list[str]] = None
    for l in body:
        stripped = l.strip()
        if l.startswith(item_indent + "- "):
            if cur is not None:
                entries.append(cur)
            cur = [l]
        elif cur is not None and (stripped == "" or l.startswith(child_indent)):
            cur.append(l)
        else:
            if cur is not None:
                entries.append(cur)
                cur = None
            trailer.append(l)
    if cur is not None:
        entries.append(cur)

    def vc_of(block: list[str]) -> Optional[int]:
        for l in block:
            m = re.match(r"\s*version-code:\s*(\d+)", l)
            if m:
                return int(m.group(1))
        return None

    new_block = [
        f"{item_indent}- url: {url}",
        f"{child_indent}sha256sum: {sha}",
        f"{child_indent}date: {date_str}",
        f"{child_indent}version-code: {version_code}",
    ]

    replaced = False
    out: list[list[str]] = []
    for b in entries:
        if vc_of(b) == version_code:
            out.append(new_block)
            replaced = True
        else:
            out.append(b)
    if not replaced:
        out.insert(0, new_block)  # newest first (matches the Keyboard entry)

    result = head + [l for block in out for l in block] + trailer
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(result).rstrip("\n") + "\n")
    return "updated" if replaced else "added"


def main() -> int:
    tag, version, version_code = parse_tag()
    url = build_apk_url(tag, version)
    date_str = today_utc()

    apk = pick_release_apk()
    print(f"APK         : {apk}")
    sha = sha256_of_file(apk)
    print(f"version     : {version}  (code {version_code})")
    print(f"url         : {url}")
    print(f"sha256      : {sha}")
    print(f"date        : {date_str}")

    tmp = tempfile.mkdtemp(prefix="fdroid-repo-")
    try:
        run(["git", "clone", "--depth", "1", FDROID_REPO_SSH, tmp])
        run(["git", "config", "user.name", GIT_USER_NAME], cwd=tmp)
        run(["git", "config", "user.email", GIT_USER_EMAIL], cwd=tmp)

        index_path = os.path.join(tmp, FDROID_INDEX_PATH)
        if not os.path.exists(index_path):
            raise Fatal(f"Missing {FDROID_INDEX_PATH} in repo-v2 — add the app first.")

        action = upsert_apk_entry(index_path, url, sha, date_str, version_code)

        run(["git", "add", FDROID_INDEX_PATH], cwd=tmp)
        if subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=tmp).returncode == 0:
            print("No changes — index already up to date.")
            return 0

        msg = f"FUTO Notes: {action} version-code {version_code} ({version})"
        run(["git", "commit", "-m", msg], cwd=tmp)
        run(["git", "push"], cwd=tmp)
        print(f"Pushed to fdroid/repo-v2: {msg}")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Fatal as e:
        print(f"ERROR: {e}", file=sys.stderr)
        raise SystemExit(2)
