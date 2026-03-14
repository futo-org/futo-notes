Yesterday we worked on adding a new feature that would have the server run overnight and add a title to previously untitled notes. This is a neat feature! But what if you want it to work somewhat differently? For the most part, the system revolves around prompts. As a user who doesn't want to modify the code of my software, I should be able to go to the server dashboard and make edits to the prompt(s) that are being used.

Additionally, I should be able to build more. Kinda like n8n? Might be visualized as a workflow. Or simply a skill file, a plain .md. A plain .md would be awesome considering *this app is built for those bad boys*.

---

## Current State

The existing `untitled-no-more` transform is essentially one prompt call with plumbing around it:

```
system: "You suggest short, natural note titles (2-6 words, lowercase)."
        + few-shot examples from the user's existing note titles
        + "Reply with ONLY the title, no quotes, no explanation."

user:   "Suggest a title for this note:\n\n{first 2000 chars of content}"
```

Everything else is infrastructure: an SQL query to find untitled notes, calling the local LLM (Qwen3.5-4B), cleaning the output, renaming the file on disk, and recording history. The prompt itself is ~3 hardcoded lines in `untitledNoMore.ts`. There's already a `configSchema` with numeric knobs (max content chars, few-shot count), a dashboard UI that renders them, and a `transform_config` DB table that stores overrides. But the prompts themselves aren't editable.

---

## Level 1: Editable Prompts

**Goal**: Make the prompts in existing transforms editable from the dashboard, no code changes needed.

### What changes

- Add a `text` type to `TransformConfigField` (currently only `boolean`, `number`, `string`). This renders as a `<textarea>` in the dashboard.
- Move the hardcoded system and user prompts into `configSchema` as `text` fields with the current text as defaults.
- Support simple template variables in prompts: `{{content}}`, `{{exampleTitles}}`, `{{filename}}`. At runtime, the transform interpolates these before sending to the LLM.

### Config schema for untitled-no-more would become

```
- systemPrompt (text): "You suggest short, natural note titles (2-6 words, lowercase).
  {{exampleTitles}}
  Reply with ONLY the title, no quotes, no explanation."

- userPrompt (text): "Suggest a title for this note:\n\n{{content}}"

- maxContentChars (number): 2000
- fewShotCount (number): 10
```

### What this enables

- A user who wants titles in their native language edits the system prompt.
- A user who wants longer, more descriptive titles changes "2-6 words" to "8-15 words, descriptive".
- A user who wants a specific voice or style adds instructions.
- All from the dashboard, no deploy, no code.

### Effort

Small. The infrastructure is already there (config schema, dashboard rendering, DB persistence). Main work is adding `<textarea>` rendering and template interpolation.

---

## Level 2: Skill Files (user-created transforms as .md)

**Goal**: Let users create entirely new transforms by writing a markdown file. No code. The file *is* the skill.

### What a skill file looks like

```markdown
# auto-tag

Automatically add tags to notes based on their content.

## config
- max_content: 3000
- temperature: 0.4

## find notes
Notes that do not contain a line starting with `tags:` in the first 10 lines.
Modified more than 5 minutes ago.

## system prompt
You are a tagging assistant. Given a note's content, suggest 2-4 relevant tags.
Tags should be lowercase, hyphenated, prefixed with #.
Examples from this user's notes:
{{exampleTags}}
Reply with ONLY the tags, space-separated, no explanation.

## user prompt
Suggest tags for this note:

{{content}}

## action
Append to end of note:

tags: {{output}}
```

### How the runtime works

1. **Discovery**: Server scans a `skills/` directory (inside the notes folder, so it syncs across devices and is editable in-app). Each `.md` file with the right heading structure is a skill.
2. **Parsing**: Heading-delimited sections are parsed into a structured skill definition. The `# title` becomes the skill ID/name. Sections map to: config, note filter, system prompt, user prompt, action.
3. **Filter → "find notes"**: Expressed in a constrained natural language or simple filter syntax. The server translates this to an SQL query + content check. Examples:
   - "Notes with filename matching `Untitled*.md`" → `WHERE filename GLOB 'Untitled*.md'`
   - "Notes that do not contain a line starting with `tags:`" → content scan
   - "Notes modified in the last 7 days" → `WHERE modified_at > ?`
   - For complex filters, a small set of composable predicates (filename match, content contains/missing, modified before/after, has/lacks tag).
4. **Prompt execution**: Template variables are expanded (`{{content}}`, `{{filename}}`, `{{exampleTitles}}`, `{{output}}` for chained steps), then sent to the local LLM.
5. **Actions**: A fixed vocabulary of safe mutations:
   - `rename` — change the filename (title)
   - `append` — add text to end of note
   - `prepend` — add text to start of note
   - `replace` — find and replace a pattern
   - `create` — create a new note with generated content
   - `tag` — shorthand for appending tags

### What this enables

- "Auto-tag my notes" — skill file that finds untagged notes and appends tags.
- "Summarize long notes" — skill that finds notes over 500 words and prepends a TL;DR.
- "Translate titles" — skill that finds English-titled notes and renames them to Spanish.
- "Add related notes links" — skill that finds notes without a "related:" section and appends links to similar notes (using the search/embedding index).
- Users share skills by sharing `.md` files. Copy a file into your `skills/` folder and it works.

### Key design questions

1. **Where do skill files live?** Best answer: `skills/` subdirectory inside the notes folder. They sync. They're editable in-app. They're just notes about notes.
2. **Sandboxing**: A bad prompt could trash notes. Mitigations:
   - **Dry-run mode**: Skill shows what it *would* do without applying changes. Dashboard shows a preview.
   - **Transform history**: Already exists (`transform_history` table). Every action is logged with old/new state.
   - **Undo**: The history log enables undo — for renames, the old filename is stored; for appends, the appended text is known.
   - **Rate limiting**: A skill can only process N notes per run (configurable, default 10).
3. **Filter language**: Start simple (a few predefined predicates with clear syntax), expand later. Don't try to make the filter itself LLM-interpreted — that's a reliability risk.

### Effort

Medium. The hardest part is the filter parser and the action executor. The prompt templating and markdown parsing are straightforward.

---

## Level 3: Workflows (multi-step skills)

**Goal**: Chain multiple steps together — gather, transform, act — expressed linearly in the same markdown file.

### What a workflow looks like

```markdown
# weekly-digest

Generate a weekly summary note from this week's notes.

## trigger
Schedule: every Sunday at 8am

## step 1: gather
Find all notes modified in the last 7 days.
Exclude notes with filename starting with "week of".

## step 2: summarize
### system prompt
You create concise weekly digests. Organize by theme, not by date.
Keep it brief — aim for 1 paragraph per theme.

### user prompt
Here are the notes from this week:

{{step1.notes}}

Produce a themed summary.

## step 3: create note
Create a new note titled "week of {{date}}" with the content:

{{step2.output}}
```

### Another example: smart link suggestions

```markdown
# link-suggester

Find notes that should link to each other but don't.

## trigger
Schedule: daily at 3am

## step 1: gather
Find all notes modified in the last 24 hours.

## step 2: find related
For each note in step 1, use semantic search to find the 3 most similar notes
that aren't already linked.

## step 3: suggest
### system prompt
You suggest connections between notes. Be specific about *why* they're related.
Reply with a markdown list of suggestions, one per line.

### user prompt
This note:
{{note.title}}: {{note.content}}

Potentially related notes:
{{step2.related}}

Which of these are genuinely related? Why?

## step 4: append
For each note in step 1 that has suggestions, append:

---
suggested links ({{date}}):
{{step3.output}}
```

### Runtime model

Each step has a **type** inferred from its content:
- **gather**: Query notes by filter criteria. Output is a list of notes.
- **prompt**: LLM call with template vars. Can reference previous steps via `{{step1.output}}`, `{{step1.notes}}`.
- **search**: Semantic search against the embedding index. Leverages the existing search infrastructure.
- **action**: Mutate notes (create, append, rename, etc.).
- **for-each**: Implicit when a prompt step references a list from a gather step — it runs once per note.

Steps execute sequentially. Each step's output is available to subsequent steps via `{{stepN.output}}` or `{{stepN.notes}}`.

### Triggers

Level 2 skills use the same trigger as current transforms: idle window or manual. Level 3 adds:
- **Schedule**: Cron-like (`daily at 3am`, `every Sunday at 8am`, `every 6 hours`).
- **On change**: Runs when a note is modified (with debounce). Useful for real-time tagging or link suggestions.
- **Manual only**: Only runs when the user clicks "Run now" in the dashboard.

### What this enables

- Weekly/monthly digests generated automatically.
- "Morning briefing" note that summarizes what you worked on yesterday.
- Auto-linking notes based on semantic similarity.
- Flashcard generation from study notes.
- Meeting note cleanup: extract action items, tag participants, create follow-up notes.

### Effort

Large. The step execution engine, inter-step data passing, for-each semantics, and scheduling are all non-trivial. But the markdown-as-code format means the *authoring* experience stays simple even as the runtime grows.

---

## Marketplace (future)

Once skills are `.md` files, sharing is trivial:
- A public Git repo or website with curated skill files.
- In-app "browse skills" that fetches from a registry and drops the `.md` into your `skills/` folder.
- Community-contributed skills with ratings, descriptions, and previews.
- "Fork" a skill — copy it to your folder and customize.

The marketplace is just a directory of markdown files. The app is built for those bad boys.

---

## Recommended path

1. **Level 1 now** — small lift, immediately useful, proves out the "prompts are the product" insight.
2. **Level 2 next** — this is the big unlock. Design the `.md` format carefully, ship with 2-3 built-in example skills (the current untitled-no-more rewritten as a skill file, plus auto-tag and summarize). Get user feedback.
3. **Level 3 later** — only after Level 2 is proven and users are asking for multi-step workflows. The step engine is complex; don't build it until the simpler model hits its limits.
