import type { NotePreview } from '../types';
import type { EngagementRecord } from './engagement';

const DAY_MS = 86_400_000;

function decay(timestamp: number, halfLifeDays: number): number {
  if (timestamp <= 0) return 0;
  const daysSince = (Date.now() - timestamp) / DAY_MS;
  return Math.exp(-daysSince / halfLifeDays);
}

function normalize(value: number, max: number): number {
  if (max <= 0) return 0;
  return value / max;
}

export function getForYouNotes(
  notes: NotePreview[],
  engagement: Record<string, EngagementRecord>,
  limit: number = 3,
): NotePreview[] {
  if (notes.length === 0) return [];

  const records = Object.values(engagement);
  const maxOpenCount = records.reduce((m, r) => Math.max(m, r.openCount), 0);
  const maxEditCount = records.reduce((m, r) => Math.max(m, r.editCount), 0);

  const scored = notes.map(note => {
    const record = engagement[note.id];

    // Cold start: use modificationTime as synthetic lastEditedAt
    const lastOpenedAt = record?.lastOpenedAt ?? 0;
    const lastEditedAt = record?.lastEditedAt ?? note.modificationTime;
    const openCount = record?.openCount ?? 0;
    const editCount = record?.editCount ?? 0;

    const score =
      0.35 * decay(lastOpenedAt, 7) +
      0.20 * decay(lastEditedAt, 14) +
      0.25 * normalize(openCount, maxOpenCount) +
      0.20 * normalize(editCount, maxEditCount);

    return { note, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(s => s.note);
}
