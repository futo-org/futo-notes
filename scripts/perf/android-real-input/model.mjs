// Device stories and acceptance criteria for the native text-first editor.
// Durations include the normal scheduler and input boost; no pinned CPUs,
// fixed clocks, accessibility service, or direct InputConnection injection.
export const fixtures = {
  meeting:
    '# Meeting notes\n\n' +
    Array.from(
      { length: 24 },
      (_, i) =>
        `## Topic ${i + 1}\n\nWe discussed the plan for next week and agreed to review the results on Friday. The next step is to test the changes and share feedback.\n\n`,
    ).join(''),
  checklist:
    '# Weekend errands\n\n' +
    Array.from(
      { length: 80 },
      (_, i) => `- [ ] Task ${i + 1}: pick up groceries and check the schedule\n`,
    ).join(''),
  paragraph:
    '# Reading notes\n\n' +
    'This is a reading note with a long paragraph. We are keeping thoughts together while working through a chapter and adding details as we read. '.repeat(
      55,
    ) +
    '\n',
};

// Measured Moto layout, deliberately explicit rather than silently tapping
// an unknown IME. The runner verifies the device, IME and display first.
const keys = Object.fromEntries([
  ...[...'qwertyuiop'].map((c, i) => [c, [38 + i * 71, 1137]]),
  ...[...'asdfghjkl'].map((c, i) => [c, [74 + i * 71, 1243]]),
  ...[...'zxcvbnm'].map((c, i) => [c, [145 + i * 71, 1348]]),
  [' ', [393, 1454]],
  ['\n', [665, 1454]],
  ['~', [665, 1348]],
]);

export function typingPlan(story) {
  // Keep the long paragraph intact: Enter would split it and make the
  // remaining keys a short-paragraph benchmark.
  let text =
    story === 'paragraph'
      ? 'the quick brown fox jumps over the lazy dog and then takes a break and starts typing some more words ' +
        '~'.repeat(25)
      : 'the quick brown fox jumps over the lazy dog and then takes a break \n\n~~~~~a short reply after thinking \nthe next line is easy to edit ' +
        '~'.repeat(10);
  // Finish with ordinary letters so even a no-op Backspace series has a final drawn update.
  const padding = (50 - (text.length % 50)) % 50;
  text += 'more words '.repeat(5).slice(0, padding);
  let time = 2000;
  let seed = 287;
  return [...text].map((character, i) => {
    if (i === 60) time += 1800;
    const event = { time, x: keys[character][0], y: keys[character][1], label: `key-${i}` };
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    time += 150 + (seed % 161);
    return event;
  });
}

export function encodePlan(events) {
  if (!events.length) throw new Error('An input story must contain events');
  return (
    events
      .map(({ time, x, y, label }) => {
        if (![time, x, y].every(Number.isSafeInteger) || !/^[a-z0-9-]+$/.test(label))
          throw new Error('Invalid input event');
        return `${time} ${x} ${y} ${label}`;
      })
      .join('\n') + '\n'
  );
}

export function latencyWindows(log) {
  return [
    ...log.matchAll(
      /input→draw over (\d+): p50=([\d.]+)ms p95=([\d.]+)ms max=([\d.]+)ms(?: workP95=([\d.]+)ms resumeMax=([\d.]+)ms)?(?: firstInputNs=(\d+) lastInputNs=(\d+))?/g,
    ),
  ].map((m) => ({
    count: +m[1],
    p50: +m[2],
    p95: +m[3],
    max: +m[4],
    workP95: m[5] === undefined ? null : +m[5],
    resumeMax: m[6] === undefined ? null : +m[6],
    firstInputNs: m[7] === undefined ? null : +m[7],
    lastInputNs: m[8] === undefined ? null : +m[8],
  }));
}

export function navigationTrials(frames, events) {
  return events.map((event) => {
    const active = frames.filter((f) => f.ts >= event.downNs && f.ts < event.downNs + 1.5e9);
    const drawn = active.filter((f) => Number.isFinite(f.presentNs));
    if (!drawn.length) throw new Error(`No presented app frames for ${event.label}`);
    return {
      action: event.label,
      frames: drawn.length,
      settledMs: (Math.max(...drawn.map((f) => f.presentNs)) - event.downNs) / 1e6,
      missed: active.filter((f) => f.jank.includes('App Deadline Missed')).length,
      dropped: active.filter((f) => f.presentType === 'Dropped Frame').length,
    };
  });
}

export function failures(report) {
  const errors = [];
  if (report.typing)
    for (const story of report.typing) {
      if (
        story.events < 100 ||
        story.windows.length < 2 ||
        story.frames.length < 100 ||
        story.windows.reduce((n, w) => n + w.count, 0) < 100
      )
        errors.push(`${story.name}: incomplete typing evidence`);
      // A keyboard can accept a no-op (e.g. Backspace at an empty list), so
      // touches and drawn updates are not one-to-one. Require the final latency
      // window to reach the final touch instead of discarding a partial tail.
      if (story.inputEvents?.length) {
        const first = story.inputEvents[0];
        const last = story.inputEvents.at(-1);
        if (
          story.windows.some((w) => w.firstInputNs == null || w.lastInputNs == null) ||
          story.windows[0]?.firstInputNs < first.downNs ||
          story.windows[0]?.firstInputNs > first.upNs + 200e6 ||
          story.windows.at(-1)?.lastInputNs < last.downNs ||
          story.windows.at(-1)?.lastInputNs > last.upNs + 200e6
        )
          errors.push(`${story.name}: incomplete native latency coverage`);
      }
    }
  if (report.navigation) {
    if (report.navigation.length < 6) errors.push('Incomplete navigation evidence');
    for (const trial of report.navigation) {
      if (trial.frames < 8) errors.push(`${trial.action}: missing animated transition frames`);
    }
  }
  if (!report.typing?.length && !report.navigation?.length) errors.push('No measured stories');
  return [...new Set(errors)];
}

// Diagnostics, never a declaration that performance is acceptable. Timing
// thresholds need a separately agreed policy; collection failures stay fatal.
export function frameSummary(frames) {
  return {
    frames: frames.length,
    appDeadlineMisses: frames.filter((f) => f.jank.includes('App Deadline Missed')).length,
    droppedFrames: frames.filter((f) => f.presentType === 'Dropped Frame').length,
  };
}
