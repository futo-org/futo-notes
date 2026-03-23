import crypto from 'node:crypto';
import type { BuiltinPlugin, PluginRunContext, UserProfile } from '../types.js';
import { getBoolean, getNumber, parseLenientJson } from '../configHelpers.js';

const CHECKBOX_TASK_RE = /^- \[ ] (.+)$/gm;

interface DailyNoteState {
  lastGeneratedDate: string;
  contentHash: string;
  generatedAt: number;
}

// ── Utility functions ──────────────────────────────────────────────

function todayString(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function friendlyDate(): string {
  const now = new Date();
  const dow = now.toLocaleDateString('en-US', { weekday: 'long' });
  const month = now.toLocaleDateString('en-US', { month: 'long' });
  const day = now.getDate();
  const year = now.getFullYear();
  const o = day === 1 || day === 21 || day === 31 ? 'st'
    : day === 2 || day === 22 ? 'nd'
    : day === 3 || day === 23 ? 'rd' : 'th';
  return `${dow}, ${month} ${day}${o}, ${year}`;
}

function simpleHash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  return h.toString(36);
}

function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/**
 * Levenshtein edit distance between two strings.
 * Used for fuzzy matching wikilinks against known note titles.
 */
export function levenshtein(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;

  // Use two rows instead of full matrix for O(min(la,lb)) space
  let prev = Array.from({ length: lb + 1 }, (_, i) => i);
  let curr = new Array<number>(lb + 1);

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[lb];
}

/**
 * Find the closest matching title for a wikilink that doesn't exactly match.
 * Returns the corrected title or null if no good match is found.
 */
export function findClosestTitle(candidate: string, knownTitles: Set<string>): string | null {
  const candidateLower = candidate.toLowerCase();
  let bestMatch: string | null = null;
  let bestDist = Infinity;

  for (const title of knownTitles) {
    // Quick length-based skip: if lengths differ by more than the max allowed distance, skip
    if (Math.abs(title.length - candidate.length) > 3) continue;

    const dist = levenshtein(candidateLower, title.toLowerCase());
    if (dist > 0 && dist <= 3 && dist < bestDist) {
      // Similarity check: at least 60% of the longer string must match
      const maxLen = Math.max(candidate.length, title.length);
      const similarity = 1 - dist / maxLen;
      if (similarity >= 0.6) {
        bestDist = dist;
        bestMatch = title;
      }
    }
  }

  return bestMatch;
}

/**
 * Post-process wikilinks in generated content:
 * - Exact matches are kept as-is
 * - Close fuzzy matches are corrected to the real title
 * - No match at all → brackets are stripped, keeping the text
 */
function validateWikilinks(content: string, knownTitles: Set<string>): string {
  return content.replace(/\[\[([^\]]+)\]\]/g, (match, title) => {
    if (knownTitles.has(title)) return match;
    const corrected = findClosestTitle(title, knownTitles);
    if (corrected) return `[[${corrected}]]`;
    return title; // strip brackets for completely unknown links
  });
}

function stripTagHeader(content: string): string {
  return content.replace(/^(?:#\S+\s*)+\n+/, '');
}

function extractExcerpt(content: string, maxChars: number): string {
  return stripTagHeader(content).replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

// ── Weekly note parser ─────────────────────────────────────────────

interface WeeklyParsed {
  title: string;
  topPriorities: string[];       // Top-level bullet items (the week's focus)
  dailySections: Array<{ heading: string; bullets: string[] }>;
  openCheckboxes: string[];      // - [ ] items
  freeformSnippets: string[];    // Notable prose lines
}

function parseWeeklyNote(title: string, content: string): WeeklyParsed {
  const lines = content.split('\n');
  const topPriorities: string[] = [];
  const dailySections: Array<{ heading: string; bullets: string[] }> = [];
  const openCheckboxes: string[] = [];
  const freeformSnippets: string[] = [];
  let currentSection: { heading: string; bullets: string[] } | null = null;
  let inTopSection = true;

  for (const line of lines) {
    // Heading starts a new daily section
    const headingMatch = line.match(/^##\s+(.+)/);
    if (headingMatch) {
      inTopSection = false;
      if (currentSection) dailySections.push(currentSection);
      currentSection = { heading: headingMatch[1].trim(), bullets: [] };
      continue;
    }

    // Checkbox task
    const cbMatch = line.match(/^- \[ ] (.+)/);
    if (cbMatch) {
      openCheckboxes.push(cbMatch[1].trim());
      if (currentSection) currentSection.bullets.push(cbMatch[1].trim());
      continue;
    }

    // Top-level bullet before any heading = week priorities
    const bulletMatch = line.match(/^- (.+)/);
    if (bulletMatch && inTopSection) {
      topPriorities.push(bulletMatch[1].trim());
      continue;
    }

    // Bullet inside a daily section
    if (bulletMatch && currentSection) {
      currentSection.bullets.push(bulletMatch[1].trim());
      continue;
    }

    // Notable prose — skip stream-of-consciousness (contains "?", "idk", "eh", "hrm")
    const trimmed = line.trim();
    if (trimmed.length > 40 && !trimmed.startsWith('-') && !trimmed.startsWith('#') && !trimmed.startsWith('**')
      && !/\b(idk|eh\?|hrm|hm|dk|weird)\b/i.test(trimmed) && (trimmed.match(/\?/g) ?? []).length <= 1) {
      freeformSnippets.push(trimmed);
    }
  }

  if (currentSection) dailySections.push(currentSection);

  return { title, topPriorities, dailySections, openCheckboxes, freeformSnippets: freeformSnippets.slice(0, 3) };
}

// ── Quote extractor ────────────────────────────────────────────────

interface NoteQuote { text: string; source: string }

function extractQuotes(content: string, title: string): NoteQuote[] {
  const quotes: NoteQuote[] = [];
  // Blockquotes
  const bqRe = /^>\s*(.{20,200})$/gm;
  let m;
  while ((m = bqRe.exec(content)) !== null && quotes.length < 2) {
    const text = m[1].trim();
    if (!text.startsWith('—') && !text.startsWith('-')) quotes.push({ text, source: title });
  }
  return quotes;
}

// ── Goals/themes finder ────────────────────────────────────────────

async function findGoalsContext(sdk: PluginRunContext['sdk']): Promise<string | null> {
  // Look for yearly themes or goals notes
  const yearStr = new Date().getFullYear().toString();
  const candidates = await sdk.findNotes({
    filenameRegex: `(Themes for ${yearStr}|${yearStr}.*Theme|intentions.*year|goals)`,
    sort: 'modified_desc',
    limit: 3,
  });

  for (const note of candidates) {
    const content = await sdk.readNoteContent(note.uuid);
    if (!content || content.length < 30) continue;
    return `"${note.title}": ${extractExcerpt(content, 400)}`;
  }
  return null;
}

// ── Profile builder ────────────────────────────────────────────────

async function buildProfile(
  context: PluginRunContext,
  existingProfile: UserProfile | null,
): Promise<{ updated: boolean }> {
  const profiledHashes = await context.sdk.getPluginState<string[]>('profiled-hashes') ?? [];
  const profiledSet = new Set(profiledHashes);
  const recentNotes = await context.sdk.listRecentNotes(20, { excludeUntitled: true });
  const newNotes = recentNotes.filter((n) => !profiledSet.has(n.contentHash));

  if (newNotes.length === 0) return { updated: false };

  const notesToProfile = newNotes.slice(0, 5);
  const excerpts: string[] = [];
  for (const note of notesToProfile) {
    const content = await context.sdk.readNoteContent(note.uuid);
    if (!content) continue;
    excerpts.push(`### ${note.title}\n${extractExcerpt(content, 400)}`);
  }
  if (excerpts.length === 0) return { updated: false };

  let raw: string;
  try {
    raw = await context.sdk.runBuiltinLlm({
      purpose: 'daily-note-profile',
      systemPrompt: 'Extract structured facts from these note excerpts and merge with the existing profile. Return valid JSON only.',
      userPrompt: [
        'EXISTING PROFILE:', existingProfile ? JSON.stringify(existingProfile) : '{}', '',
        'NEW NOTE EXCERPTS:', ...excerpts, '',
        'Return JSON: {"domains":["..."],"activeProjects":["..."],"recurringThemes":["..."],"people":["..."],"writingStyle":"..."}',
        'Keep arrays concise (max 8 items). Merge new info with existing.',
      ].join('\n'),
      maxTokens: 800, temperature: 0.2, disableThinking: true,
      jsonSchema: {
        type: 'object', additionalProperties: false,
        properties: {
          domains: { type: 'array', items: { type: 'string' } },
          activeProjects: { type: 'array', items: { type: 'string' } },
          recurringThemes: { type: 'array', items: { type: 'string' } },
          people: { type: 'array', items: { type: 'string' } },
          writingStyle: { type: 'string' },
        },
        required: ['domains', 'activeProjects', 'recurringThemes', 'people', 'writingStyle'],
      },
      timeoutMs: 300_000,
    });
  } catch (err) {
    await context.sdk.log('warn', `Profile LLM failed: ${err instanceof Error ? err.message : String(err)}`);
    return { updated: false };
  }

  const parsed = parseLenientJson(raw) as Record<string, unknown> | null;
  if (!parsed) return { updated: false };

  const updatedProfile: UserProfile = {
    updatedAt: Date.now(),
    profiledNoteCount: (existingProfile?.profiledNoteCount ?? 0) + notesToProfile.length,
    domains: ((parsed.domains as string[]) ?? existingProfile?.domains ?? []).slice(0, 8),
    activeProjects: ((parsed.activeProjects as string[]) ?? existingProfile?.activeProjects ?? []).slice(0, 8),
    recurringThemes: ((parsed.recurringThemes as string[]) ?? existingProfile?.recurringThemes ?? []).slice(0, 8),
    people: ((parsed.people as string[]) ?? existingProfile?.people ?? []).slice(0, 8),
    writingStyle: (parsed.writingStyle as string) ?? existingProfile?.writingStyle ?? '',
    recentNoteTitles: recentNotes.slice(0, 20).map((n) => n.title),
  };
  await context.sdk.setUserProfile(updatedProfile);

  const nextHashes = [...profiledSet, ...notesToProfile.map((n) => n.contentHash)];
  await context.sdk.setPluginState('profiled-hashes', nextHashes.slice(-200));
  return { updated: true };
}

// ── Context gathering ──────────────────────────────────────────────

interface GatheredContext {
  today: string;
  friendlyDate: string;
  dayOfWeek: string;
  weekly: WeeklyParsed | null;
  recentNotes: Array<{ title: string; excerpt: string }>;
  openTasks: Array<{ task: string; source: string }>;
  quotes: NoteQuote[];
  goalsContext: string | null;
  knownTitles: Set<string>;
  noteAlreadyExists: boolean;
  existingNoteUuid: string | null;
}

async function gatherContext(context: PluginRunContext): Promise<GatheredContext> {
  const today = todayString();
  const lookbackDays = Math.max(1, getNumber(context.config, 'lookbackDays', 7));
  const maxRecentNotes = Math.max(3, getNumber(context.config, 'maxRecentNotes', 10));
  const includeOpenTasks = getBoolean(context.config, 'includeOpenTasks', true);
  const knownTitles = new Set<string>();

  // Check if daily note already exists
  const existingNotes = await context.sdk.findNotes({ filenameRegex: `^${today.replace(/-/g, '\\-')}\\.md$` });
  const noteAlreadyExists = existingNotes.length > 0;
  const existingNoteUuid = noteAlreadyExists ? existingNotes[0].uuid : null;

  // ── Weekly note (highest priority) ──
  // Find all weekly notes, then pick the one whose title date range is closest to today
  const weeklyNotes = await context.sdk.findNotes({
    filenameRegex: '^(This week |Week of ).*\\.md$',
    sort: 'modified_desc',
    limit: 5,
  });
  // Sort by title date proximity to today — prefer notes with the most recent date in their title
  weeklyNotes.sort((a, b) => {
    const extractDate = (title: string): number => {
      // Match (M-D-YYYY to M-D) or (M-D to M-D)
      const rangeMatch = title.match(/\((\d{1,2})-(\d{1,2})(?:-(\d{4}))?\s+to\s+(\d{1,2})-(\d{1,2})(?:-(\d{4}))?\)/);
      if (rangeMatch) {
        const year = rangeMatch[6] || rangeMatch[3] || String(new Date().getFullYear());
        return new Date(`${year}-${rangeMatch[4].padStart(2, '0')}-${rangeMatch[5].padStart(2, '0')}`).getTime();
      }
      return 0;
    };
    return extractDate(b.title) - extractDate(a.title);
  });
  let weekly: WeeklyParsed | null = null;
  if (weeklyNotes.length > 0) {
    const wContent = await context.sdk.readNoteContent(weeklyNotes[0].uuid);
    if (wContent) {
      weekly = parseWeeklyNote(weeklyNotes[0].title, wContent);
      knownTitles.add(weeklyNotes[0].title);
    }
  }

  // ── Recent notes ──
  const cutoff = Date.now() - (lookbackDays * 86_400_000);
  const modifiedNotes = await context.sdk.findNotes({ modifiedAfter: cutoff, sort: 'modified_desc', limit: maxRecentNotes * 3 });

  const recentNotes: Array<{ title: string; excerpt: string }> = [];
  const quotes: NoteQuote[] = [];

  for (const note of modifiedNotes) {
    knownTitles.add(note.title);
    if (note.filename === `${today}.md`) continue;
    // Skip the weekly note (we already parsed it in detail)
    if (weekly && note.title === weekly.title) continue;
    const content = await context.sdk.readNoteContent(note.uuid);
    if (!content) continue;

    if (recentNotes.length < maxRecentNotes) {
      // Skip notes with old dates in their titles (>60 days old) — they're stale context
      const dateInTitle = note.title.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/) ?? note.title.match(/\b(20\d{2})-(\d{2})-(\d{2})/);
      if (dateInTitle) {
        const noteDate = new Date(`${dateInTitle[1]}-${dateInTitle[2]}-${dateInTitle[3]}`);
        if (Date.now() - noteDate.getTime() > 60 * 86_400_000) continue;
      }
      recentNotes.push({ title: note.title, excerpt: extractExcerpt(content, 400) });
    }
    // Skip test/template notes for quotes
    if (quotes.length < 5 && !/test|template|example|GFM/i.test(note.title)) {
      quotes.push(...extractQuotes(content, note.title));
    }
  }

  // ── Open tasks: from weekly note + checkbox tasks from other notes ──
  const openTasks: Array<{ task: string; source: string }> = [];

  // Weekly note checkboxes first (highest priority)
  if (weekly) {
    for (const task of weekly.openCheckboxes) {
      openTasks.push({ task, source: weekly.title });
    }
  }

  // Checkbox tasks from other recent notes
  if (includeOpenTasks) {
    for (const note of modifiedNotes) {
      if (openTasks.length >= 12) break;
      if (weekly && note.title === weekly.title) continue;
      const content = await context.sdk.readNoteContent(note.uuid);
      if (!content) continue;
      const re = new RegExp(CHECKBOX_TASK_RE.source, 'gm');
      let match: RegExpExecArray | null;
      while ((match = re.exec(content)) !== null && openTasks.length < 12) {
        openTasks.push({ task: match[1], source: note.title });
      }
    }
  }

  // ── Goals / themes context ──
  const goalsContext = await findGoalsContext(context.sdk);

  // ── All titles for wikilink validation ──
  const allNotes = await context.sdk.findNotes({ limit: 500 });
  for (const note of allNotes) knownTitles.add(note.title);

  return {
    today, friendlyDate: friendlyDate(), dayOfWeek: new Date().toLocaleDateString('en-US', { weekday: 'long' }),
    weekly, recentNotes, openTasks, quotes: quotes.slice(0, 3), goalsContext,
    knownTitles, noteAlreadyExists, existingNoteUuid,
  };
}

// ── Web context (stub) ────────────────────────────────────────────

// TODO: Implement optional web search for highly relevant context.
// This should:
// 1. Extract technology/tool names from recent notes (e.g. "Tauri", "Svelte")
// 2. Search for notable releases or news (only if genuinely relevant)
// 3. Return a short string or null if nothing interesting
// 4. Be gated behind a config flag (disabled by default)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function fetchWebContext(_recentNotes: Array<{ title: string; excerpt: string }>): Promise<string | null> {
  return null;
}

// ── Build the LLM prompt ───────────────────────────────────────────

function buildWeeklyBlock(weekly: WeeklyParsed): string {
  const parts: string[] = [`WEEKLY PLANNING NOTE: "${weekly.title}"`];

  if (weekly.topPriorities.length > 0) {
    parts.push(`\nTHIS WEEK'S TOP PRIORITIES:\n${weekly.topPriorities.map(p => `• ${p}`).join('\n')}`);
  }

  for (const section of weekly.dailySections.slice(-3)) {
    parts.push(`\n${section.heading}:`);
    for (const bullet of section.bullets.slice(0, 8)) {
      parts.push(`  • ${bullet}`);
    }
  }

  if (weekly.freeformSnippets.length > 0) {
    parts.push(`\nNOTABLE THOUGHTS FROM THE WEEK:\n${weekly.freeformSnippets.map(s => `"${s}"`).join('\n')}`);
  }

  if (weekly.openCheckboxes.length > 0) {
    parts.push(`\nTASKS STILL OPEN (from weekly note):\n${weekly.openCheckboxes.map(t => `- [ ] ${t}`).join('\n')}`);
  }

  return parts.join('\n');
}

async function generateDailyNote(
  context: PluginRunContext,
  gathered: GatheredContext,
): Promise<string> {
  const dow = gathered.dayOfWeek.toLowerCase();
  const dayTag = dow === 'friday' ? 'End of the work week.'
    : dow === 'monday' ? 'Start of a new week.'
    : dow === 'saturday' || dow === 'sunday' ? 'Weekend.' : '';

  // ── Build context blocks ──

  const weeklyBlock = gathered.weekly ? buildWeeklyBlock(gathered.weekly) : '';

  const recentBlock = gathered.recentNotes.length > 0
    ? gathered.recentNotes.slice(0, 8).map(n => `"${n.title}": ${n.excerpt}`).join('\n\n')
    : '(No recent notes)';

  // Split tasks: weekly note tasks are primary, others are backlog
  // Include source note for each task so the LLM can attribute them
  const weeklyTitle = gathered.weekly?.title ?? '';
  const primaryTasks = gathered.openTasks.filter(t => t.source === weeklyTitle).slice(0, 6);
  const backlogTasks = gathered.openTasks.filter(t => t.source !== weeklyTitle).slice(0, 4);

  const taskBlock = primaryTasks.length > 0
    ? primaryTasks.map(t => `- [ ] ${t.task} (from "${t.source}")`).join('\n')
    : '(No tasks from this week\'s planning note)';

  const backlogBlock = backlogTasks.length > 0
    ? `BACKLOG (from other notes):\n${backlogTasks.map(t => `- [ ] ${t.task} (from "${t.source}")`).join('\n')}`
    : '';

  const quoteBlock = gathered.quotes.length > 0
    ? gathered.quotes.map(q => `> ${q.text}\n> — from [[${q.source}]]`).join('\n\n')
    : '';

  const goalsBlock = gathered.goalsContext
    ? `GOALS/THEMES NOTE:\n${gathered.goalsContext}`
    : '';

  const wikiTitles = Array.from(gathered.knownTitles).slice(0, 60).join(', ');

  // ── System prompt ──

  const systemPrompt = `You write a daily briefing note. You speak directly to the reader using "you/your". You know them from their notes.

VOICE: Conversational, direct, no corporate speak. Short punchy sentences. Like a sharp friend who reads all their notes. Mix prose with bullets. Use --- horizontal rules between sections. Use ## for section headings (not bold text). Bold **key phrases** within prose. Use [[wikilinks]] ONLY from the AVAILABLE WIKILINKS list.

Always address the reader as "you", never "the team" or "the user". DO NOT invent news, weather, or events. Focus on work/projects/creative goals. Skip personal diary-style stream-of-consciousness from the notes — synthesize the actionable content.

Output raw markdown. No code fences, no frontmatter, no preamble.`;

  // ── User prompt ──

  const userPrompt = `DATE: ${gathered.friendlyDate}${dayTag ? ` — ${dayTag}` : ''}

${weeklyBlock ? `${weeklyBlock}\n\n` : ''}RECENT NOTES (last ${getNumber(context.config, 'lookbackDays', 7)} days):
${recentBlock}

THIS WEEK'S OPEN TASKS (use these for the "Still open" section):
${taskBlock}

${backlogBlock}

${goalsBlock ? `${goalsBlock}\n\n` : ''}${quoteBlock ? `QUOTES FROM THEIR NOTES:\n${quoteBlock}\n\n` : ''}AVAILABLE WIKILINKS: ${wikiTitles}

WRITE THE DAILY BRIEFING using this structure:

1. Opening — "Good morning. It's [day], [month] [date]." Then optionally one sentence of context (season, day of week). Nothing invented.

---

2. ## Where things stand — 2-3 paragraphs synthesizing the week. Build this primarily from the WEEKLY PLANNING NOTE. Reference specific bullets and thoughts from it. Connect to other recent notes with [[wikilinks]]. Write in prose, not a list.

Then: **Still open:** followed by the tasks from THIS WEEK'S OPEN TASKS as - [ ] items. Include the source note in parentheses for each task. Prioritize weekly planning note tasks, then add backlog items if space permits. Max 8 tasks.

---

3. ## What to focus on today — 2-3 concrete suggestions referencing specific notes and tasks. Be specific. Focus on tasks from the weekly note, not old project ideas.

${goalsBlock ? '---\n\n4. ## The bigger picture — Brief check-in on their goals/themes. Reference the goals note with [[wikilinks]]. 2-3 sentences max.\n' : ''}---

${quoteBlock ? '5. Include a blockquote near the end.\n\n' : ''}6. One short closing line. Specific to their work. Never "keep pushing forward" or "you've got this". Examples: "Happy spring. Go build." / "Friday. Ship something."

---

7. ## Questions for tomorrow — Ask 2-3 specific, direct questions based on their current work and open tasks. These should help them reflect on decisions, priorities, or blockers. Today's note becomes tomorrow's context, so these questions seed the next day's thinking. Examples of good questions: "What's actually blocking the iOS release?" / "Did the e2e testing run surface anything new?" / "Is the CLI or .env approach better for the password config?" Be specific to THEIR work — never generic.

Keep it under 600 words. Be specific. Do not hallucinate facts.`;

  const raw = await context.sdk.runBuiltinLlm({
    purpose: 'daily-note-generate',
    systemPrompt,
    userPrompt,
    maxTokens: 8000,
    temperature: 0.7,
    disableThinking: false,
    timeoutMs: 600_000,
  });

  let content = stripThinkTags(raw);
  content = content.replace(/<\/?template>/g, '').trim();
  content = validateWikilinks(content, gathered.knownTitles);

  // Fix malformed wikilink brackets: [[title))] → [[title]], [[title]]]] → [[title]]
  content = content.replace(/\[\[([^\]]+)\)\]/g, '[[$1]]');
  content = content.replace(/\[\[([^\]]+)\]\]\]+/g, '[[$1]]');

  // Clean up LLM stutters: "**word** word" → "**word**", "[[title]] title" → "[[title]]"
  content = content.replace(/\*\*([^*]+)\*\*\s+\1/gi, '**$1**');
  content = content.replace(/\[\[([^\]]+)\]\]\s+\1/gi, '[[$1]]');
  // Fix voice breaks: solo dev, second person — use sentence-aware replacement
  content = content.replace(/\bThe team is\b/g, 'You\'re');
  content = content.replace(/\bthe team is\b/g, 'you\'re');
  content = content.replace(/\bThe team\b/g, 'You');
  content = content.replace(/\bthe team\b/g, 'you');
  content = content.replace(/\bThe user's\b/g, 'Your');
  content = content.replace(/\bthe user's\b/g, 'your');
  content = content.replace(/\bThe user is\b/g, 'You\'re');
  content = content.replace(/\bthe user is\b/g, 'you\'re');
  content = content.replace(/\bThe user\b/g, 'You');
  content = content.replace(/\bthe user\b/g, 'you');
  content = content.replace(/\bwhere we are\b/gi, 'where you are');
  content = content.replace(/\bwe need to\b/gi, 'you need to');
  content = content.replace(/\bwe can\b/gi, 'you can');
  content = content.replace(/\bHow do we\b/g, 'How do you');
  content = content.replace(/\bhow do we\b/g, 'how do you');

  // Ensure --- horizontal rules before ## headings if missing
  content = content.replace(/([^\n])\n(## )/g, '$1\n\n---\n\n$2');
  // Ensure --- after opening paragraph (before first ##)
  if (!content.includes('---') && content.includes('## ')) {
    content = content.replace(/\n(## )/, '\n\n---\n\n$1');
  }

  if (content.trim().length === 0) {
    const weekend = dow === 'saturday' || dow === 'sunday';
    content = `Good ${weekend ? 'weekend' : 'morning'}. Here's your briefing for ${gathered.friendlyDate}.\n\n---\n\n## Where things stand\n\nNo recent activity to summarize.`;
  }

  return content;
}

// ── Plugin definition ──────────────────────────────────────────────

export const dailyNotePlugin: BuiltinPlugin = {
  id: 'daily-note',
  name: 'Daily note',
  description: 'Generate a personalized daily briefing note summarizing recent activity, open tasks, and suggested next steps.',
  defaultEnabled: false,
  defaultSchedule: { kind: 'daily', time: '05:00', day: null },
  defaultAutoApply: true,
  configSchema: [
    { key: 'lookbackDays', label: 'Lookback days', type: 'number', default: 7, min: 1, max: 30 },
    { key: 'maxRecentNotes', label: 'Max recent notes', type: 'number', default: 10, min: 3, max: 30 },
    { key: 'includeOpenTasks', label: 'Include open tasks', type: 'boolean', default: true },
    { key: 'tone', label: 'Briefing tone', type: 'string', default: 'professional and warm' },
  ],

  async run(context) {
    const today = todayString();

    const existingProfile = await context.sdk.getUserProfile();
    const profileResult = await buildProfile(context, existingProfile);
    if (profileResult.updated) await context.sdk.log('info', 'Updated user profile from recent notes');

    const gathered = await gatherContext(context);

    const state = await context.sdk.getPluginState<DailyNoteState>('daily-note-state');
    if (state?.lastGeneratedDate === today && gathered.noteAlreadyExists) {
      await context.sdk.log('info', 'Daily note already generated for today, skipping');
      return { notesScanned: gathered.recentNotes.length, proposalsCreated: 0, notesSkipped: 1 };
    }

    const latestProfile = await context.sdk.getUserProfile();
    const content = await generateDailyNote(context, gathered);
    const hash = simpleHash(content);

    if (state?.lastGeneratedDate === today && state.contentHash === hash) {
      await context.sdk.log('info', 'Daily note content unchanged, skipping');
      return { notesScanned: gathered.recentNotes.length, proposalsCreated: 0, notesSkipped: 1 };
    }

    const noteUuid = gathered.existingNoteUuid ?? crypto.randomUUID();

    if (gathered.noteAlreadyExists && gathered.existingNoteUuid) {
      await context.sdk.proposeChange({
        entityType: 'note', entityId: gathered.existingNoteUuid,
        changeType: 'replace_managed_block',
        before: { title: today, filename: `${today}.md` },
        after: { blockId: 'daily-note', content, replaceStrategy: 'heading_section', headingText: '## Where things stand' },
        preview: { title: today, recentNoteCount: gathered.recentNotes.length, openTaskCount: gathered.openTasks.length, hasProfile: !!latestProfile },
        reason: `Update daily briefing for ${today}`,
      });
    } else {
      await context.sdk.proposeChange({
        entityType: 'note', entityId: noteUuid, changeType: 'create_note',
        before: {},
        after: { title: today, content, uuid: noteUuid },
        preview: { title: today, recentNoteCount: gathered.recentNotes.length, openTaskCount: gathered.openTasks.length, hasProfile: !!latestProfile },
        reason: `Generate daily briefing for ${today}`,
      });
    }

    await context.sdk.setPluginState('daily-note-state', {
      lastGeneratedDate: today, contentHash: hash, generatedAt: Date.now(),
    } satisfies DailyNoteState);

    await context.sdk.log('info', `Proposed daily note for ${today}`, {
      recentNotes: gathered.recentNotes.length, openTasks: gathered.openTasks.length,
      hasWeeklyNote: !!gathered.weekly, hasGoalsNote: !!gathered.goalsContext,
      profileAvailable: !!latestProfile, noteAlreadyExisted: gathered.noteAlreadyExists,
    });

    return { notesScanned: gathered.recentNotes.length, proposalsCreated: 1, notesSkipped: 0 };
  },
};
