#!/usr/bin/env python3
"""Hold one native iOS test session per worktree until its real processes exit.

The OS lock survives a stale metadata record and is inherited by the command.
Status probes the lock itself; clearing an old record never unlinks its inode.
Only the process group this runner started receives interruption signals.
"""
import fcntl
import json
import os
from pathlib import Path
import re
import selectors
import signal
import subprocess
import sys
import time

USAGE = "ios-test-session.py -- <command> [args...] | --status | --clear-stale | --help"


def main(args):
    option = args[0] if len(args) == 1 else None
    if option == "--help":
        print(USAGE)
        return 0
    if option not in ("--status", "--clear-stale") and not (len(args) > 1 and args[0] == "--"):
        print(USAGE, file=sys.stderr)
        return 2
    diagnostics = os.environ.get("FUTO_IOS_TEST_DIAGNOSTICS") or "never"
    if diagnostics not in ("never", "on-failure"):
        print("FUTO_IOS_TEST_DIAGNOSTICS must be never or on-failure", file=sys.stderr)
        return 2
    git_path = subprocess.check_output(
        ["git", "rev-parse", "--git-path", "futo-ios-test-session.json"], text=True
    ).strip()
    root = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip()
    # Persist the inode: unlinking a locked file lets a second process lock a
    # replacement while the original holder is still running.
    inherited = os.environ.get("FUTO_IOS_TEST_LOCK_FD") if option is None else None
    if inherited is not None:
        try:
            inherited_fd = int(inherited)
            existing = os.fstat(inherited_fd)
            expected = Path(git_path).stat()
            if (existing.st_dev, existing.st_ino) != (expected.st_dev, expected.st_ino):
                raise ValueError("descriptor points at another file")
            record_file = os.fdopen(os.dup(inherited_fd), "a+")
        except (OSError, ValueError) as error:
            print(f"Invalid inherited iOS test lock: {error}", file=sys.stderr)
            return 2
    else:
        record_file = Path(git_path).open("a+")
    with record_file as record:
        try:
            fcntl.flock(record.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            record.seek(0)
            try:
                owner = json.load(record)
                detail = (
                    f"runner PID {owner['pid']}, child PID {owner.get('child_pid', 'starting')}, "
                    f"{owner['phase']}, started {owner['started']}"
                )
            except (ValueError, KeyError):
                detail = "owner metadata pending"
            if option == "--status":
                print(f"iOS tests: active — {detail}")
                return 0
            print(
                f"iOS tests already running — {detail}; lock retained until the real process exits",
                file=sys.stderr,
            )
            return 75

        if option:
            print("iOS tests: no active session in this worktree")
            if option == "--clear-stale":
                record.seek(0)
                record.truncate()
            return 0

        owner = {
            "pid": os.getpid(),
            "phase": "building/running tests",
            "started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }

        def save_owner():
            record.seek(0)
            record.truncate()
            json.dump(owner, record)
            record.flush()

        if inherited is None:
            save_owner()
        print(
            f"iOS tests: verbose simulator diagnostics = {diagnostics} (FUTO_IOS_TEST_DIAGNOSTICS)",
            file=sys.stderr, flush=True,
        )
        print(
            f"iOS test session {os.getpid()}: lock retained until the command and its children exit",
            file=sys.stderr, flush=True,
        )
        try:
            child = subprocess.Popen(
                args[1:], cwd=root, start_new_session=True,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                pass_fds=(record.fileno(),),
                env={**os.environ, "FUTO_IOS_TEST_LOCK_FD": str(record.fileno())},
            )
        except OSError as error:
            print(f"Could not start iOS test command: {error}", file=sys.stderr)
            return 127

        owner["child_pid"] = child.pid
        if inherited is None:
            save_owner()
        stop_deadline = None

        def forward(sig):
            try:
                os.killpg(child.pid, sig)
            except ProcessLookupError:
                pass

        def stop(sig, _frame):
            nonlocal stop_deadline
            forward(sig)
            if stop_deadline is None:
                stop_deadline = time.monotonic() + 10

        def force_stop_if_needed():
            if stop_deadline is not None and time.monotonic() >= stop_deadline:
                forward(signal.SIGKILL)

        old_handlers = {sig: signal.signal(sig, stop) for sig in (signal.SIGINT, signal.SIGTERM)}
        recent = ""
        try:
            with selectors.DefaultSelector() as streams:
                streams.register(child.stdout, selectors.EVENT_READ, sys.stdout.buffer)
                streams.register(child.stderr, selectors.EVENT_READ, sys.stderr.buffer)
                while streams.get_map():
                    force_stop_if_needed()
                    for key, _ in streams.select(timeout=0.1):
                        chunk = os.read(key.fileobj.fileno(), 65536)
                        if not chunk:
                            streams.unregister(key.fileobj)
                            key.fileobj.close()
                            continue
                        key.data.write(chunk)
                        key.data.flush()
                        recent = (recent + chunk.decode("utf-8", errors="replace"))[-1024:]
                        collecting = re.search(r"collecting[^\n]*diagnos|simctl diagnose", recent, re.I)
                        if owner["phase"] != "collecting diagnostics" and collecting:
                            owner["phase"] = "collecting diagnostics"
                            if inherited is None:
                                save_owner()
                            print(
                                "iOS tests: collecting diagnostics; lock retained until xcodebuild exits",
                                file=sys.stderr, flush=True,
                            )
            while child.poll() is None:
                force_stop_if_needed()
                time.sleep(0.1)
            # A signaled shell may exit before its xcodebuild descendants finish.
            while True:
                try:
                    os.killpg(child.pid, 0)
                except ProcessLookupError:
                    break
                force_stop_if_needed()
                time.sleep(0.1)
            return child.returncode if child.returncode >= 0 else 128 - child.returncode
        finally:
            for sig, old in old_handlers.items():
                signal.signal(sig, old)
            if inherited is None:
                record.seek(0)
                record.truncate()


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except (OSError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
