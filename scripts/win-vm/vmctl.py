#!/usr/bin/env python3
"""Minimal QMP driver for the FUTO Notes Win11 test VM (see README.md).

Talks to the qemu QMP unix socket to: take screenshots (PNG), send keyboard
input, and move/click/drag an absolute USB-tablet pointer (so HTML5 drag-drop
inside the WebView2 app can be exercised).

Usage:
  vmctl.py shot OUT.png                 # screendump -> PNG, prints "WxH OUT.png"
  vmctl.py key  KEY[ KEY...]            # qcode chord, e.g. `key ret`, `key meta_l r`, `key alt tab`
  vmctl.py type "some text"             # type an ASCII string
  vmctl.py move X Y                     # move pointer to pixel X,Y
  vmctl.py click X Y [left|right]       # move + click
  vmctl.py dclick X Y                   # double click
  vmctl.py drag X1 Y1 X2 Y2             # press at X1,Y1, glide to X2,Y2, release (HTML5-DnD friendly)

Pixel coords auto-map to the absolute 0..32767 range using the CURRENT screen
resolution (read from a fresh screendump each call).
Env: WIN_VM_DIR (default ~/Developer/win-vm) locates the data dir; QMP_SOCK
overrides the socket path directly.

QEMU qcode notes: left modifiers are `shift`, `ctrl`, `alt` (NOT `shift_l`/
`alt_l`); the Windows key is `meta_l`. Right variants are `*_r`.
"""
import json, os, socket, struct, sys, tempfile, time

WIN_VM_DIR = os.environ.get("WIN_VM_DIR", os.path.expanduser("~/Developer/win-vm"))
SOCK = os.environ.get("QMP_SOCK", os.path.join(WIN_VM_DIR, "run/qmp.sock"))

class Mon:
    def __init__(self, path):
        self.s = socket.socket(socket.AF_UNIX)
        self.s.connect(path)
        self.f = self.s.makefile("rwb", buffering=0)
        self._recv()                       # QMP greeting
        self._cmd("qmp_capabilities")

    def _recv(self):
        while True:
            line = self.f.readline()
            if not line:
                raise IOError("QMP connection closed")
            obj = json.loads(line.decode())
            if "event" in obj:             # ignore async events
                continue
            return obj

    def _cmd(self, execute, **args):
        msg = {"execute": execute}
        if args:
            msg["arguments"] = args
        self.f.write((json.dumps(msg) + "\n").encode())
        r = self._recv()
        if "error" in r:
            raise RuntimeError(f"{execute}: {r['error']}")
        return r.get("return", {})

    # ---- screen ----
    def screendump(self, path):
        try:
            self._cmd("screendump", filename=path, format="png")
        except RuntimeError:
            # older qemu: PPM only
            self._cmd("screendump", filename=path)
        return path

    # ---- input ----
    def send(self, events):
        self._cmd("input-send-event", events=events)

    def _abs(self, axis, px, total):
        v = max(0, min(32767, round(px / max(1, total) * 32767)))
        return {"type": "abs", "data": {"axis": axis, "value": v}}

    def move(self, x, y, W, H):
        self.send([self._abs("x", x, W), self._abs("y", y, H)])

    def btn(self, down, button="left"):
        self.send([{"type": "btn", "data": {"button": button, "down": down}}])

    def click(self, x, y, W, H, button="left"):
        self.move(x, y, W, H); time.sleep(0.05)
        self.btn(True, button); time.sleep(0.06)
        self.btn(False, button)

    def dclick(self, x, y, W, H):
        self.click(x, y, W, H); time.sleep(0.08); self.click(x, y, W, H)

    def drag(self, x1, y1, x2, y2, W, H, steps=25):
        # HTML5 DnD needs a real press, an initial small jiggle to start the
        # drag, then incremental moves into the target before release.
        self.move(x1, y1, W, H); time.sleep(0.1)
        self.btn(True); time.sleep(0.12)
        self.move(x1 + 6, y1 + 6, W, H); time.sleep(0.08)   # nudge to initiate drag
        for i in range(1, steps + 1):
            x = round(x1 + (x2 - x1) * i / steps)
            y = round(y1 + (y2 - y1) * i / steps)
            self.move(x, y, W, H); time.sleep(0.03)
        self.move(x2, y2, W, H); time.sleep(0.2)            # settle over target
        self.btn(False); time.sleep(0.1)

    def key(self, keys):
        evs = [{"type": "key", "data": {"down": True,  "key": {"type": "qcode", "data": k}}} for k in keys]
        evs += [{"type": "key", "data": {"down": False, "key": {"type": "qcode", "data": k}}} for k in reversed(keys)]
        self.send(evs)


# ASCII -> (qcode, needs_shift)
_BASE = {
    **{c: (c, False) for c in "abcdefghijklmnopqrstuvwxyz"},
    **{c.upper(): (c, True) for c in "abcdefghijklmnopqrstuvwxyz"},
    **{d: (d, False) for d in "0123456789"},
    " ": ("spc", False), "\n": ("ret", False), "\t": ("tab", False),
    "-": ("minus", False), "_": ("minus", True), "=": ("equal", False), "+": ("equal", True),
    ".": ("dot", False), ",": ("comma", False), "/": ("slash", False), "?": ("slash", True),
    ";": ("semicolon", False), ":": ("semicolon", True), "'": ("apostrophe", False), '"': ("apostrophe", True),
    "\\": ("backslash", False), "|": ("backslash", True), "`": ("grave_accent", False), "~": ("grave_accent", True),
    "[": ("bracket_left", False), "{": ("bracket_left", True), "]": ("bracket_right", False), "}": ("bracket_right", True),
    "!": ("1", True), "@": ("2", True), "#": ("3", True), "$": ("4", True), "%": ("5", True),
    "^": ("6", True), "&": ("7", True), "*": ("8", True), "(": ("9", True), ")": ("0", True),
}

def png_dims(path):
    with open(path, "rb") as fh:
        head = fh.read(26)
    w, h = struct.unpack(">II", head[16:24])
    return w, h

def cur_dims(mon):
    tmp = tempfile.mktemp(suffix=".png")
    mon.screendump(tmp)
    try:
        return png_dims(tmp)
    finally:
        try: os.remove(tmp)
        except OSError: pass

def main():
    a = sys.argv[1:]
    if not a:
        print(__doc__); return 2
    mon = Mon(SOCK)
    cmd = a[0]
    if cmd == "shot":
        out = a[1]
        mon.screendump(out)
        w, h = png_dims(out)
        print(f"{w}x{h} {out}")
    elif cmd == "key":
        mon.key(a[1:])
    elif cmd == "type":
        for ch in a[1]:
            ent = _BASE.get(ch)
            if not ent:
                continue
            q, shift = ent
            # QEMU left-shift qcode is `shift` (NOT `shift_l`).
            mon.key((["shift", q]) if shift else ([q]))
            time.sleep(0.02)
    elif cmd in ("move", "click", "dclick", "drag"):
        W, H = cur_dims(mon)
        if cmd == "move":
            mon.move(int(a[1]), int(a[2]), W, H)
        elif cmd == "click":
            mon.click(int(a[1]), int(a[2]), W, H, a[3] if len(a) > 3 else "left")
        elif cmd == "dclick":
            mon.dclick(int(a[1]), int(a[2]), W, H)
        elif cmd == "drag":
            mon.drag(int(a[1]), int(a[2]), int(a[3]), int(a[4]), W, H)
    else:
        print(f"unknown command: {cmd}"); return 2
    return 0

if __name__ == "__main__":
    sys.exit(main())
