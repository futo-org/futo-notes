/* `block-drag-bench.mjs`'s results table: per-size, per-bench medians
 * (min–max) and p95s across variants. */

/** Frames timed by `--target app`. */
export const APP_FRAMES = 60;

const percentile95 = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
};

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export function report(results, opts) {
  const benches =
    opts.target === 'app'
      ? ['scroll frame', '  of which JS', '  of which style+layout']
      : opts.device === 'android-app' || opts.device === 'ios-app'
        ? [
            'lift frame',
            'gap frame',
            'gap frame p95',
            'scroll frame',
            'scroll frame p95',
            'drop frame',
          ]
        : [
            'lift+cancel',
            'lift frame',
            'first move',
            'gap change',
            'drop',
            'gap frame',
            'gap frame p95',
            'scroll frame',
            'scroll frame p95',
          ];
  const labelWidth = 26;
  const colWidth = Math.max(...results.map((r) => r.variant.label.length), 24) + 2;
  const pad = (s, w) => String(s).padStart(w);
  const engine = {
    desktop: 'WebKitGTK',
    android: 'Android Chrome (phone)',
    'android-app': 'REAL Android app (phone), long-press gesture',
    'ios-app': 'REAL iOS app (iPhone), XCUITest long-press gesture',
  }[opts.device];
  console.log(
    `\n${engine}, ${opts.target === 'app' ? `whole app${opts.hide ? ` minus ${opts.hide}` : ''}, ${opts.movesPerFrame} pointer move${opts.movesPerFrame === 1 ? '' : 's'} per frame` : `${opts.layout} layout`}, cursor layer ${opts.cursorLayer ? 'on' : 'off'}, ${opts.repeat} runs each; ms per operation, median (min–max)\n`,
  );
  console.log(''.padEnd(labelWidth) + results.map((r) => pad(r.variant.label, colWidth)).join(''));
  for (const size of opts.sizes) {
    const modes = results.map((r) => {
      const runs = r.runs.filter((x) => x.blocks === size);
      const mode = [...new Set(runs.map((x) => x.mode))].join('/');
      return (
        `${mode}, scrolls ${runs[0].scroller}` + (runs.some((x) => x.leftover) ? ' LEFTOVER' : '')
      );
    });
    console.log(`${size} blocks`.padEnd(labelWidth) + modes.map((m) => pad(m, colWidth)).join(''));
    for (const bench of benches) {
      const p95 = bench.endsWith(' p95');
      const key = p95 ? bench.slice(0, -4) : bench;
      const sample = results[0].runs.find((x) => x.blocks === size)?.result[key];
      const count = opts.target === 'app' ? APP_FRAMES : sample?.reps;
      const cells = results.map((r) => {
        const perOp = r.runs
          .filter((x) => x.blocks === size && x.result[key])
          .map((x) =>
            p95
              ? percentile95(x.result[key].samplesMs)
              : x.result[key].totalMs / (opts.target === 'app' ? APP_FRAMES : x.result[key].reps),
          );
        if (perOp.length === 0) return '—';
        const lo = Math.min(...perOp).toFixed(0);
        const hi = Math.max(...perOp).toFixed(0);
        return `${median(perOp).toFixed(1)} (${lo}–${hi})`;
      });
      console.log(
        `  ${bench}${p95 ? '' : ` ×${count}`}`.padEnd(labelWidth) +
          cells.map((c) => pad(c, colWidth)).join(''),
      );
    }
  }
  console.log('');
}
