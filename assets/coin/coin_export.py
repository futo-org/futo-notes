# What a `just coin` run records about itself: the digest of the sources, the digest
# of each export, and the manifest `just coin-check` reads. Imported by build-coin.py.

import hashlib
import json
import os
import zipfile

import bpy


# ── Export ───────────────────────────────────────────────────────────────────


def script_digest() -> str:
    """The hash of every .py beside this file, by name then bytes, in name order.

    scripts/check-coin-assets.mjs computes the same thing; change both together.
    """
    folder = os.path.dirname(os.path.abspath(__file__))
    digest = hashlib.sha256()
    for name in sorted(n for n in os.listdir(folder) if n.endswith(".py")):
        digest.update(name.encode("utf-8"))
        with open(os.path.join(folder, name), "rb") as handle:
            digest.update(handle.read())
    return digest.hexdigest()


def content_digest(path: str) -> str:
    """The hash of what a file MEANS, not of its bytes.

    For everything but the .usdz those are the same thing, and two runs of this
    script produce byte-identical .glb and .hdr files. A .usdz is a zip, and a
    zip stamps every entry with the time it was written, so its bytes change on
    every rebuild while its contents do not. Hashing the entries instead keeps
    `just coin-check` quiet about a regeneration that changed nothing, and still
    catches one that changed something.
    """
    if path.endswith(".usdz"):
        with zipfile.ZipFile(path) as archive:
            digest = hashlib.sha256()
            for name in sorted(archive.namelist()):
                digest.update(name.encode("utf-8"))
                digest.update(archive.read(name))
            return digest.hexdigest()
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def write_manifest(out_dir: str, digest: str) -> None:
    """Record what this run produced, so a stale export cannot ship unnoticed.

    CI has no Blender, so it cannot regenerate the coin to check it. What it CAN
    do is verify two things cheaply: that the script on disk is the one the
    outputs were built from, and that nobody hand-edited an output afterwards
    (M8 — generated files are never edited in place). Both are just hashes.

    `just coin-check` is that gate; `just coin` is how you make it pass again.
    """
    outputs = {}
    for name in ("futo-coin.glb", "futo-coin.usdz", "studio-env.hdr"):
        outputs[name] = content_digest(os.path.join(out_dir, name))
    manifest = {
        "source": "build-coin.py",
        "sourceSha256": digest,
        "blender": bpy.app.version_string.split()[0],
        "outputs": outputs,
    }
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2, sort_keys=True)
        handle.write("\n")
