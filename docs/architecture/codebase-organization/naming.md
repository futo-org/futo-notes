## Naming

- Directories use domain nouns, user-visible feature names, capability names, or established
  provider/protocol names.
- Components and their files use the language's component convention and a semantic role such as
  `NoteRow`, `DeleteNoteDialog`, or `SyncStatusBanner`.
- Functions use precise verb-and-noun names such as `fetchAccountSummary`, `validateInviteEmail`,
  or `resolveConflicts`. A function file normally shares its main export's semantic name.
- Use `get` for abstract retrieval, `fetch` for remote/asynchronous retrieval, `list` for a
  collection, mutation verbs for mutations, and `parse`/`format`/`map`/`validate` for transformations.
- UI and boundary event handlers use `handle<Action>`; callback props describe the event from the
  child's perspective, such as `onChange` or `onClose`.
- Types use domain nouns or honest boundary suffixes such as `Params`, `Request`, `Response`, or
  `Result`. Do not use an `I` prefix for interfaces.
- Module configuration and lookup constants use the language's constant convention; ordinary local
  immutable values remain descriptive locals. Keep constants near their only consumer.
- Booleans read as claims: `isLoading`, `hasChanges`, `canSubmit`, `shouldRetry`.

Avoid vague standalone names such as `core`, `common`, `misc`, `wire`, `manager`, `processor`,
`state`, `data`, `helper`, or `processData`. Qualify them with the owned concept—for example,
`protocolMessages`, `syncCheckpoint`, `subscriptionScheduler`, or `accountMetadata`.

Do not ban useful abbreviations. Keep established terms such as `sync`, `fs`, `e2ee`, `http`, and
`cli`, and never rename a shipped command, configuration key, protocol identifier, persisted field,
or compatibility surface merely to expand an abbreviation.
