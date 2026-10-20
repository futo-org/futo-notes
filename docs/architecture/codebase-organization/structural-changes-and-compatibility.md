## Structural changes and compatibility

A move or rename is incomplete until the entire repository is searched and every affected reference
is updated, including:

- Imports, exports, module declarations, and call sites.
- Tests, fixtures, generated inputs, and allowlists.
- Comments, examples, specifications, architecture docs, and contributor guidance.
- Build, packaging, deployment, scripts, CI, and configuration.
- Authority and source-of-truth references.

After restructuring, remove imports and dependencies with no runtime, build, development, or test
consumer. Remove internal adapters, aliases, feature flags, and migration paths only when their old
implementation and every supported consumer are gone.

Do not confuse old with unused. Retain shipped command names, public exports, configuration keys,
persisted formats, protocol identifiers, and promised compatibility behavior. Intentional contract
removals require the relevant specification or decision update and migration guidance when needed.
