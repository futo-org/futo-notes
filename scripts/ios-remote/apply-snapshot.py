#!/usr/bin/env python3
"""Apply an allowlisted source archive inside a managed worktree, preserving caches.

Only previous source files are removed. No directory or computed ancestor is
recursively deleted; archive writes use atomic replacement and never follow a
symlink into another tree. The caller holds the native test OS lock.
"""
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import shutil
import uuid
import sys
import tarfile
import tempfile


def apply(root, manifest_file, archive):
    root = Path(root).resolve()
    current = set(json.loads(Path(manifest_file).read_text()))
    state_path = subprocess.check_output(
        ["git", "rev-parse", "--git-path", "futo-ios-remote-manifest.json"], cwd=root, text=True
    ).strip()
    state = Path(state_path) if Path(state_path).is_absolute() else root / state_path
    previous = set(json.loads(state.read_text())) if state.exists() else set()
    tracked = set(subprocess.check_output(["git", "ls-files", "-z"], cwd=root).decode().split("\0")) - {""}

    def save_manifest(names):
        descriptor, staged_name = tempfile.mkstemp(prefix=".ios-source-manifest-", dir=state.parent)
        staged = Path(staged_name)
        try:
            with os.fdopen(descriptor, "w") as output:
                json.dump(sorted(names), output)
            os.replace(staged, state)
        finally:
            staged.unlink(missing_ok=True)

    def valid(name):
        value = PurePosixPath(name)
        if value.is_absolute() or ".." in value.parts or not value.parts or str(value) != name:
            raise ValueError(f"Unsafe source path: {name}")
        if value.parts[0] in (".git", "target", "node_modules", "dist"):
            raise ValueError(f"Protected source path: {name}")
        return root / name

    def ensure_parents(destination):
        for parent in destination.parents:
            if parent == root:
                break
            if parent.is_symlink():
                raise ValueError(f"Source follows an existing directory symlink: {destination}")

    def unchanged(member, destination, archive):
        if destination.is_symlink():
            return member.issym() and os.readlink(destination) == member.linkname
        if not member.isfile() or not destination.is_file():
            return False
        metadata = destination.stat()
        if metadata.st_size != member.size or metadata.st_mode & 0o777 != member.mode & 0o777:
            return False
        with destination.open("rb") as existing, archive.extractfile(member) as incoming:
            while True:
                block = incoming.read(65536)
                if existing.read(65536) != block:
                    return False
                if not block:
                    return True

    for name in current | previous | tracked:
        valid(name)
    with tarfile.open(archive, "r:gz") as source:
        members = source.getmembers()
        names = {member.name for member in members}
        if names != current or len(names) != len(members):
            raise ValueError("Archive does not contain exactly the source manifest")
        links = {member.name for member in members if member.issym()}
        for member in members:
            valid(member.name)
            if not (member.isfile() or member.issym()):
                raise ValueError(f"Unsupported source entry: {member.name}")
            if any(str(parent) in links for parent in PurePosixPath(member.name).parents):
                raise ValueError(f"Source follows an archived symlink: {member.name}")
        removed = (previous | tracked) - current
        for name in removed:
            ensure_parents(valid(name))
        # Retain ownership of partial new source if extraction is interrupted.
        # A later snapshot can then remove it instead of compiling stale files.
        save_manifest(previous | current)
        for name in removed:
            destination = valid(name)
            if destination.is_symlink() or destination.is_file():
                destination.unlink()
        for member in members:
            destination = valid(member.name)
            ensure_parents(destination)
            if unchanged(member, destination, source):
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.is_dir() and not destination.is_symlink():
                # Only the exact requested file path; rmdir refuses unknown contents.
                if not any(name.startswith(member.name + "/") for name in previous | tracked):
                    raise ValueError(f"Refusing an unmanaged directory at source path: {member.name}")
                destination.rmdir()
            staged = None
            try:
                if member.issym():
                    candidate = destination.parent / (".futo-source-link-" + uuid.uuid4().hex)
                    os.symlink(member.linkname, candidate)
                    staged = candidate
                else:
                    handle, name = tempfile.mkstemp(prefix=".futo-source-", dir=destination.parent)
                    staged = Path(name)
                    with os.fdopen(handle, "wb") as output:
                        with source.extractfile(member) as input_file:
                            shutil.copyfileobj(input_file, output)
                    staged.chmod(member.mode & 0o777)
                os.replace(staged, destination)
            finally:
                if staged is not None:
                    staged.unlink(missing_ok=True)
    save_manifest(current)


if __name__ == "__main__":
    try:
        apply(*sys.argv[1:])
    except (OSError, ValueError, tarfile.TarError, subprocess.SubprocessError) as error:
        print(error, file=sys.stderr)
        sys.exit(1)
