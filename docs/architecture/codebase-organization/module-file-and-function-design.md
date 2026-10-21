## Module, file, and function design

### Cohesion and ordering

A file owns one cohesive responsibility. Several functions may stay together when they share data,
invariants, lifecycle, or a public contract. Split distinct behaviors that can be named, tested,
changed, or understood independently; do not split merely to meet a line target.

A useful file order is:

1. Runtime or tool directive.
2. Imports.
3. Local contracts and types.
4. Constants and lookup tables.
5. Small private helpers.
6. Main export or orchestrator.
7. Additional exports that belong to the same contract.

Stateful UI files should keep related state together, effects near the lifecycle they coordinate,
derived values after source state, handlers before rendering, and large algorithms out of markup.
Orchestration functions should read top to bottom: normalize, validate, read, compute, mutate, and
return a domain-shaped result.

### Extraction is a readability and ownership decision

Extract a block when a precise name communicates it faster than its inline implementation and the
parent remains the best place to understand the overall control flow. Strong signals include:

- A dense filtering, parsing, classification, diffing, or validation policy.
- Pure computation obscured by side-effecting orchestration.
- A substantial conditional branch or cohesive multi-step transaction.
- Repeated behavior, independent error handling, or independent testing.
- Provider-specific mechanics that should sit behind an application-oriented action.

A private one-caller helper is valid when it materially improves its caller. Keep it in the same
file until reuse, independent ownership, or file cohesion justifies a module of its own.

Keep code inline when it is immediately clear, tightly coupled to local state, or a short success,
failure, or fallback branch. Do not extract for symmetry, line count, theoretical purity, helper
count, or merely because extraction is possible. Avoid generic `helpers` or `utils` dumping grounds
and abstractions that require callers to pass most of their private state.

Use a functional core and imperative shell when it clarifies the workflow: pure helpers select,
parse, validate, diff, or transform; effectful operations fetch, write, notify, and coordinate.
This is a readability tool, not a mandate to maximize purity.

### Inputs, clients, and async work

Use positional parameters for a few obvious values and a typed parameter object when arguments are
numerous, ambiguous, or share primitive types. Make dependencies explicit when that improves
testing or lifecycle control.

Construct cheap clients inside a scoped operation. Inject them for testing or multi-step reuse.
Cache only by stable configuration and only when reuse is safe. Required async work is awaited;
intentional background work must be obvious in its name, comment, or scheduling abstraction.
Polling and retry loops name terminal states, preserve the last useful error, clean up resources,
and are bounded unless intentionally long-lived.
