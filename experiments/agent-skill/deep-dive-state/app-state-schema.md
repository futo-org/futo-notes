## 2. The full state: `AppState` v1

### 2.1 Schema

Every key is always present, with `null` when it does not apply (N5). Phones omit `tabs` and
`sidebar` entirely. Both platforms declare them in the key list, so the conformance test can
enforce this.

```jsonc
{
  "v": 1,
  "platform": "desktop" | "ios" | "android",
  "screen": "home" | "editor:<noteId>" | "editor:new" | "list" | "folder:<path>" | "settings" | "search" | "sync" | …,
  "overlay": [ { "role": "dialog"|"menu"|"listbox"|"alertdialog"|"sheet"|"picker", "name": "Settings", "items": ["System","English","简体中文"] } ],  // bottom→top, [] = none. Derivation: sibling (b)
  "focus": "editor" | "title" | "find" | "search" | "<role> \"<label>\"" | null,                // sibling (b)
  "note": { "id": "grocery list", "title": "grocery list", "dirty": false } | null,             // phones: from the native title field
  "tabs": ["welcome", null],                                                                     // desktop only
  "editor": null | { "loading": true } | {
    "docVersion": 3960651562,
    "lines": ["- milk", "- eggs", "- bread", "- [ ] coffee", ""],
    "caret": { "line": 1, "col": 1, "offset": 0 },
    "selection": { "from": 27, "to": 30, "text": "fox" } | null,     // non-empty only; direction lives in the trace's page record
    "find": { "query": "fox", "current": 1, "total": 1 } | null,       // null = find closed
    "clipboard": "…" | null
  },
  "search": { "query": "…", "hits": ["id", …] } | null,
  "settings": { "theme": "auto", "language": "system", "issueReporting": { "enabled": true, "alwaysSend": false } },
  "sync": { "connected": false, "busy": false, "live": false, "serverUrl": "…", "status": "sync.status.notConnected", "lastError": null },
  "sidebar": { "collapsed": false, "view": "notes" },                                            // desktop only
  "toast": "…" | null,
  "vault": { "notes": ["grocery list", "work/standup", …], "folders": ["recipes", "work"] },
  "verbs": ["CreateNote", "OpenNote", …]                                                         // names; schemas via `actions`
}
```

What is **not** in AppState: element rows (rects, flags, handlers), events, and snapshots. These
are page details. They stay in the page rings and in the trace's raw page record (sibling a), and
are reachable through `elements`, `events`, `at` and `diff`.

`editor.lines` holds the whole document. That is what lets the CLI print "the changed lines as
they now read" on all three platforms with one piece of code (§4).
`ponytail:` this means the whole document is serialized twice per action. If a timing shows notes
over about 100 KB, key the lines by `docVersion` and send them only when the version changes.

### 2.2 Identity and storage

- **id** = FNV-1a-32 over canonical JSON (sorted keys), printed as 8 hex (`@a41c09e2`). This is
  the same hash that `docVersion` already uses, so there is no new function. Equal states share
  an id, which is the point:
  - Jev's loop detector (`visits`, `jev-drive.mjs:925-935`, a hand-built key of 8 fields) becomes
    `visits[stateId]`.
  - A trace turn stores `before`/`after` ids instead of an 11 KB observation. A drive trace is
    55 KB per turn today; with ids it would be about 1 KB.
- **Where it lives.** Each platform's `state` produces it; nobody else does. The CLI computes the
  id and writes `.agent/state/<id>.json` only if the file is not already there. The store is
  content-addressed and write-once, and it needs no index. It is pruned together with the trace
  (sibling a).
- **Versioning.** `v` is bumped when the schema changes. The key list lives in one fixture,
  `crates/futo-agent/fixtures/app-state-keys.json`, which is registered in
  `scripts/drift-registry.json`. A TS test, the iOS contract test and the Android contract test
  each assert their `state` against it.
- **Reading.** `just agent state` prints the current state as text: the lean header plus each
  non-null section, with vault and verbs as counts. `state @a41c09e2` prints a stored state.
  `--json` gives the raw object. This is the "full state to look over later".

---
