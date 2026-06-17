#!/usr/bin/env python3
"""Record a drag-drop as PNG frames over ONE QMP connection (no contention),
then assemble with ffmpeg. Captures the before state, the drag (a frame per
mouse step), and the after state (toast + result) into $WIN_VM_DIR/run/frames/.

Usage:
  record_drag.py X1 Y1 X2 Y2        # drag from (X1,Y1) to (X2,Y2), pixel coords
Then:
  ffmpeg -y -framerate 10 -pattern_type glob -i "$WIN_VM_DIR/run/frames/*.png" \\
    -vf "scale=1280:-2,format=yuv420p" "$WIN_VM_DIR/run/verify-drag.mp4"

Env: WIN_VM_DIR (default ~/Developer/win-vm); QMP_SOCK overrides the socket.
"""
import os, sys, time
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from vmctl import Mon, png_dims  # noqa: E402

WIN_VM_DIR = os.environ.get("WIN_VM_DIR", os.path.expanduser("~/Developer/win-vm"))
SOCK = os.environ.get("QMP_SOCK", os.path.join(WIN_VM_DIR, "run/qmp.sock"))
OUT = os.path.join(WIN_VM_DIR, "run/frames")

def main():
    if len(sys.argv) != 5:
        print(__doc__); return 2
    SRC = (int(sys.argv[1]), int(sys.argv[2]))
    DST = (int(sys.argv[3]), int(sys.argv[4]))

    os.makedirs(OUT, exist_ok=True)
    for f in os.listdir(OUT):
        if f.endswith(".png"):
            os.remove(os.path.join(OUT, f))

    mon = Mon(SOCK)
    probe = os.path.join(OUT, "_probe.png")
    mon.screendump(probe); W, H = png_dims(probe); os.remove(probe)

    idx = [0]
    def frame():
        mon.screendump(os.path.join(OUT, f"{idx[0]:05d}.png")); idx[0] += 1
    def ax(px): return max(0, min(32767, round(px / W * 32767)))
    def ay(px): return max(0, min(32767, round(px / H * 32767)))
    def move(x, y): mon.send([{"type": "abs", "data": {"axis": "x", "value": ax(x)}},
                              {"type": "abs", "data": {"axis": "y", "value": ay(y)}}])
    def btn(d): mon.send([{"type": "btn", "data": {"button": "left", "down": d}}])

    for _ in range(8):                         # before
        frame(); time.sleep(0.10)
    move(*SRC); frame(); time.sleep(0.15)      # press
    btn(True); frame(); time.sleep(0.15)
    move(SRC[0] + 6, SRC[1] + 6); frame(); time.sleep(0.10)  # nudge to start HTML5 DnD
    STEPS = 20                                 # glide
    for i in range(1, STEPS + 1):
        x = round(SRC[0] + (DST[0] - SRC[0]) * i / STEPS)
        y = round(SRC[1] + (DST[1] - SRC[1]) * i / STEPS)
        move(x, y); frame(); time.sleep(0.05)
    move(*DST); frame(); time.sleep(0.2); frame()
    btn(False); frame(); time.sleep(0.1)       # release
    for _ in range(28):                        # after (toast lingers ~2-3s)
        frame(); time.sleep(0.12)

    print(f"{idx[0]} frames captured at {W}x{H} -> {OUT}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
