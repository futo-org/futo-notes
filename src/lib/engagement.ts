import { getFS, hasFileSystem } from './platform';

const ENGAGEMENT_PATH = '.engagement-v1.json';

export interface EngagementRecord {
  lastOpenedAt: number;
  openCount: number;
  lastEditedAt: number;
  editCount: number;
}

export interface EngagementData {
  version: 1;
  notes: Record<string, EngagementRecord>;
}

let cached: EngagementData | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
const PERSIST_DELAY_MS = 5000;

function defaultData(): EngagementData {
  return { version: 1, notes: {} };
}

export async function loadEngagement(): Promise<void> {
  if (!hasFileSystem) {
    cached = defaultData();
    return;
  }

  try {
    const content = await getFS().readAppData(ENGAGEMENT_PATH);
    if (content) {
      const parsed = JSON.parse(content);
      if (parsed && parsed.version === 1 && typeof parsed.notes === 'object') {
        cached = parsed as EngagementData;
      } else {
        cached = defaultData();
      }
    } else {
      cached = defaultData();
    }
  } catch {
    cached = defaultData();
  }
}

function ensureLoaded(): EngagementData {
  if (!cached) cached = defaultData();
  return cached;
}

function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void writeEngagement();
  }, PERSIST_DELAY_MS);
}

async function writeEngagement(): Promise<void> {
  if (!hasFileSystem || !cached) return;
  await getFS().writeAppData(ENGAGEMENT_PATH, JSON.stringify(cached, null, 2));
}

export function trackOpen(noteId: string): void {
  const data = ensureLoaded();
  const existing = data.notes[noteId];
  const now = Date.now();
  if (existing) {
    existing.lastOpenedAt = now;
    existing.openCount += 1;
  } else {
    data.notes[noteId] = {
      lastOpenedAt: now,
      openCount: 1,
      lastEditedAt: 0,
      editCount: 0,
    };
  }
  schedulePersist();
}

export function trackEdit(noteId: string): void {
  const data = ensureLoaded();
  const existing = data.notes[noteId];
  const now = Date.now();
  if (existing) {
    existing.lastEditedAt = now;
    existing.editCount += 1;
  } else {
    data.notes[noteId] = {
      lastOpenedAt: 0,
      openCount: 0,
      lastEditedAt: now,
      editCount: 1,
    };
  }
  schedulePersist();
}

export function removeEngagement(noteId: string): void {
  const data = ensureLoaded();
  delete data.notes[noteId];
  schedulePersist();
}

export function renameEngagement(oldId: string, newId: string): void {
  const data = ensureLoaded();
  const record = data.notes[oldId];
  if (record) {
    data.notes[newId] = record;
    delete data.notes[oldId];
    schedulePersist();
  }
}

export async function flushEngagement(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  await writeEngagement();
}

export function getEngagementData(): Record<string, EngagementRecord> {
  return ensureLoaded().notes;
}
