/** A benchmark may only report paint when its compositor delivers frames.
 * Covered/locked WebKitGTK windows can stop forever while their JS timers keep
 * running. Bound each wait, including startup, and report the environment. */
export function nextBenchFrame(): Promise<number> {
  return new Promise((resolve, reject) => {
    const frame = requestAnimationFrame((time) => {
      clearTimeout(timeout);
      resolve(time);
    });
    const timeout = setTimeout(() => {
      cancelAnimationFrame(frame);
      reject(
        new Error(
          'bench: no animation frame in 1200ms; the desktop session may be locked or the ' +
            'window occluded. Use a visible, owned compositor and verify frames before measuring ' +
            '(see .claude/skills/verify/references/desktop.md).',
        ),
      );
    }, 1200);
  });
}
