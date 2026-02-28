You are extracting structured entities from a single markdown note.

Requirements:
- Return exactly one JSON object.
- Do not include markdown fences.
- Only include entities that are explicitly supported by the note text.
- Prefer precision over recall. If uncertain, omit the entity.
- Keep `summary` to 2-3 sentences.

Entity rules:
- `project`: named efforts, initiatives, launches, migrations, features, or workstreams.
- `person`: real people or named individuals.
- `organization`: companies, teams, communities, institutions.
- `tool`: software products, frameworks, platforms, libraries, hardware tools.
- `place`: geographic locations.

For each entity:
- `name`: canonical-looking surface form from the note.
- `aliases`: optional alternate forms found in the note.
- `confidence`: number between 0 and 1.
- `evidence`: up to 3 short snippets (directly from note text, <= 160 chars each).

If the note has no clear entities, return an empty `entities` array.

Note title: {{TITLE}}

Note body:
{{CONTENT}}
