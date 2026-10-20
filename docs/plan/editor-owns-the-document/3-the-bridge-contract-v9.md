## 3. The bridge contract, v9

Edit `packages/editor/src/bridge.ts`; regenerate with `just bridge-spec`; `pnpm exec vitest run
packages/editor/src/bridge.test.ts` pins the surface (currently 18 methods, version 8 — the version
assertion changes). Also fix the stale header: it still says desktop uses CodeMirror.

### 3.1 Identity

```ts
/** Which document a message is about. `noteId` is the vault-relative id the host
 *  passed in `initialize`/`setContent`; `generation` is a page-monotonic counter
 *  the bundle increments on every load and every reportable user transaction. */
export interface DocumentRef {
  noteId: string;
  generation: number;
}
```

`generation` never resets within a page load. It increments for: each `initialize`/`setContent`
load (whole document or first streamed chunk), each applied `applyExternalContent`, and each
transaction `isReportableDocumentChange` accepts (`documentChanges.ts:63-67`). Streamed chunk
appends are housekeeping and do not increment it.

### 3.2 Host → editor (`FutoEditorApi`)

| Call                                                         | Change                                    | Notes                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize(configJson)`                                     | `EditorHostConfig` gains `noteId: string` | `hostBoot.ts:34-63`, validate like `content`                                                                                                                                                                                                                                                                                       |
| `setContent(noteId, markdown)`                               | gains `noteId`                            | **Before loading, flush the outgoing document** (§4.3)                                                                                                                                                                                                                                                                             |
| `applyExternalContent(noteId, markdown, expectedGeneration)` | gains both                                | Applied iff the editor's current ref is `{noteId, expectedGeneration}` and it holds no unreported edit; otherwise refused (§4.5)                                                                                                                                                                                                   |
| `flush(token)`                                               | **new**                                   | Serialize now and post `change` with `flushToken: token`; see §4.4                                                                                                                                                                                                                                                                 |
| `getContent()`                                               | **removed**                               | Desktop keeps the component method; the gauntlet adapter (`tests/editor-gauntlet/milkdownAdapter.ts:531-568,654`) and Playwright suites switch to a `window.__futoTest.readDocument()` hook installed only by the embed's test build path — the same pattern as `window.__futoEditorMounted` (drift entry `editor-mounted-global`) |

Everything else is unchanged.

### 3.3 Editor → host (`FutoEditorOutboundMessage`)

| Message           | Shape                                                                                        | When                                                                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `documentLoaded`  | `DocumentRef & { source: 'load' \| 'external' }`                                             | A load or external apply is on screen (whole doc, or the first chunk of a streamed one). The host seeds the mailbox from it: `latest = {generation, content: <what it pushed>}`, `editedThrough = generation`                    |
| `edited`          | `DocumentRef`                                                                                | Synchronously inside the first reportable transaction after the last `change`/`documentLoaded` for this document — a transition, not every keystroke. Posted during streaming too (the save lock holds `change`, never `edited`) |
| `change`          | `DocumentRef & { content: string; flushToken?: string }`                                     | The serialization of exactly `generation`. Debounced in typing (200/1500 ms unchanged); immediate on the edges in §4.4                                                                                                           |
| `flushFailed`     | `DocumentRef & { flushToken: string; reason: 'noDocument' \| 'loadFailed' \| 'serializer' }` | A `flush` the editor cannot honour. Content is never invented — this is the structural close of #244                                                                                                                             |
| `externalRefused` | `DocumentRef`                                                                                | An `applyExternalContent` whose `expectedGeneration` did not match. `generation` is the editor's current one                                                                                                                     |

`ready`, `initialized`, `focus` and the rest are unchanged. `OUTBOUND_MESSAGE_TYPES` and the
union at `bridge.ts:557-584` gain the four new types; `BridgeCoverageTest` (Android) and the
exhaustive `switch` over `BridgeMessageType` (iOS) will fail until both hosts handle them,
which is the point.

### 3.4 Version note for the header

Write it in the style of the existing entries: v9 is BREAKING — `change` is no longer usable
without identity, `setContent`/`applyExternalContent` take a note id, `getContent` is gone,
`flush` is required when an exit mailbox is behind. Name #194/#244/#245 and this plan.
