## Placement and dependency rules

Place every file at the narrowest scope that completely owns it.

| Need                                          | Placement                                                                        |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| Short code used by one component or operation | Keep it in that file.                                                            |
| Code used by several files in one feature     | Keep it under that feature.                                                      |
| Code used by one endpoint or command          | Put it beside that boundary.                                                     |
| Code shared by operations on one resource     | Put it at their nearest resource owner.                                          |
| Several files implementing one capability     | Use a capability-named module such as `sync/` or `storage/`.                     |
| Code shared by unrelated features             | Promote it to their nearest common owner.                                        |
| External provider or infrastructure behavior  | Use a provider- or protocol-named directory, split by service area when helpful. |
| Static behavior catalog                       | Keep its schema and data together unless independently shared.                   |
| Test                                          | Co-locate it with the unit or boundary it verifies.                              |
| Product requirement or acceptance criterion   | Put it in `docs/spec/`, not a code comment.                                      |

Dependencies point from boundaries and presentation toward stable contracts and focused
implementation modules:

```text
page/component -> feature operations and shared UI
route/command  -> boundary-local operations and domain contracts
operation      -> domain or provider integration
```

Avoid:

- Shared code importing a page, route, or feature-private module.
- Global components importing feature-private implementation.
- One feature reaching into another feature's private folders.
- Provider integrations importing UI state.
- Domain logic depending on HTTP, webview, or framework request objects.

Within one owner, prefer relative imports. Use configured source aliases for code outside that
owner and package imports for third-party dependencies. Prefer type-only imports when supported.
Import concrete modules directly unless a language-required or intentional public facade exists;
do not create barrels merely to shorten paths. Long cross-feature relative imports usually expose
a misplaced dependency or a missing boundary.

Group imports simply: third-party, shared application modules, feature-local modules, then type-only
imports when separating them helps. Do not create elaborate import choreography.
