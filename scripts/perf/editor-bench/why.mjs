// `editor-bench.mjs --why`: turns one instrumented scenario's trace into the
// list of big restyles and layouts, each with what invalidated it.

// ── --why: what caused each big restyle and layout ───────────────────────

// Restyles of at least this many elements, and layouts over at least this many
// objects, get their causes printed. Below it a frame is ordinary.
const WHY_MIN_ELEMENTS = 100;
const WHY_MIN_LAYOUT = 1000;

export function whyReport(events) {
  const ev = events.filter((e) => e.ts > 0).sort((a, b) => a.ts - b.ts);
  const mark = ev.find(
    (e) => e.name === 'TimeStamp' && e.args?.data?.message === 'editor-bench:run',
  );
  const t0 = mark ? mark.ts : ev[0].ts;
  const ms = (e) => `${Math.round((e.ts - t0) / 1000)}ms`.padStart(7);
  const stack = (d) =>
    (d.stackTrace ?? [])
      .map((f) => f.functionName)
      .filter(Boolean)
      .slice(0, 5)
      .join(' < ') || '(no JS on the stack: a timer, rAF or browser task)';
  const what = (d) =>
    [
      d.changedClass && `class "${d.changedClass}"`,
      d.changedAttribute && `attribute "${d.changedAttribute}"`,
      d.changedPseudo && `pseudo ${d.changedPseudo}`,
      d.changedId && `id "${d.changedId}"`,
      d.reason,
    ]
      .filter(Boolean)
      .join(', ');
  const node = (d) => (d.nodeName ?? '?').slice(0, 70);

  const input = ev.filter(
    (e) =>
      e.name === 'EventDispatch' &&
      /^(keydown|pointerdown|pointerup|touchstart|touchend)$/.test(e.args?.data?.type ?? '') &&
      e.ts >= t0,
  );
  console.log(
    `\ninput: ${input.map((e) => `${ms(e).trim()} ${e.args.data.type}`).join(', ') || 'none'}`,
  );

  // Group identical frames (same size, same causes) so ten keystrokes print once.
  const groups = new Map();
  let sinceStyle = t0;
  let sinceLayout = t0;
  for (const e of ev) {
    if (e.ts < t0) continue;
    const isStyle =
      e.name === 'UpdateLayoutTree' && (e.args?.elementCount ?? 0) >= WHY_MIN_ELEMENTS;
    const isLayout =
      e.name === 'Layout' && (e.args?.beginData?.totalObjects ?? 0) >= WHY_MIN_LAYOUT;
    if (e.name === 'UpdateLayoutTree' && !isStyle) sinceStyle = e.ts;
    if (e.name === 'Layout' && !isLayout) sinceLayout = e.ts;
    if (!isStyle && !isLayout) continue;
    const from = isStyle ? sinceStyle : sinceLayout;
    const pattern = isStyle
      ? /^(ScheduleStyle|StyleRecalc)InvalidationTracking$/
      : /^LayoutInvalidationTracking$/;
    const causes = new Map();
    for (const c of ev) {
      if (c.ts <= from || c.ts > e.ts || !pattern.test(c.name)) continue;
      const d = c.args.data;
      const key = `${what(d)} on ${node(d)}\n        ← ${stack(d)}`;
      causes.set(key, (causes.get(key) ?? 0) + 1);
    }
    const size = isStyle
      ? `restyle of ${e.args.elementCount} elements`
      : `layout over ${e.args.beginData.totalObjects} objects (${e.args.beginData.dirtyObjects} dirty)`;
    const causeLines = [...causes.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([k, n]) => `      ${n > 1 ? `${n}× ` : ''}${k}`);
    if (causes.size > 6) causeLines.push(`      … and ${causes.size - 6} more distinct causes`);
    const sig = `${size}\n${causeLines.join('\n')}`;
    const g = groups.get(sig) ?? { at: [], size, causeLines };
    g.at.push(ms(e).trim());
    groups.set(sig, g);
    if (isStyle) sinceStyle = e.ts;
    else sinceLayout = e.ts;
  }
  if (groups.size === 0)
    console.log(`no restyle ≥ ${WHY_MIN_ELEMENTS} elements or layout ≥ ${WHY_MIN_LAYOUT} objects`);
  for (const g of groups.values()) {
    const when =
      g.at.length > 3 ? `${g.at.length}× (${g.at.slice(0, 3).join(', ')}, …)` : g.at.join(', ');
    console.log(`\n${when}: ${g.size}, caused by:`);
    console.log(g.causeLines.join('\n') || '      (no invalidation recorded)');
  }
}
