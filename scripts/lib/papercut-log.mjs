// Read the append-only, union-merged papercut log for orientation and sweeps.
// Project valid cut/resolve records; the papercuts CLI owns schema validation.
// First cut wins, matching the CLI; repeated resolves are idempotent.
export function parsePapercutLog(text) {
  const cuts = new Map();
  const resolved = new Set();
  for (const line of text.split('\n')) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.kind === 'cut' && !cuts.has(event.id)) cuts.set(event.id, event);
    else if (event?.kind === 'resolve') resolved.add(event.id);
  }
  return { open: [...cuts.values()].filter((cut) => !resolved.has(cut.id)), total: cuts.size };
}
