// editor-bench.mjs's counters: CDP performance metrics, the timeline trace
// and its style/layout totals, and V8 call counts.

// ── Measurement ──────────────────────────────────────────────────────────

const METRIC_KEYS = [
  'RecalcStyleCount',
  'LayoutCount',
  'RecalcStyleDuration',
  'LayoutDuration',
  'ScriptDuration',
  'TaskDuration',
];

export async function metrics(cdp) {
  const { metrics: list } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(
    list.filter((m) => METRIC_KEYS.includes(m.name)).map((m) => [m.name, m.value]),
  );
}

// `--why` adds what invalidated each restyle and layout, with the JS stack
// that did it. It costs time, so the scored passes never record it.
const WHY_CATEGORIES = [
  'disabled-by-default-devtools.timeline.invalidationTracking',
  'disabled-by-default-devtools.timeline.stack',
];

export async function startTrace(cdp, why = false) {
  await cdp.send('Tracing.start', {
    traceConfig: {
      includedCategories: ['devtools.timeline', ...(why ? WHY_CATEGORIES : [])],
      recordMode: 'recordAsMuchAsPossible',
    },
    transferMode: 'ReturnAsStream',
  });
}

export async function stopTrace(cdp) {
  const done = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve));
  await cdp.send('Tracing.end');
  const { stream } = await done;
  let text = '';
  for (;;) {
    const chunk = await cdp.send('IO.read', { handle: stream });
    text += chunk.data;
    if (chunk.eof) break;
  }
  await cdp.send('IO.close', { handle: stream });
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : parsed.traceEvents;
}

// Sums the renderer's own accounting of the work: elements whose style was
// recomputed, and the objects in scope of each layout. A keystroke dirties a
// handful of objects (`dirtyObjects`), but when the layout root is the whole
// document the pass covers every object in it (`totalObjects`), and that scope
// is what grows with note length.
export function traceWork(events) {
  let styledElements = 0;
  let layoutScope = 0;
  for (const e of events) {
    if (e.name === 'UpdateLayoutTree' && e.args?.elementCount != null)
      styledElements += e.args.elementCount;
    if (e.name === 'Layout' && e.args?.beginData?.totalObjects != null)
      layoutScope += e.args.beginData.totalObjects;
  }
  return { styledElements, layoutScope };
}

// V8 precise coverage counts every function invocation exactly: the closest
// thing to an instruction count JavaScript offers, and as repeatable.
export async function startCalls(cdp) {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.startPreciseCoverage', {
    callCount: true,
    detailed: false,
    allowTriggeredUpdates: false,
  });
  await cdp.send('Profiler.takePreciseCoverage'); // resets the counters
}
export async function takeCalls(cdp) {
  const { result } = await cdp.send('Profiler.takePreciseCoverage');
  await cdp.send('Profiler.stopPreciseCoverage');
  let calls = 0;
  for (const script of result) for (const fn of script.functions) calls += fn.ranges[0].count;
  return calls;
}
