Tag a personal note with one broad category and 1-3 specific topic tags.

The category is a high-level bucket like "technology", "personal", "work", "education", "history", "science", "creative", "health", "finance", or "reference" — but you are not limited to these. Pick whatever single word best describes the shelf this note belongs on.

The tags are more specific — they describe what the note is actually about. Think "what would I search for to find this note again?"

Examples:

Note title: Morning run - 5K
Note body: Did a 5K this morning, felt good. New PR at 24:30. Need to stretch more after.
{"category": "health", "tags": ["running"]}

Note title: API rate limiting ideas
Note body: Thinking about how to handle rate limits in the sync server. Could use token bucket or sliding window. Need to benchmark both approaches with Redis.
{"category": "technology", "tags": ["api-design", "sync-server"]}

Note title: Japan trip planning
Note body: Flights to Tokyo in March are ~$800. Want to visit Kyoto temples and try authentic ramen. Maybe 10 days total.
{"category": "travel", "tags": ["japan-trip", "trip-planning"]}

Note title: Startup business ideas
Note body: What if there was an app that helps people find local farmers markets? Revenue from vendor listings. Need to research competitors.
{"category": "business", "tags": ["startup-ideas", "app-concept"]}

Note title: Wednesday morning
Note body: Woke up early, made coffee. Thinking about whether to take the new job. Went for a walk after lunch. Called Sarah.
{"category": "personal", "tags": ["journal"]}

Note title: Frisch-Peierls Memorandum
Note body: The Frisch-Peierls Memorandum was a scientific paper written in March 1940 that first laid out a practical approach to building an atomic bomb using uranium-235...
{"category": "history", "tags": ["atomic-bomb", "nuclear-physics"]}

Note title: FUTO Notes sync architecture
Note body: CRDTs for conflict resolution. Each device has a device ID. Changes are merged using Yjs. The server is a simple relay...
{"category": "technology", "tags": ["futo-notes", "sync-architecture", "crdt"]}

Note title: Books to read
Note body: - The Pragmatic Programmer\n- Designing Data-Intensive Applications\n- Siddhartha
{"category": "reference", "tags": ["reading-list"]}

Note title: GFM Test
Note body: # heading\n| col | col |\n| --- | --- |
{"category": "", "tags": []}

Note title: Untitled 2
Note body:
{"category": "", "tags": []}

Rules:
- One category: a single broad word. Not a phrase.
- Tags are specific: use hyphens for multi-word tags like "job-search" or "futo-notes".
- Do NOT use the category as a tag (no "technology" in tags if category is "technology").
- Do NOT use generic tags like "notes", "misc", "general", or "other".
- Empty or test notes get empty category and tags.
- Respond with JSON only.

Note title: {{TITLE}}
Note body:
{{CONTENT}}
