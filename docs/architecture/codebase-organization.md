# Codebase organization standard

## Role and authority

This is the repository-wide standard for code ownership, placement, dependencies, naming, file
design, comments, and test placement. `docs/spec/` remains the source of truth for behavior. Root
and nested `AGENTS.md` files add safety rules, platform constraints, and required workflows.

Apply guidance in this order:

1. System and explicit user instructions.
2. Critical safety and compatibility rules in `AGENTS.md`.
3. Applicable `docs/spec/` requirements and the nearest nested `AGENTS.md`.
4. This standard.
5. Existing implementation patterns.

Framework-reserved names such as `page`, `route`, `controller`, `handler`, `screen`, `mod.rs`, or
`index.ts` may vary. Preserve the ownership and dependency rules rather than copying a framework
example literally.

Apply this standard to new code and to existing code materially changed by the task. Bring the
affected ownership boundary into alignment when needed for a coherent result, but do not treat a
scoped change as permission to refactor unrelated code. Preserve specified behavior and supported
external contracts unless the task explicitly changes them.

Compliance is a requirement, not guidance. Every new file, module, test, config file, and every new
code path added to an existing file must comply; existing noncompliant code is not precedent, and
copying a local pattern does not waive the standard. A change that violates it is incomplete and
must not be committed, submitted for review, or merged — passing tests, compiling, or keeping the
diff small does not override that. Name the narrowest owner and planned placement before
implementing, and review the resulting diff against this standard before accepting it: organization
violations are blocking review findings. The only exception is an explicit conflict with a
higher-priority requirement, which must be reported in the change.

## Core rules

### Organize by owner, then by technical role

The primary owner is the narrowest feature, route, resource, capability, provider, or user workflow
that fully owns the behavior. Optional folders such as `components/`, `types/`, `commands/`, and
`utils/` may organize code inside that owner when they improve discovery; they are not default
global buckets.

Prefer:

```text
feature/
  page.ts
  components/
  types/
```

over repositories organized mainly as application-wide collections of every component, page,
type, or helper.

### Group cohesive capabilities

When several files implement one capability, place them in a directory named for that capability:

```text
sync/
  mod.rs
  plan.rs
  pull_remote_changes.rs
  push_local_changes.rs
  resolve_conflicts.rs
```

Create a folder when it establishes a useful boundary or makes the tree easier to scan. Do not
create one for every pair of files, split solely to reduce line counts, or scatter an obvious
capability across a source root.

### Keep code local until sharing is real

Feature-specific components, types, helpers, and tests stay with their owner. Promote code only
when independent consumers need the same behavior or it represents a real application-wide or
external-system concept. Similar appearance or implementation is not enough.

When promoting code:

1. Confirm the consumers share one behavior rather than merely similar code.
2. Move it to their nearest common owner.
3. Rename it for the shared domain concept, not its first consumer.
4. Expose the smallest useful interface.
5. Move its tests and update every consumer.

Shared code must earn its scope.

### Make boundaries and entry points read as orchestration

Pages, screens, route handlers, controllers, commands, and top-level workflows should make their
sequence visible:

1. Read or normalize inputs.
2. Validate prerequisites and trust boundaries.
3. Read current state or construct dependencies.
4. Call named domain or integration operations.
5. Perform the mutation or map the result.
6. Handle boundary errors and side effects.

Language-defined module roots such as `mod.rs`, `index.ts`, and `__init__.py` are deliberate
facades. They may declare internal modules, re-export a small public interface, construct owned
dependencies, and coordinate the high-level workflow. They must not become dumping grounds for
parsing, validation, storage, networking, transformation, and command implementation.

### Prefer explicit dependencies, functions, and plain data

Use named functions, explicit inputs, small interfaces, unions/enums, records, and collections by
default. Introduce a class only when instances own durable mutable state, construction protects an
invariant, polymorphism is central, or resource lifecycle belongs to the instance.

Pass values or stable contracts down to lower layers. Do not let domain or integration code reach
up into UI state, routes, or ambient mutable configuration.

### Let structure and names explain the code

Optimize for clarity, ownership, and navigability—not the smallest diff, fewest lines, most files,
or most comments. Names state the domain action or concept; placement supplies context; comments
explain only what those cannot.

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

## Boundaries, types, and data

Boundary files own protocol concerns: extracting inputs, validating their presence and shape,
selecting an application operation, mapping results, translating failures, and emitting required
boundary events. They do not own low-level provider commands, complex parsing, or multi-step domain
mutations.

Validate every trust boundary. Client validation provides feedback; authoritative validation
provides correctness and security. Keep pure validation separate from state updates and I/O, and
return the smallest result shape the caller needs.

Lower layers throw or return errors with actionable context when they cannot satisfy their
contract. Catch only to recover, translate, add context, clean up, log, or update boundary state.
Never catch and silently discard an error. External error messages must be safe and stable.

Normalize transport and provider data into application-owned types near the integration boundary.
Keep component-only props in the component, operation types beside the operation, feature types
under the feature, and genuinely cross-feature contracts at their common owner. Model finite states
with unions/enums; use optional fields only when absence is a supported state. Name transport,
provider, domain, and UI models separately when they differ, and convert deliberately.

Keep typed static catalogs with their schema when they change together. Prefer data-driven rendering
for structurally identical behavior, but keep separate components when interaction rules differ.

## UI and state

Pages and screens are containers: they fetch or receive feature data, own page-level state,
coordinate validation and mutations, display loading and error states, and compose named child
components. Child components receive the minimum values and callbacks they need and should not know
about routing, global state, or network clients unless those are intrinsic to their role.

Extract a component when it has a stable domain or interface name, repeats, owns an interaction
contract, is independently testable, hides a substantial branch, or makes the parent read as a
composition of concepts. Keep tiny one-use components local. Do not extract wrappers that add no
semantic, reuse, testing, or readability value. Treat loading, error, pending, and empty states as
first-class UI when they contain meaningful markup.

Keep state local by default. Lift it to the nearest common owner when siblings coordinate, and use
shared context or an equivalent only for a meaningful subtree. Expose a small explicit contract and
fail clearly when a required provider is missing; do not turn shared context into a global dumping
ground.

Use effects to synchronize with external systems, not to compute values available from existing
state. Effects declare their real dependencies and clean up timers, subscriptions, and resources.
Update collections immutably when the framework depends on identity, use the prior value when the
next value depends on it, and store derived state separately only when synchronization, performance,
or editing semantics require it.

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

## Comments and specifications

Comments preserve information that names, structure, types, and specifications do not efficiently
express. Comment non-obvious intent, ordering constraints, external limitations, retry/background
behavior, and major regions in long markup or tests. Operational scripts and configuration should
label meaningful phases, safety constraints, readiness checks, and ordering requirements.

Do not:

- Translate obvious syntax into prose.
- Paste product requirements or full API contracts into source files.
- Keep dead implementation commented out.
- Write author diaries, change logs, or mandatory documentation for self-explanatory exports.
- Preserve comments invalidated by the same change.

Keep comments short, direct, current, and immediately above the code they explain. A short comment
may cite a stable specification or decision when implementing a surprising constraint.

| Information                                                  | Owner                          |
| ------------------------------------------------------------ | ------------------------------ |
| User-visible behavior and acceptance criteria                | `docs/spec/`                   |
| System-wide architecture or a durable tradeoff               | Architecture docs or ADRs      |
| Inputs, outputs, and finite states                           | Types and signatures           |
| What a component or function does                            | Its name, props, and structure |
| Why local order, waiting, retry, or a workaround is required | A nearby comment               |
| Operational phases in scripts or configuration               | Phase comments in that file    |

## Testing

Co-locate tests with the unit, feature, or boundary they verify. Use a top-level test directory only
when the test spans owners or cannot usefully live beside one implementation.

Test behavior at its owning layer:

- Pure logic: inputs, outputs, edge cases, and errors.
- Integrations: command/request construction, response conversion, missing data, and provider errors
  using controlled dependencies.
- Routes and commands: input extraction, validation, delegation, response/result mapping, and errors.
- Components and pages: visible states, interaction, accessibility, and submitted actions.
- State modules and contexts: public transitions, lifecycle, and provider requirements.

Prefer one behavior per test and names that state the behavior. Test through the public contract.
Export a private helper only when it is a cohesive unit worth owning and testing independently, not
merely to reach an implementation detail.

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

## Review signals

There are no rigid line limits. Investigate when:

- A page contains several independently named visual regions.
- A boundary file contains low-level provider or storage commands.
- A source root contains several files belonging to one capability.
- A utility file contains unrelated domain verbs.
- A component has several unrelated state workflows.
- A function has dense pipelines, deep nesting, or a large branch obscuring its narrative.
- A props/parameter object mirrors nearly all of another owner's private state.

Long cohesive files are acceptable when splitting would hide an important sequence; operational
scripts and static catalogs are common examples. Prefer one cohesive file over several ambiguous
ones, and a focused capability folder over scattered modules.

## Modifying workflow

Before implementation:

1. Read the applicable `docs/spec/` files and nested `AGENTS.md` completely.
2. Inspect the target directory, nearby owners, tests, configuration, and working-tree state.
3. Name the narrowest owner and classify the work as presentation, orchestration, domain policy,
   integration, state, or contract.
4. Choose the public shape: precise name, explicit inputs and outputs, validation boundary,
   dependency direction, and local versus shared scope.

During implementation:

1. Keep entry points at one level of abstraction and use guard clauses where they clarify invalid
   prerequisites.
2. Separate pure policy from effects when that improves readability or testing.
3. Extract only named operations that reduce cognitive load.
4. Keep behavior consistent across every supported boundary and update specifications when behavior
   changes.
5. Add or update tests at the owning layer.
6. Complete all references and compatibility work for structural changes.

Before finishing, confirm:

- A reader can find the change from the feature, resource, or capability name.
- Shared directories contain only genuinely shared concepts.
- Entry points expose a small interface and make the workflow visible.
- Dependencies point inward; no owner reaches into another owner's private implementation.
- Names explain responsibilities and comments explain only non-obvious intent.
- Tests are co-located where useful and relevant verification passes.
- Supported external surfaces remain compatible unless an intentional migration is documented.
- Cleanup within the affected owner is complete and unrelated code was left alone.
