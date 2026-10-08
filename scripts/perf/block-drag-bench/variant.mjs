/* Source rewrites for `block-drag-bench.mjs` variants. Kept apart from the CLI
 * (which runs on import) so they can be tested. */

/** Source of `file` with the drop line forced. The reflow switch is a page flag,
 * read when a drag starts (blockDragCurtain.ts `reflowForcedOff`), so a file
 * that routes through `ReflowCurtain` gets the flag set ahead of it. A file from
 * before the curtain has the `LIVE_REFLOW` constant instead, which is flipped.
 * A file with neither would ignore the flag and run in whatever mode it has
 * while being labelled "line", so it is rejected. */
export function forceLineMode(code, file) {
  const legacy = /^const LIVE_REFLOW = true;$/m;
  if (legacy.test(code)) {
    const switched = code.replace(legacy, 'const LIVE_REFLOW = false;');
    if (!/^const LIVE_REFLOW = false;$/m.test(switched))
      throw new Error(`${file}: failed to switch \`const LIVE_REFLOW = true;\` off`);
    return switched;
  }
  if (/^const LIVE_REFLOW = false;$/m.test(code)) return code;
  if (/\bReflowCurtain\.measure\(/.test(code))
    return `window.__futoBlockDragReflow = 'off';\n${code}`;
  throw new Error(
    `${file}: has neither \`const LIVE_REFLOW\` nor the ReflowCurtain switch; ` +
      'a `:line` variant of it would not be in line mode',
  );
}

/** The mode a variant asks for, as the probes name it. */
export const expectedMode = (variant) => (variant.line ? 'line' : 'reflow');

/** Throws when any run saw a different mode than its variant asked for (an
 * ignored switch, or a drag that never reached either preview). */
export function assertModes(variant, runs) {
  const want = expectedMode(variant);
  const seen = [...new Set(runs.map((r) => r.mode))];
  if (seen.length !== 1 || seen[0] !== want)
    throw new Error(
      `variant "${variant.spec}" asked for the ${want} preview but the page showed: ${seen.join(', ') || 'no runs'}`,
    );
}
