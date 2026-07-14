# Codebase Architecture and Layout Standard

## Purpose

Place this document at a stable path inside the codebase and treat it as the
standing architecture and code-organization standard. Every AI coding agent and
human contributor must read and apply it before adding, changing, moving,
renaming, or deleting code.

The repository's normal task instructions, contributor guidance, or automation
entry point should reference this document with an instruction equivalent to:

> Before adding or changing code, read and follow the Codebase Architecture and
> Layout Standard.

This is a continuing development standard, not a one-time project-generation or
immediate whole-codebase refactoring prompt.

The goal is a codebase whose structure explains the system before any
individual file is opened. A reader should be able to infer where behavior
belongs, how data moves, which code is shared, and what a file is responsible
for from names and placement alone.

This standard is intentionally framework-tolerant. Adapt reserved filenames
such as route, page, layout, controller, handler, or middleware to the framework
in use, while preserving the ownership and dependency rules below.

## Standing Authority and Required Use

Consult this document for every code change, including small fixes, new
features, tests, configuration changes, dependency updates, file moves, and
deletions. Apply guidance in this order:

1. The product specifications in `spec/` define what the system must do.
2. This standard defines how the codebase must be organized and written.
3. Framework conventions define the behavior of framework-reserved files and directories.
4. Existing code supplies implementation knowledge and behavior that may not yet be captured in `spec/`.

Apply this standard to all new code and to every existing file materially
changed by the current task. Existing code within the task's scope may be
rewritten, moved, renamed, split, combined, or reorganized when its current
implementation does not fit this standard. Bring the affected ownership
boundary—such as the function, module, feature, route, or capability—into
alignment when necessary for a clear and coherent result. Preserve specified
behavior and supported external contracts unless the task explicitly changes
them.

This authorization applies to code within the task's scope; it is not a
requirement or authorization to refactor unrelated parts of the codebase.
Existing untouched code may remain until a requested change brings it into
scope. Do not preserve a poor in-scope structure merely to minimize the diff or
imitate an existing pattern. Restructuring beyond the affected ownership
boundary should happen when the task requests it, when the specification
requires it, or when it is necessary to implement the current change safely and
clearly.

## Core Principles

### 1. Organize by ownership, then by technical role

The primary unit of organization is the feature, route, resource, or user
workflow that owns the code. Optional technical subfolders such as
`components/`, `types/`, and `utils/` may organize code inside that owner when
they improve discovery.

Prefer:

```text
feature/
  page.tsx
  components/
  types/
```

over:

```text
components/
  every-component-in-the-application.tsx
pages/
  every-page.tsx
types/
  every-feature-type.ts
```

Promote code into a shared directory only after more than one independent owner
needs it or the code represents a true application-wide or external-system
concept.

### 2. Group cohesive capabilities into modules

When several files implement one cohesive capability, group them in a
descriptively named folder. For example, planning, pulling, pushing, conflict
resolution, and checkpoint behavior that all belong to synchronization should
live under `sync/`.

Create folders around meaningful capabilities, not merely around file types. Do
not leave many related files scattered at the source root when their shared
ownership is obvious.

Do not create a folder for every pair of files. A folder should establish a
useful module boundary and make the source tree easier to scan.

```text
src/
  sync/
    mod.rs
    plan.rs
    pull_remote_changes.rs
    push_local_changes.rs
    resolve_conflicts.rs
    checkpoint.rs
```

### 3. Keep behavior close to where it is used

Local code is easier to discover, change, and delete. A feature-specific
component belongs beside its feature. A route-specific request type belongs
beside its route. A helper used only by one boundary belongs beside that
boundary, either directly or in a capability or technical folder when several
related files need grouping.

Do not create shared abstractions in anticipation of reuse. Start local and promote deliberately.

### 4. Make boundary and module entry files read like orchestration

Pages, route handlers, controllers, and top-level workflows coordinate work. They should make the sequence visible:

1. Read inputs.
2. Validate boundary conditions.
3. Call named helpers.
4. Update state or produce a response.
5. Handle boundary-level errors and side effects.

Move implementation detail into focused helpers when it obscures that sequence.

Language-defined module entry points such as `mod.rs`, `index.ts`, and
`__init__.py` should act as module facades or orchestrators. They may:

- Declare the module's internal files.
- Re-export its intentional public interface.
- Construct dependencies owned by the module.
- Coordinate the high-level sequence of operations.
- Translate between the module's public inputs and internal operations.

They should not accumulate parsing, storage, networking, validation,
transformation, and command implementation in one file merely because the
language uses that file as the module root.

### 5. Prefer functions and plain data

Use named functions, small interfaces, discriminated unions, records, and arrays as the default building blocks. Do not introduce a class merely to group related functions.

Introduce a class only when at least one of these is true:

- Instances must own durable mutable state.
- Construction must establish and protect invariants.
- Polymorphic behavior is central to the design.
- Resource lifecycle methods must be tied to a specific instance.

Otherwise, use a module of named functions and explicit inputs.

### 6. Let names and structure carry most of the explanation

Names should state the domain action or concept. Directory placement supplies context. Comments add information that names and structure cannot efficiently express.

The target is not the maximum number of comments. The target is the maximum
amount of clarity. Optimize the final structure for clarity, ownership, and
navigability—not for the smallest possible files, the fewest lines, or the
greatest number of folders.

## Canonical Source Tree

Use this as a conceptual template. Omit directories the project does not need.

```text
project-root/
  spec/
    overview.md
    architecture.md
    features/
      <feature>.md
    decisions/
      <decision>.md
  public/                         # Runtime-served static assets
  assets/                         # Source images or documentation assets
  src/
    app/                          # Application routes and framework entry points
      layout.tsx                  # Application shell and providers
      components/                 # Components shared across multiple route trees
      api/                        # HTTP/API boundary grouped by resource
        <resource>/
          route.ts
          types.ts                # Types owned by this endpoint/resource
          utils/                  # Endpoint/resource-specific implementation
          [identifier]/
            route.ts
            <operation>/
              route.ts
              types.ts
              utils/
      <feature>/
        page.tsx                  # Feature container/orchestrator
        layout.tsx                # Feature shell, when needed
        FeatureContext.tsx        # Feature-subtree state, when needed
        components/               # Feature-owned presentation pieces
        types/                    # Feature-owned UI/domain types
        [identifier]/             # Nested resource route
          page.tsx
          components/
          <subfeature>/
            page.tsx
            components/
            types/
    types/                        # Truly cross-feature domain contracts
    utils/                        # Cross-feature logic and external integrations
      <provider-or-domain>/
        <service-area>/
          verbNoun.ts
  tests/                          # Only for tests that cannot be usefully co-located
```

The exact framework may use `controller`, `handler`, `view`, `screen`, or another reserved filename instead of `page` and `route`. Preserve the same division of responsibility.

The tree above is a menu of useful boundaries, not a requirement to create
every technical folder. Directories such as `components/`, `types/`,
`commands/`, and `utils/` are optional organizational tools. Keep clearly named
modules at the owning source root when that layout is easier to navigate:

```text
src/
  main.rs
  init.rs
  status.rs
  sync.rs
```

Create a technical or capability folder when several files form a meaningful
group or the root becomes difficult to scan. Prefer a domain-specific folder
such as `sync/`, `storage/`, or `encryption/` over a generic `utils/` folder when
the files share a recognizable responsibility.

## Placement Rules

Place a new file at the narrowest scope that completely owns it.

| Question | Placement |
| --- | --- |
| Used by one component only and short? | Keep it inside that component file. |
| Used by several components in one feature? | Keep it under that feature, using `components/`, `types/`, or a capability folder only when the grouping improves discovery. |
| Used by one API endpoint or operation? | Put it beside that route, either directly or in a local capability or `utils/` folder when several implementation files need grouping. |
| Used by several operations for one API resource? | Put it at the nearest shared resource directory. |
| Do several sibling files implement one capability? | Group them in a folder named for that capability, such as `sync/` or `storage/`. |
| Used by unrelated features? | Promote it to their nearest common owner; use an application-wide technical folder only when that makes the shared responsibility clearer. |
| Represents an external provider or infrastructure domain? | Put it under a provider- or domain-named directory, subdivided by service area when helpful. |
| Is a static data catalog used by the application? | Keep the type and its exported data together unless either is independently shared. |
| Is a test? | Co-locate it with the unit, page, route, or helper it verifies. |
| Is a product requirement or intended behavior? | Put it in `spec/`, not in a code comment. |

### Promotion rule

When local code becomes shared:

1. Confirm that the consumers need the same behavior, not merely similar-looking behavior.
2. Move it to their nearest common owner.
3. Give it a domain name rather than a name inherited from its first consumer.
4. Keep the public interface as small as possible.
5. Update consumers to import the concrete file directly.
6. Add or move tests with the promoted unit.

Shared code must earn its wider scope.

## Dependency Direction

Dependencies should point from boundary and presentation code toward stable contracts and focused implementation modules.

```text
page/component  -> feature helpers and shared UI
route/handler   -> route helpers and shared integrations
route helper    -> provider/domain utilities
all layers      -> shared types and constants when appropriate
```

Avoid these dependency directions:

- A shared utility importing from a page or route.
- A global component importing feature-private code.
- One feature reaching deep into another feature's private `components/` or `utils/` folder.
- A provider integration importing UI state.
- Domain logic depending on HTTP request or response objects.

If a lower-level module needs information from a higher-level layer, pass the required value as an argument or define a stable shared contract.

## Import Style

Use imports to signal ownership:

- Use relative imports for files within the same local feature or endpoint.
- Use the configured source alias for shared code or code outside the local owner.
- Use package imports for third-party dependencies.
- Prefer `import type` when an import is used only by the type system.
- Prefer concrete imports inside a module. A language-required or idiomatic
  module root such as `mod.rs`, `index.ts`, or `__init__.py` may define a
  deliberate public facade. Do not add a barrel only to shorten import paths.
- Avoid long cross-feature relative paths. They usually indicate that the target should be accessed through a shared location or a clearer boundary.

Group imports in a readable order:

1. Framework and third-party packages.
2. Shared application modules.
3. Feature-local modules.
4. Type-only imports where separation improves readability.

Blank lines may separate meaningful groups. Do not create elaborate import choreography when a simple grouping is clear.

## Naming Standard

### Directories

- Use domain nouns and user-visible feature names: `orders/`, `billing/`, `accounts/`.
- Use framework syntax for dynamic segments: `[identifier]/` or the framework equivalent.
- Use conventional lowercase technical folders such as `components/`, `types/`,
  and `utils/` only when they improve grouping; they are not mandatory.
- Use provider or protocol names for integration directories, preserving their standard capitalization only when it materially improves recognition.
- Prefer capability names such as `sync/`, `storage/`, or `encryption/` when
  several files implement that capability together.

### File and folder vocabulary

Prefer descriptive file and folder names over excessive abbreviations. A path
should communicate its responsibility without requiring the reader to open the
file.

Avoid vague names such as:

- `core`
- `common`
- `misc`
- `wire`
- `manager`
- `processor`
- An unqualified `state`
- An unqualified `data`

Replace them with names that identify the owned concept:

| Avoid | Prefer |
| --- | --- |
| `wire.rs` | `protocol_messages.rs` |
| `state.rs` | `sync_checkpoint.rs` |
| `core.rs` | `conflict_resolution.rs` |
| `manager.rs` | `subscription_scheduler.rs` |
| `data.rs` | `account_metadata.rs` |

Do not impose a blanket prohibition on abbreviations. Keep abbreviations that
are established, understandable to the intended contributors, or part of a
shipped contract. Names such as `sync`, `fs`, `e2ee`, `http`, and `cli` may
remain when their meaning is clear in context.

Never rename an externally shipped command, configuration key, protocol term,
or compatibility surface merely to expand an abbreviation.

### Components and component files

- Use `PascalCase`: `OrderSummary.tsx`, `DeleteOrderModal.tsx`.
- Name a component for the thing it renders or the role it performs.
- Use role suffixes when they add meaning: `Page`, `Form`, `Row`, `Field`, `Table`, `Modal`, `Section`, `Description`, `Button`, `Skeleton`, `Banner`, `Card`.
- A default-exported component's function name should match the file's semantic name.
- Framework-reserved filenames may remain generic, but the exported function should be semantic when the framework permits it.

### Functions and utility files

- Use `camelCase` verb phrases: `fetchOrder`, `validateRequestBody`, `formatTimestamp`, `updateAccessRules`.
- Name the file after its main exported function.
- Framework- and language-defined entry filenames such as `mod.rs`, `route.ts`,
  and `__init__.py` are exceptions; their containing path supplies their
  semantic name.
- Prefer precise verbs:
  - `get` for retrieving a value that may be local or abstracted.
  - `fetch` for remote or asynchronous retrieval.
  - `list` for returning a collection.
  - `create`, `update`, `delete` for mutations.
  - `convert`, `parse`, `format`, `map` for transformations.
  - `validate` or `isValid` for validation.
  - `start`, `stop`, `poll`, `retry` for lifecycle and resilience behavior.
  - `handle` for UI or boundary event handlers, not general domain functions.
- Include the affected noun. Avoid vague names such as `processData`, `doAction`, `helper`, or `manageThing`.

### Event handlers

Use `handle<Action>` inside stateful UI or boundary code:

```ts
const handleSubmit = async () => { /* ... */ };
const handleReset = () => { /* ... */ };
const handleNameChange = (value: string) => { /* ... */ };
```

Use prop names that describe the event from the child's perspective:

```ts
interface NameFieldProps {
  value: string;
  onChange: (value: string) => void;
}
```

### Types

- Use `PascalCase` nouns: `Order`, `OrderStatus`, `UpdateOrderParams`.
- Use `Props` or `<ComponentName>Props` for component props. Prefer the explicit form when the type is exported or the file contains multiple components.
- Use `<Action>Params` for a function receiving a parameter object.
- Use `Request`, `Response`, `Payload`, or `Result` only when the type actually represents that boundary.
- Use unions for finite states and modes rather than unrestricted strings.
- Use `Record<Key, Value>` for dictionary-shaped data.
- Avoid prefixes such as `I` for interfaces.

### Constants

- Use `UPPER_SNAKE_CASE` for module-level immutable configuration and lookup tables.
- Use descriptive `camelCase` for ordinary immutable local values.
- Keep a constant near its only consumer. Promote it only when it is genuinely shared.

### Booleans

Use names that read as true-or-false claims: `isLoading`, `hasChanges`, `canSubmit`, `shouldRetry`, `isDisabled`.

## File Design and Internal Ordering

Each file should have one cohesive responsibility. A file may contain several
tightly related functions when they share the same data, invariants, lifecycle,
or public contract. A useful default order is:

1. Runtime directive or file-level environment annotation.
2. Imports.
3. Local types and interfaces.
4. Module constants and lookup tables.
5. Small private helpers.
6. Main exported function or component.
7. Additional exports only when they form one cohesive module.

Inside a stateful component, use this order:

1. Context and router hooks.
2. State declarations.
3. Refs.
4. Effects.
5. Derived values.
6. Small state helpers.
7. Validation functions.
8. Event handlers and submit workflows.
9. Render return.

Keep related state next to related state. Keep effects near the state or external lifecycle they coordinate. Keep the render return free from large inline algorithms.

Inside an orchestration function, use this order:

1. Normalize or unpack inputs.
2. Create required clients or dependencies.
3. Validate prerequisites.
4. Read current state.
5. Compute the desired change.
6. Perform mutations.
7. Re-read or transform the result when necessary.
8. Return a domain-shaped result.

Use descriptive intermediate variables so the workflow reads top to bottom without commentary.

## Component Architecture

### Pages are containers

A page or screen owns feature coordination:

- Fetching feature data.
- Holding page-level state.
- Reading shared context.
- Coordinating validation and submission.
- Displaying loading and error states.
- Composing named child components.

A page should not contain every field, row, description, modal, and loading placeholder inline. Extract pieces that have a recognizable UI role.

### Child components are explicit and prop-driven

Feature components should receive the minimum data and callbacks they need. Keep them unaware of routing, global state, or network clients unless that dependency is truly part of their role.

```tsx
interface QuantityFieldProps {
  quantity: number;
  onChange: (quantity: number) => void;
}

export default function QuantityField({
  quantity,
  onChange,
}: QuantityFieldProps) {
  return (
    <input
      type="number"
      value={quantity}
      onChange={(event) => onChange(Number(event.target.value))}
    />
  );
}
```

The parent owns policy and orchestration; the field owns its markup and immediate interaction.

### Extract components when a stable concept appears

Extract a component when one or more of these are true:

- The markup has a domain or interface name.
- It is repeated.
- It has its own props or interaction contract.
- It is independently testable.
- It hides a substantial conditional branch.
- It represents a row, field, modal, table, description, status, or loading state.
- Extracting it makes the parent read as a composition of concepts.

Do not extract a wrapper that only renames a single generic element and adds no semantic, reuse, testing, or readability value.

### Keep tiny private components local

A small helper component used only by one file may remain in that file when its proximity makes the file easier to understand. Move it into `components/` when it grows, becomes reusable, or deserves independent testing.

### Loading and error UI are first-class components

Use named skeleton, spinner, banner, or empty-state components when those states contain meaningful markup or recur. This keeps the main render path focused on the feature.

### Context is scoped shared state

Use local component state by default. Introduce context when multiple descendants in a route tree need the same live state or actions.

For context modules:

1. Define the context value interface.
2. Create the context with either a safe default or `undefined`.
3. Export a custom consumer hook.
4. Throw a clear error when a required provider is missing.
5. Define provider props.
6. Keep complex behavior in a dedicated hook when it can be isolated.
7. Memoize provider values when unstable identities would cause unnecessary renders.

Do not turn context into a global dumping ground. Scope providers to the smallest subtree that needs them.

## Function and Utility Design

### One readable narrative per function

A function may coordinate several technical steps and distinct outcomes when
they form one understandable workflow. The primary extraction criterion is
readability: the parent function should read as a clear narrative at a
consistent level of abstraction.

Extract a block when its implementation details interrupt that narrative and a
descriptive helper name lets the reader understand the step without decoding
the details in place. The extracted helper does not need to be reused, publicly
exported, or independently tested to justify its existence. A meaningful
readability improvement is sufficient.

Keep a block inline when it is already immediately understandable. Do not
extract simple branches, assignments, or error recording merely because nearby
complex behavior was extracted. Asymmetric extraction is often the clearest
result: one large branch may call a helper while short branches remain inline.

Good orchestration:

```ts
export default async function updateResourceSettings({
  resourceId,
  region,
  settings,
}: UpdateResourceSettingsParams): Promise<ResourceSettings> {
  const currentSettings = await getResourceSettings({ resourceId, region });
  const changes = getSettingsToApply(currentSettings, settings);

  await applyResourceSettings({ resourceId, region, changes });

  return getResourceSettings({ resourceId, region });
}
```

Each helper states a meaningful step. The orchestration remains readable.

### Use a functional core and imperative shell where it improves readability

Separating pure policy from effectful orchestration is often useful:

- A pure helper may select, filter, classify, diff, parse, or transform values.
- An effectful helper may own one cohesive transaction such as fetching,
  decoding, resolving, writing, and updating related state.
- The parent function may retain iteration, dispatch, and short outcome handling
  so the overall workflow remains visible.

Treat this as a readability tool, not a mandate to maximize purity or helper
count. Do not extract every operation from an imperative function. Extract the
parts whose details make the surrounding workflow harder to read, and leave
simple operations in place when their inline form is clearer.

### Use parameter objects for cohesive multi-value inputs

Use positional arguments for a small number of obvious values. Use a typed parameter object when a function takes several values, when values share the same primitive type, or when the call would otherwise be ambiguous.

```ts
interface UpdateResourceSettingsParams {
  resourceId: string;
  region: string;
  settings: ResourceSettings;
}
```

Destructure the object in the function signature.

### Separate pure transformations from side effects

Functions that convert, parse, compare, filter, diff, or validate data should not also call remote services. This makes core logic easy to test and lets orchestration functions clearly distinguish computation from mutation.

### External integrations are grouped by provider and service area

Provider-specific code belongs in a directory that names the provider or infrastructure domain. Split it further by service area when that improves discovery.

Give each file one cohesive responsibility. A file may contain several tightly
related functions when they share the same data, invariants, lifecycle, or
public contract. Split a file when distinct behaviors can be named, tested,
changed, or understood independently. Do not split files merely to minimize line
counts.

For example:

```text
utils/
  CloudProvider/
    Compute/
      createServer.ts
      fetchServer.ts
      resizeServer.ts
    Identity/
      getProfile.ts
```

Do not leak provider response shapes throughout UI code. Convert external data into application-owned types near the integration or API boundary.

### Client lifecycle should be explicit

- Construct a client inside an operation when it is cheap and scoped to one configuration.
- Accept a client as an argument when testing or multi-step reuse benefits from dependency injection.
- Cache clients by stable configuration such as region only when reuse is safe and intentional.
- Do not hide ambient mutable configuration when explicit input would make behavior clearer.

### Async sequencing must be visible

Await operations whose completion is required for correctness. If work is intentionally started in the background, make that choice obvious through naming, comments, or a dedicated scheduling abstraction.

For polling and retry loops:

- Name the terminal and retryable states.
- Bound retries or time unless the process is intentionally long-lived.
- Preserve and throw the last meaningful error.
- Comment on the reason for polling or retrying.
- Keep delay and retry values configurable when callers may need different behavior.

## API and Boundary Design

### Boundary files own protocol concerns

An API route, controller, or handler should own:

- Reading path, query, header, and body inputs.
- Checking required input presence.
- Calling boundary validation.
- Selecting the correct application operation.
- Mapping success to the protocol response.
- Mapping expected and unexpected failures to stable error responses.
- Emitting boundary-level notifications or events when required.

It should not own low-level provider commands, complex parsing, or multi-step infrastructure mutation.

### Use route-local helpers

Place substantial endpoint implementation beside the route. A local `utils/`
folder is optional; use it or a capability-named folder when several
implementation files need grouping. Give each operation a verb-led name. Keep
request/response parameter types beside the resource or endpoint unless they
are shared domain contracts.

The route should read like this:

```ts
export async function PUT(request: Request, context: RouteContext) {
  const resourceId = getResourceId(context);
  const region = getRequiredRegion(request);
  const payload = await request.json();

  const validation = validateUpdatePayload(payload);
  if (!validation.valid) {
    return invalidRequest(validation.errors);
  }

  try {
    const result = await updateResource({ resourceId, region, payload });
    return success(result);
  } catch (error) {
    logUpdateFailure(error);
    return serverError();
  }
}
```

### Validate at every trust boundary

Client validation exists for fast user feedback. Server validation exists for correctness and security. One does not replace the other.

Use validation interfaces that fit the caller:

- A focused predicate for one constraint: `isValidPort(value): boolean`.
- A field validator for one user-facing error: `validateName(value): string | null`.
- A form validator for multiple messages: `validateForm(values): string[]`.
- A server validator for structured results: `{ valid: boolean; errors: Record<string, string> }`.

Keep pure validation separate from state updates and network calls.

### Error ownership

Lower-level helpers should throw errors with actionable context when they cannot complete their contract. Boundary layers should catch errors, log internal details, emit required failure events, and return safe external messages.

Do not catch an error only to silently discard it. Catch only when the current layer can add context, recover, translate the error, clean up, or update boundary state.

### Return application-shaped data

Normalize external or provider-specific objects before returning them to the UI. Return the smallest stable shape the consumer needs. Keep conversion functions pure and separately testable.

## Type and Data Modeling

### Keep types at the narrowest useful scope

- Define a component-only prop type in the component file.
- Define operation parameter types beside that operation or in its route-local `types.ts`.
- Define feature UI types in the feature's `types/` directory.
- Define cross-feature domain contracts in `src/types/`.

Do not place every interface in a global types directory.

### Model states explicitly

Use union types for finite values:

```ts
export type OperationStatus = "pending" | "success" | "error";
```

Use optional fields only when absence is a meaningful and supported state. Prefer one clear canonical model over multiple nearly identical types. If transport, provider, and UI models differ, name them by layer and convert deliberately.

### Keep static catalogs with their schema

When a typed array or lookup table defines application behavior, keep the interface and the exported data together if they change as one unit.

```ts
export interface SettingDefinition {
  key: string;
  description: string;
  type: "text" | "number" | "select";
  options?: string[];
  readOnly?: boolean;
}

export const SETTING_DEFINITIONS: SettingDefinition[] = [
  // ...
];
```

Use data-driven rendering instead of duplicating structurally identical markup.

## Comment Standard

Comments are encouraged where they improve navigation, preserve intent, or explain operational behavior. They are not a substitute for naming, extraction, types, or specifications.

### The governing rule

Write a comment when a future reader can understand what the code does but may not understand why it is done, why it is done in that order, what external constraint applies, or where a substantial visual or test section begins.

Do not comment merely to translate syntax into English.

### Use comments for these cases

#### 1. Non-obvious sequencing or external constraints

```ts
// Wait for the remote resource to terminate before deleting its network group.
await waitForTermination(resourceId);
```

```ts
// Fetch the quota once before evaluating every available size.
const quota = await fetchQuota(region);
```

#### 2. Polling, retry, timing, and background behavior

```ts
// Poll until the command reaches a terminal status.
while (status === "in_progress") {
  // ...
}
```

```ts
// Refresh periodically so the displayed log remains current.
const intervalId = setInterval(refreshLog, REFRESH_INTERVAL_MS);
```

#### 3. Major visual regions in long markup

Use short JSX landmark comments when a component contains multiple substantial regions:

```tsx
{/* Sidebar navigation */}
<aside>{/* ... */}</aside>

{/* Scrollable main content */}
<main>{children}</main>
```

Do not label every wrapper, button, or input.

#### 4. Major sections in long test files

Section dividers are acceptable when a test file contains distinct classes of tests:

```ts
// ============================
// Unit tests for conversion helpers
// ============================
```

```ts
// ============================
// End-to-end workflow test
// ============================
```

Prefer descriptive test names for individual cases. Inline comments may annotate staged mock responses when the order is significant.

#### 5. Embedded scripts, configuration, and operational command sequences

Comment these more liberally than ordinary application code. Each meaningful operational phase should be discoverable because shell commands and service configuration often hide intent:

```sh
# Install required system packages

# Write the service configuration

# Stop the service before replacing its configuration

# Wait for the health endpoint before running setup commands

# Fail when the maximum wait time is exceeded
```

Comments in embedded scripts should describe phases, safety constraints, readiness checks, and reasons for command ordering.

#### 6. Necessary tool or environment annotations

Use file-level comments required by test runners, build tools, generated-code systems, or linters. Keep them at the location expected by the tool.

### Do not use comments for these cases

Avoid comments that restate clear code:

```ts
// Set loading to true.
setIsLoading(true);
```

Avoid decorative narration:

```ts
// Loop through the items.
for (const item of items) {
  // Add the item.
  results.push(item);
}
```

Avoid placing product requirements, API contracts, or complete behavior descriptions in comments. Those belong in `spec/`.

Avoid commented-out implementation. Delete dead code; version control preserves history. Retain a commented option only when it documents a deliberately supported but currently disabled configuration, and explain why it is disabled.

Avoid author diaries, change logs, and comments that describe who changed a line. Use version control and decision records.

Avoid mandatory JSDoc on every exported symbol. Add API documentation only when callers need information that a clear name and type signature cannot convey.

### Comment voice and format

- Keep comments short, direct, and current.
- Use a sentence when explaining behavior; use a noun phrase for a visual section label.
- Place a comment immediately above the code it explains.
- Prefer one useful comment before a block over comments on every line inside it.
- Update or remove a comment in the same change that invalidates it.
- Refer to domain concepts, not incidental line mechanics.

### Relationship between `spec/` and comments

The `spec/` directory explains the system's intended behavior, constraints, workflows, and architectural decisions. Code comments explain local implementation facts that remain useful even when the reader already knows the specification.

Use this division:

| Information | Home |
| --- | --- |
| User-visible behavior and acceptance criteria | `spec/features/` |
| System-wide architecture and data flow | `spec/architecture.md` |
| Chosen tradeoff and rejected alternatives | `spec/decisions/` |
| Function inputs and outputs | Types and function signature |
| What a component renders | Component name, props, and structure |
| Why an operation must happen in a certain order | Local comment |
| Why polling, retrying, or waiting is required | Local comment |
| Major region of a long render or test file | Short landmark comment |
| Operational phases in a shell or configuration script | Phase comments in the script |

Do not duplicate paragraphs from `spec/` in source files. A short comment may reference a stable spec or decision identifier when the code implements a surprising constraint.

## State, Effects, and Data Flow

Keep data flow explicit:

- The container owns fetched data and mutation workflows.
- Child components receive values and callbacks.
- Context exposes state shared by a meaningful subtree.
- API boundaries validate and translate requests.
- Route helpers orchestrate domain and provider operations.
- Pure utilities transform data without hidden side effects.

### Effects

Use effects for synchronization with external systems, not for values that can be derived during render.

For data-loading effects:

1. Define a semantic async function inside the effect or call a named external function.
2. Set loading state before the request.
3. Use `try/catch/finally` when loading must always be cleared.
4. Log or surface failures at the appropriate layer.
5. List every value used from the surrounding scope in the dependency array.

For timers and subscriptions, always clean them up.

### Immutable updates

Update arrays and objects immutably. Use functional state updates when the next value depends on the previous value.

```ts
setItems((previousItems) =>
  previousItems.map((item) =>
    item.id === itemId ? { ...item, enabled: !item.enabled } : item
  )
);
```

### Derived state

Compute simple derived values directly from source state. Store a derived value separately only when synchronization, performance, or user editing semantics genuinely require it.

## Testing Standard

### Co-locate tests

Place tests beside the page, route, component, or utility they verify:

```text
feature/
  page.tsx
  FeaturePage.test.tsx
```

```text
utils/
  convertRules.ts
  convertRules.test.ts
```

This makes coverage discoverable and keeps tests moving with their implementation.

### Test behavior by layer

- Pure utilities: inputs, outputs, edge cases, and thrown errors.
- Provider utilities: command construction, response handling, missing fields, and provider errors with mocked clients.
- API routes: input extraction, validation, helper delegation, status codes, and response bodies.
- Components and pages: visible behavior, loading/error states, user interaction, and submitted requests.
- Context and hooks: exposed state transitions and provider requirements.

### Test naming and structure

Use behavior statements:

```ts
it("returns the default resource when one is available", async () => {
  // ...
});
```

Prefer one behavior per test. Keep fixtures and typed mocked context values near the top of the file. Reset mutable mocks in `beforeEach`. Use section comments only when they materially improve navigation through a long test file.

Test through public behavior. Export private helpers only when they are cohesive utilities worth testing independently, not merely to reach implementation details.

## Extraction Rules

Extraction is first a judgment about readability and then about ownership,
testing, and reuse. It is not a line-count contest. The question is whether a
descriptive helper makes the calling function easier to read without forcing
the reader through unnecessary indirection.

Read a candidate parent function as a narrative. At each step, ask:

- Can the reader understand this step from the surrounding code immediately?
- Does this block require the reader to pause and decode a dense pipeline,
  nested condition, or multi-step transaction?
- Would a precise helper name communicate the operation more quickly than its
  inline implementation?
- After extraction, does the parent remain the best place to understand the
  overall control flow?

Extract when the answers show that naming the operation reduces cognitive load.
Keep code inline when the implementation is clearer than an extra function
call. A long orchestration file or function is a warning when it contains
multiple independently nameable behaviors, but length alone is not the problem.

### Extract a function when

- A block has a meaningful verb-and-noun name.
- A dense filtering, mapping, classification, or diffing pipeline represents a
  policy that is easier to understand by name.
- Pure computation is mixed into side-effecting orchestration and separating it
  clarifies the workflow.
- One conditional or match branch contains a substantial multi-step operation
  that obscures the surrounding dispatch logic.
- A cohesive effectful transaction can be named, such as fetching the current
  value, decoding it, resolving it, writing it, and updating related state.
- The same behavior appears more than once.
- A branch has enough detail to obscure the main workflow.
- Independent error handling or testing is valuable.
- A provider-specific operation can be hidden behind an application-oriented action.

Reuse and independent testing strengthen the case for extraction but are not
prerequisites. A private helper used once is appropriate when it materially
improves the readability of its caller.

### Keep a function local when

- It is short and specific to one parent operation.
- Moving it would force several private details into a wider scope.
- Its name would add little beyond the code itself.
- It is a small event handler tightly coupled to local state.
- Its implementation is immediately understandable in the parent workflow.
- It is a short success, failure, or fallback branch whose inline state changes
  communicate the behavior directly.
- Extracting it would add a function jump without reducing mental effort.

Do not extract sibling branches symmetrically merely because one complex branch
needed a helper. Evaluate every block independently. It is correct for one
branch to call a substantial helper while adjacent simple branches remain
inline.

### Extract a file when

- The extracted unit has a stable name and contract.
- It has independent imports or tests.
- It is reused.
- It represents one external operation.
- Keeping it inline prevents the owner file from reading as orchestration.

### Do not extract when

- The result is a generic `helpers.ts` dumping ground.
- The abstraction combines code that is only superficially similar.
- The new file has no clear owner.
- Callers must pass most of their private state through a large parameter list merely to satisfy the abstraction.
- The result forces readers to jump between modules for trivial details.
- The only motivation is line count, stylistic symmetry, theoretical purity, or
  the fact that extraction is technically possible.

Extract logical operations into focused helpers or files, then let the parent
workflow or module entry point compose them. Stop extracting when additional
indirection would reduce locality without creating a clearer responsibility.

Start a one-caller extraction as a private helper in the same file. Move it to a
separate file only when it establishes a real module boundary, has independent
ownership, is reused, or the containing file is no longer the clearest home.

## Worked Examples

These examples demonstrate how to apply the rules to concrete decisions. The
domain names are placeholders; copy the structure and reasoning, not the names.

### Example 1: Place a complete feature

Suppose the application needs a workspace-members page that lists members,
invites a member, and removes a member.

```text
src/
  app/
    workspaces/
      [workspaceId]/
        WorkspaceContext.tsx
        members/
          page.tsx
          MembersPage.test.tsx
          components/
            InviteMemberModal.tsx
            MemberRow.tsx
            MembersTable.tsx
            MembersLoadingSkeleton.tsx
          types/
            member.ts
    api/
      workspaces/
        [workspaceId]/
          members/
            route.ts
            types.ts
            utils/
              inviteMember.ts
              listMembers.ts
              removeMember.ts
  types/
    workspace.ts
  utils/
    EmailProvider/
      sendInvitationEmail.ts
```

Placement reasoning:

- `page.tsx` owns fetching, pending state, modal state, and composing the page.
- `MemberRow.tsx` and `InviteMemberModal.tsx` are recognizable UI concepts owned
  only by this feature.
- `member.ts` stays feature-local until another independent feature needs the
  same member model.
- API protocol handling stays in `route.ts`.
- Each route helper names one application operation.
- Sending email is an external-provider concern, so it lives in the integration
  utility tree rather than inside the route.
- The workspace context sits at the workspace route level because several
  workspace subfeatures may consume it.

Do not place every file above in global `components/`, `types/`, or `utils/`
directories simply because those directories already exist.

### Example 2: Refactor a monolithic page

Assume an existing `page.tsx` contains all of these:

- A network request for records.
- Three validation functions.
- A 70-line edit modal.
- A table and row markup.
- A loading placeholder.
- A submit workflow.
- Direct calls to an external SDK.

Refactor it into this ownership model:

```text
records/
  page.tsx
  RecordsPage.test.tsx
  components/
    EditRecordModal.tsx
    RecordRow.tsx
    RecordsTable.tsx
    RecordsLoadingSkeleton.tsx

api/records/
  route.ts
  types.ts
  utils/
    listRecords.ts
    updateRecord.ts

utils/ExternalProvider/Records/
  fetchProviderRecords.ts
  updateProviderRecord.ts
```

The refactored `page.tsx` should read approximately like this:

```tsx
export default function RecordsPage() {
  const [records, setRecords] = useState<RecordSummary[]>([]);
  const [editingRecord, setEditingRecord] = useState<RecordSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    const fetchRecords = async () => {
      setIsLoading(true);
      try {
        const response = await api.get("/api/records");
        setRecords(response.data);
      } catch (error) {
        setErrors([getRequestErrorMessage(error)]);
      } finally {
        setIsLoading(false);
      }
    };

    fetchRecords();
  }, []);

  const handleSave = async (values: EditRecordValues) => {
    const validationErrors = validateEditRecord(values);
    if (validationErrors.length > 0) {
      setErrors(validationErrors);
      return;
    }

    const response = await api.put(`/api/records/${values.id}`, values);
    setRecords((current) =>
      current.map((record) =>
        record.id === response.data.id ? response.data : record
      )
    );
    setEditingRecord(null);
  };

  return (
    <section>
      <RecordsDescription />
      <ErrorList errors={errors} onDismiss={setErrors} />
      {isLoading ? (
        <RecordsLoadingSkeleton />
      ) : (
        <RecordsTable records={records} onEdit={setEditingRecord} />
      )}
      {editingRecord && (
        <EditRecordModal
          record={editingRecord}
          onSave={handleSave}
          onClose={() => setEditingRecord(null)}
        />
      )}
    </section>
  );
}
```

The page still owns the workflow, but the render now reads as a composition of
named concepts. The browser never imports the external SDK; the API and its
helpers own that boundary.

### Example 3: Decide whether a component should be extracted

Keep this local when it is used once and is already clear:

```tsx
<p className="muted">No results found.</p>
```

Extract this because it has a stable role, multiple states, and an interaction
contract:

```tsx
interface EmptyResultsProps {
  query: string;
  onClear: () => void;
}

export default function EmptyResults({ query, onClear }: EmptyResultsProps) {
  return (
    <section aria-labelledby="empty-results-title">
      <h2 id="empty-results-title">No results for “{query}”</h2>
      <button onClick={onClear}>Clear search</button>
    </section>
  );
}
```

Extract repeated field markup when each field has a clear contract:

```tsx
<EmailField
  email={email}
  error={emailError}
  onChange={setEmail}
/>
```

Do not create components named `Wrapper`, `Container`, or `SectionComponent`
unless those names represent an actual reusable layout primitive with a defined
contract.

### Example 4: Decide whether a function should be extracted

An inline expression is clear enough:

```ts
const hasChanges = originalName !== name || originalRole !== role;
```

This logic deserves a named pure function because it has rules, edge cases, and
independent tests:

```ts
export function getPermissionChanges(
  current: Permission[],
  requested: Permission[]
): PermissionChanges {
  const permissionsToAdd = requested.filter(
    (permission) => !current.includes(permission)
  );
  const permissionsToRemove = current.filter(
    (permission) => !requested.includes(permission)
  );

  return { permissionsToAdd, permissionsToRemove };
}
```

The side-effecting caller then becomes orchestration:

```ts
const currentPermissions = await fetchPermissions(userId);
const { permissionsToAdd, permissionsToRemove } = getPermissionChanges(
  currentPermissions,
  requestedPermissions
);

await updatePermissions(userId, permissionsToAdd, permissionsToRemove);
```

#### Extract dense operations while keeping simple branches inline

Consider a function that selects deletion candidates, calls a remote delete
operation, and handles written, conflict, and error outcomes. The candidate
selection is a dense policy, and conflict recovery is a large multi-step
transaction. The successful-delete and error outcomes are short and already
clear.

Prefer this shape:

```rust
fn eligible_deletions(
    missing: Vec<MissingObject>,
    claimed: &HashSet<String>,
    state: &ConnectedState,
) -> Vec<DeletionCandidate> {
    missing
        .into_iter()
        .filter(|object| !claimed.contains(&object.name))
        .filter(|object| is_syncable_filename(&object.name))
        .filter_map(|object| state.deletion_candidate(object))
        .collect()
}

async fn apply_delete_conflict(
    context: &mut DeleteContext<'_>,
    candidate: &DeletionCandidate,
) -> Result<(), DeleteError> {
    let remote = context.fetch_current(candidate).await?;
    let decoded = context.decode(remote).await?;
    let target = context.resolve_target(&decoded)?;
    context.write_target(&target, &decoded)?;
    context.record_conflict_resolution(candidate, target);
    Ok(())
}

async fn delete_missing_objects(
    context: &mut DeleteContext<'_>,
    missing: Vec<MissingObject>,
    claimed: &HashSet<String>,
) -> Result<(), DeleteError> {
    let candidates = eligible_deletions(missing, claimed, context.state);

    for candidate in candidates {
        match context.delete(&candidate).await {
            Ok(DeleteResult::Written(version)) => {
                context.state.record_deletion(&candidate, version);
                context.summary.deleted += 1;
            }
            Ok(DeleteResult::Conflict) => {
                apply_delete_conflict(context, &candidate).await?;
            }
            Err(error) => context.summary.failures.push(error.into()),
        }
    }

    Ok(())
}
```

The two helpers are extracted for readability:

- `eligible_deletions` names a dense pure selection and transformation policy.
- `apply_delete_conflict` hides one cohesive effectful recovery transaction.
- `delete_missing_objects` retains iteration and outcome dispatch, so it remains
  the best place to understand the complete workflow.
- The written and error branches remain inline because they are simple enough
  to understand immediately.

Do not extract `record_successful_delete` and `record_delete_failure` merely to
make every match branch look symmetrical. Those helpers would replace obvious
code with extra navigation and make the workflow less readable.

### Example 5: Name files and functions precisely

| Avoid | Prefer | Reason |
| --- | --- | --- |
| `helpers.ts` | `formatCurrency.ts` | Names the actual responsibility. |
| `utils.ts` | `parseConfiguration.ts` | Makes imports searchable and explicit. |
| `process.ts` | `processRefund.ts` | Includes the affected domain noun. |
| `getData()` | `fetchAccountSummary()` | States source behavior and returned concept. |
| `handleThing()` | `handleInviteSubmit()` | States the UI event. |
| `checkInput()` | `validateInviteEmail()` | States what is checked and how. |
| `flag` | `isInvitationExpired` | Reads as a boolean claim. |
| `data` | `memberSummaries` | States the value's shape and meaning. |
| `Modal.tsx` | `DeleteWorkspaceModal.tsx` | States the component's role and subject. |
| `Row.tsx` | `InvoiceRow.tsx` | Remains understandable in imports and search. |

Use domain language from `spec/`. If the specification says “subscription,” do
not alternate between `plan`, `membership`, and `contract` for the same concept.

### Example 6: Order a component file

```tsx
"use client";

import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "framework/navigation";

import { useWorkspaceContext } from "@/app/workspaces/WorkspaceContext";
import api from "@/utils/api";
import { validateInvite } from "@/utils/validateInvite";

import InviteForm from "./components/InviteForm";
import InviteLoadingSkeleton from "./components/InviteLoadingSkeleton";

interface InviteValues {
  email: string;
  role: "viewer" | "editor";
}

const EMPTY_INVITE: InviteValues = {
  email: "",
  role: "viewer",
};

export default function InvitePage() {
  const router = useRouter();
  const { workspace } = useWorkspaceContext();

  const [values, setValues] = useState(EMPTY_INVITE);
  const [errors, setErrors] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    setErrors([]);
  }, [workspace.id]);

  const canSubmit = useMemo(
    () => values.email.length > 0 && !isLoading,
    [values.email, isLoading]
  );

  const resetForm = () => {
    setValues(EMPTY_INVITE);
    setErrors([]);
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const validationErrors = validateInvite(values);
    if (validationErrors.length > 0) {
      setErrors(validationErrors);
      return;
    }

    setIsLoading(true);
    try {
      await api.post(`/api/workspaces/${workspace.id}/invitations`, values);
      router.push(`/workspaces/${workspace.id}/members`);
    } finally {
      setIsLoading(false);
    }
  };

  return isLoading ? (
    <InviteLoadingSkeleton />
  ) : (
    <InviteForm
      values={values}
      errors={errors}
      canSubmit={canSubmit}
      onChange={setValues}
      onReset={resetForm}
      onSubmit={handleSubmit}
    />
  );
}
```

The important pattern is the order: dependencies, contracts, constants,
component, hooks, state, effects, derived values, helpers, handlers, and render.

### Example 7: Keep an API route thin

Route file:

```ts
import { NextRequest, NextResponse } from "framework/server";

import { validateCreateReport } from "@/utils/validateCreateReport";

import createReport from "./utils/createReport";

export async function POST(request: NextRequest) {
  const payload = await request.json();
  const validation = validateCreateReport(payload);

  if (!validation.valid) {
    return NextResponse.json(
      { message: "Invalid report", errors: validation.errors },
      { status: 400 }
    );
  }

  try {
    const report = await createReport({ payload });
    return NextResponse.json(report, { status: 201 });
  } catch (error) {
    console.error("Error creating report:", error);
    return NextResponse.json(
      { message: "Unable to create report" },
      { status: 500 }
    );
  }
}
```

Route-local workflow:

```ts
import { storeReport } from "@/utils/Database/Reports/storeReport";
import { startReportGeneration } from "@/utils/ReportProvider/startReportGeneration";

import type { CreateReportParams, Report } from "../types";

export default async function createReport({
  payload,
}: CreateReportParams): Promise<Report> {
  const providerJob = await startReportGeneration(payload);

  return storeReport({
    title: payload.title,
    providerJobId: providerJob.id,
    status: "pending",
  });
}
```

The route owns HTTP. The workflow owns the application operation. Provider and
database utilities own their integrations.

### Example 8: Keep pure conversion separate from I/O

Pure conversion:

```ts
export function convertProviderUsers(
  providerUsers: ProviderUser[]
): UserSummary[] {
  return providerUsers.map((user) => ({
    id: user.external_id,
    displayName: user.profile.display_name,
    status: user.disabled ? "inactive" : "active",
  }));
}
```

I/O wrapper:

```ts
export async function listUsers(accountId: string): Promise<UserSummary[]> {
  const providerUsers = await fetchProviderUsers(accountId);
  return convertProviderUsers(providerUsers);
}
```

Test the converter with ordinary arrays. Test the wrapper with a mocked provider
call. Do not combine both concerns into one large function that can only be
tested through a network mock.

### Example 9: Place types at the correct scope

Component-only props stay in the component:

```ts
interface StatusBadgeProps {
  status: OperationStatus;
}
```

An endpoint's operation parameters stay beside the endpoint:

```text
api/reports/[reportId]/types.ts
```

```ts
export interface GetReportParams {
  reportId: string;
  accountId: string;
}
```

A feature-only editing shape stays in the feature:

```text
reports/types/reportForm.ts
```

```ts
export interface ReportFormValues {
  title: string;
  format: "pdf" | "csv";
}
```

A cross-feature domain model belongs in shared types:

```text
src/types/report.ts
```

```ts
export interface Report {
  id: string;
  title: string;
  status: "pending" | "complete" | "failed";
  createdAt: string;
}
```

Do not promote `ReportFormValues` merely because it contains fields also found
on `Report`; it represents a different feature-local purpose.

### Example 10: Choose local state, lifted state, context, or a class

Use local state when one component owns the value:

```ts
const [isModalOpen, setIsModalOpen] = useState(false);
```

Lift state to the nearest common parent when two siblings coordinate:

```tsx
<SearchField query={query} onChange={setQuery} />
<SearchResults query={query} />
```

Use context when a meaningful route subtree shares the same entity and actions:

```tsx
<ProjectProvider>
  <ProjectNavigation />
  <ProjectPage />
</ProjectProvider>
```

Do not use context for one modal's open state or one form field.

Use a plain module when operations are stateless:

```ts
export function calculateInvoiceTotal(lines: InvoiceLine[]): number {
  return lines.reduce((total, line) => total + line.quantity * line.unitPrice, 0);
}
```

Use a class only when instance state and invariants are the point:

```ts
export class RetryQueue {
  readonly #pending = new Map<string, RetryTask>();

  enqueue(task: RetryTask): void {
    if (this.#pending.has(task.id)) {
      throw new Error(`Task already queued: ${task.id}`);
    }
    this.#pending.set(task.id, task);
  }

  remove(taskId: string): void {
    this.#pending.delete(taskId);
  }
}
```

The class is justified because each queue instance owns mutable state and
protects a uniqueness invariant. A collection of unrelated static methods would
not justify a class.

### Example 11: Use data-driven UI for repeated structures

Instead of copying nearly identical inputs:

```ts
interface ProfileFieldDefinition {
  key: "displayName" | "jobTitle" | "department";
  label: string;
  description: string;
  type: "text" | "select";
  options?: string[];
}

export const PROFILE_FIELDS: ProfileFieldDefinition[] = [
  {
    key: "displayName",
    label: "Display name",
    description: "The name shown to other members.",
    type: "text",
  },
  {
    key: "department",
    label: "Department",
    description: "The member's organizational group.",
    type: "select",
    options: ["Engineering", "Finance", "Operations"],
  },
];
```

Render the definitions through a focused row or field component:

```tsx
{PROFILE_FIELDS.map((field) => (
  <ProfileField
    key={field.key}
    definition={field}
    value={values[field.key]}
    onChange={(value) => setFieldValue(field.key, value)}
  />
))}
```

Use data-driven rendering when the behavior is structurally the same. Keep
separate components when fields have materially different interaction rules.

### Example 12: Comment the reason, phase, or landmark

Useful sequencing comment:

```ts
// Re-fetch after the update because the provider may normalize requested values.
const updatedSettings = await fetchSettings(resourceId);
```

Useful layout landmarks:

```tsx
{/* Persistent navigation */}
<ProjectNavigation />

{/* Independently scrollable page content */}
<main>{children}</main>
```

Useful staged mock comments:

```ts
mockSend
  .mockResolvedValueOnce({ status: "pending" }) // Initial status request
  .mockResolvedValueOnce({ status: "complete" }); // Polling request
```

Useful operational script comments:

```sh
# Stop the service before replacing its active configuration
systemctl stop example-service

# Start the service and wait for its health endpoint
systemctl start example-service
```

Redundant comments to remove:

```ts
// Create an empty array.
const errors: string[] = [];

// Return the result.
return result;
```

The first set supplies information not fully expressed by syntax. The second
set merely narrates the code.

### Example 13: Co-locate tests and divide responsibility

```text
members/
  page.tsx
  MembersPage.test.tsx
  components/
    MemberRow.tsx
    MemberRow.test.tsx

api/members/
  route.ts
  MembersRoute.test.ts
  utils/
    inviteMember.ts
    inviteMember.test.ts

utils/Permissions/
  getPermissionChanges.ts
  getPermissionChanges.test.ts
```

Test responsibilities:

- `MembersPage.test.tsx` verifies loading, errors, composed results, and user
  workflows.
- `MemberRow.test.tsx` verifies row-specific interaction and accessibility.
- `MembersRoute.test.ts` verifies request validation and HTTP responses.
- `inviteMember.test.ts` verifies workflow sequencing with mocked integrations.
- `getPermissionChanges.test.ts` verifies pure input/output edge cases without
  framework or network setup.

### Example 14: Use `spec/` without duplicating it in comments

Feature specification:

```text
spec/features/member-invitations.md
```

```md
# Member invitations

- An invitation expires after a configured duration.
- An existing active member cannot be invited again.
- A successful invitation sends one email and appears in the pending list.
```

The code should express these rules through names:

```ts
if (await isActiveMember(email, workspaceId)) {
  throw new Error("Member already belongs to this workspace");
}

const invitation = await createPendingInvitation({ email, workspaceId });
await sendInvitationEmail(invitation);
```

Do not paste the three specification bullets above the function. Add a local
comment only if the implementation has a surprising constraint:

```ts
// Store the invitation before sending so retries retain a stable invitation ID.
const invitation = await createPendingInvitation({ email, workspaceId });
await sendInvitationEmail(invitation);
```

### Example 15: Promote local code only after real reuse appears

Initial state:

```text
billing/components/StatusBadge.tsx
```

If only billing renders this exact status model, leave it there. Later, suppose
billing, reports, and imports all use the same application-wide operation
statuses and visual treatment. Promote it:

```text
app/components/OperationStatusBadge.tsx
types/operation.ts
```

Rename it during promotion so the shared name describes the shared concept:

```ts
export type OperationStatus = "pending" | "success" | "error";
```

Do not promote two badges merely because both are colored pills. If one
represents payment state and the other represents user access, their similar
markup does not make them the same domain abstraction.

### Example 16: Split a long module entry point into logical operations

Suppose `sync/mod.rs` has grown to include filesystem discovery, remote
requests, plan construction, conflict resolution, writes, checkpoint storage,
and command output. The module entry point is doing both orchestration and every
implementation detail.

Refactor it into a cohesive capability module:

```text
src/
  sync/
    mod.rs
    checkpoint.rs
    discover_local_changes.rs
    plan.rs
    pull_remote_changes.rs
    push_local_changes.rs
    resolve_conflicts.rs
```

Use `mod.rs` as the module facade and high-level orchestrator:

```rust
mod checkpoint;
mod discover_local_changes;
mod plan;
mod pull_remote_changes;
mod push_local_changes;
mod resolve_conflicts;

pub async fn run_sync(context: &SyncContext) -> Result<SyncResult> {
    let local_changes =
        discover_local_changes::discover_local_changes(context).await?;
    let remote_changes =
        pull_remote_changes::pull_remote_changes(context).await?;
    let sync_plan = plan::create_sync_plan(local_changes, remote_changes)?;
    let resolved_plan =
        resolve_conflicts::resolve_conflicts(context, sync_plan)?;

    push_local_changes::push_local_changes(context, &resolved_plan).await?;
    checkpoint::save_checkpoint(context, &resolved_plan).await?;

    Ok(SyncResult::from(resolved_plan))
}
```

The entry point explains the sequence and exposes the intended public API. Each
child module owns a logical operation with its own imports, errors, and tests.

Do not split a cohesive helper solely to shorten `mod.rs`. Small private
functions that make the orchestration easier to read may remain in the entry
point.

## Structural Changes, Dependencies, and Compatibility

### Complete every move or rename

Whenever a file, folder, module, command, or exported symbol moves or is
renamed, search the entire project and update every affected reference,
including:

- Imports and re-exports.
- Module declarations.
- Tests and fixtures.
- Comments and examples.
- Specifications and architecture documents.
- README and contributor guidance.
- Build, packaging, deployment, and CI configuration.
- Scripts and generated-file inputs.
- Documentation that identifies an authoritative file or source of truth.

A move is incomplete while documentation, contributor guidance, comments, or
authority references still point to the previous name or location.

### Audit dependencies and compatibility scaffolding

After restructuring code, audit dependencies and compatibility scaffolding.

Remove:

- Imports made unused by the current change.
- Dependencies with no remaining runtime, build, development, or test consumer.
- Internal adapters for implementations that no longer exist.
- Deprecated aliases and migration paths that no supported consumer can use.
- Feature flags whose alternate path has been permanently removed.

Retain:

- Shipped command names.
- Supported import or export surfaces.
- Public configuration keys.
- Persisted file or data formats.
- Protocol identifiers.
- Compatibility behavior still promised by specifications or releases.

Do not confuse old with unused. Before removing compatibility code, determine
whether it is an internal leftover or part of an external contract. Document
intentional contract removals and provide migration guidance when required.

## Practical Size Signals

Do not enforce rigid line limits, but treat these as review prompts:

- A page with several distinct visual sections should probably have feature components.
- A boundary file containing low-level provider commands should delegate them.
- A utility file with unrelated verbs should be split by operation or domain.
- A component with many unrelated state variables may contain multiple workflows.
- A function with deeply nested branches should be flattened with guard clauses or named helpers.
- A dense pipeline or large conditional branch that interrupts an otherwise
  clear workflow should be considered for a descriptively named helper.
- Several short branches beside one complex branch do not need helpers merely
  for symmetry.
- A props interface that mirrors an entire parent state object may indicate a poorly chosen component boundary.

A long file is acceptable when it is cohesive and splitting would hide an
important sequence. Operational scripts and data catalogs are common examples.
Prefer one cohesive 200-line file over five ambiguous 40-line files. Prefer a
focused folder of related modules over ten capability files scattered across
the source root.

The same principle applies inside a function. Prefer a parent function whose
control flow is obvious and whose complex steps have useful names. Do not pursue
the fewest lines per function or the largest possible number of helpers.

A successful layout allows a reader to:

- Find a capability from its domain name.
- Understand a module from its entry point.
- Locate implementation details without searching the entire project.
- Distinguish public interfaces from private implementation.
- See why files belong together.

## AI Implementation Workflow

For every requested change, consult this standard again, review the sections
relevant to the work, and follow this sequence. Do not rely on memory from a
previous task.

### 1. Read before editing

- Read the relevant files in `spec/` completely.
- Inspect the target route or feature directory.
- Inspect its nearest modules, components, types, capability folders, and tests.
- Compare existing patterns with this standard. Preserve required behavior,
  follow compliant local conventions, and do not reproduce patterns that
  conflict with this document.
- Inspect project configuration, framework constraints, and the current working-tree state.

### 2. State ownership

Before creating a file, answer:

- Which feature, route, resource, or provider owns this behavior?
- Is it presentation, orchestration, transformation, integration, state, or a contract?
- Is it used locally or genuinely shared?
- What is the narrowest directory that can own it?
- Do several related files form a capability that deserves a named module folder?

### 3. Design the public shape

- Choose a domain-specific filename.
- Define explicit inputs and outputs.
- Decide where validation occurs.
- Separate pure logic from side effects.
- Choose whether the unit should be local, exported, or shared.

### 4. Implement in readable order

- Make boundary and module entry files read as orchestration.
- Make each parent function readable as a narrative at a consistent abstraction
  level.
- Use guard clauses for invalid prerequisites.
- Use descriptive intermediate values.
- Extract dense policies and substantial cohesive operations when their details
  interrupt the parent workflow.
- Keep simple success, error, and fallback handling inline when it is clearer
  than an additional helper call.
- Do not extract sibling branches solely for symmetry, purity, line count, or
  helper-count consistency.
- Add comments only under the comment standard above.
- Keep behavior consistent across client and server boundaries.

### 5. Test at the owning layer

- Add or update co-located tests.
- Cover the success path, invalid input, missing prerequisites, and meaningful external failures.
- Prefer pure-function tests for conversion and validation logic.
- Verify visible behavior for UI changes.

### 6. Complete structural changes

- Search for every old path, module name, export, and command reference.
- Update imports, module declarations, tests, fixtures, comments, documentation,
  specifications, contributor guidance, scripts, CI, packaging, and authority
  references.
- Remove imports and dependencies that have no remaining consumer.
- Remove obsolete internal compatibility scaffolding.
- Retain shipped compatibility surfaces that remain part of the supported
  contract.
- Document intentional external contract changes and supply migration guidance
  when required.

### 7. Review placement and clarity

Before finishing, confirm:

- A reader can find the new code from the feature or route name.
- Shared directories contain only truly shared code.
- Names explain the code without requiring narration.
- Comments explain intent, constraints, phases, or navigation—not syntax.
- The implementation matches `spec/`.
- All code added or materially changed by the task follows this standard.
- Necessary cleanup within the affected ownership boundary is complete.
- Unrelated legacy code was not treated as an automatic whole-codebase refactor.
- The result favors clarity and ownership over file-count or folder-count goals.

## Architecture Review Checklist

Use this checklist for every code addition or change. Apply each item that is
relevant to the task, even when the task is small.

### Structure

- [ ] Code is grouped under its owning feature, route, resource, or provider.
- [ ] Files implementing one cohesive capability are grouped in a descriptively named module folder when that improves navigation.
- [ ] Module entry points expose and orchestrate the capability instead of containing every implementation detail.
- [ ] Feature-private components and helpers remain local.
- [ ] Shared code is shared by real independent consumers.
- [ ] API implementations are delegated to route-local helpers where appropriate.
- [ ] Cross-feature domain types live in a shared type location; local types do not.
- [ ] Tests are co-located with the behavior they verify.
- [ ] Imports respect ownership boundaries.
- [ ] Concrete modules are imported directly unless a deliberate public module exists.
- [ ] Technical folders such as `commands/` and `utils/` exist only where they improve clarity.
- [ ] The layout is not fragmented merely to minimize file sizes.

### Naming

- [ ] Files and exports share the same semantic name.
- [ ] Functions use precise verb-and-noun names.
- [ ] Components use role-oriented `PascalCase` names.
- [ ] Booleans read as claims.
- [ ] Types describe domain concepts or boundary roles.
- [ ] There are no vague `helper`, `manager`, `processor`, or `data` names without domain context.
- [ ] File and folder names make sense without opening them.
- [ ] Established or externally shipped abbreviations remain intact when they are clear or contractual.

### Components and state

- [ ] Pages coordinate; child components render named pieces.
- [ ] Child components receive minimal explicit props.
- [ ] Shared state is scoped to the smallest useful provider.
- [ ] Loading, error, and pending states are visible and intentional.
- [ ] State updates are immutable.
- [ ] Effects synchronize with external systems and clean up resources.

### Functions and boundaries

- [ ] Pure transformations are separated from side effects when doing so makes
  the workflow easier to read or test.
- [ ] Parent functions read as coherent narratives at a consistent abstraction
  level.
- [ ] Dense policies and substantial multi-step branches use descriptive
  helpers when their inline details would interrupt the workflow.
- [ ] Simple branches remain inline when extraction would only add indirection.
- [ ] Helpers were not created solely for symmetry, line count, theoretical
  purity, or because extraction was technically possible.
- [ ] Multi-step operations read top to bottom.
- [ ] Required async work is awaited.
- [ ] Inputs are validated at trust boundaries.
- [ ] Low-level errors gain context; boundary errors are translated safely.
- [ ] External data is normalized into application-owned shapes.
- [ ] Classes are used only when instance semantics justify them.

### Comments and specifications

- [ ] Product behavior and acceptance criteria live in `spec/`.
- [ ] Comments explain non-obvious intent, sequence, constraints, or major sections.
- [ ] Embedded operational scripts have comments for meaningful phases and readiness checks.
- [ ] Comments do not restate obvious code.
- [ ] Dead code is deleted rather than commented out.
- [ ] Comments remain accurate after the change.
- [ ] Documentation, contributor guidance, and authority references reflect every move or rename.

### Verification

- [ ] Relevant tests pass.
- [ ] Type checking passes.
- [ ] Linting or formatting passes.
- [ ] New files are in the narrowest correct scope.
- [ ] The feature can be understood by following names and directories from the boundary inward.
- [ ] Unused dependencies and obsolete internal compatibility scaffolding have been removed.
- [ ] Supported commands, configuration keys, formats, protocols, and public surfaces remain compatible unless an intentional migration is documented.

## Compact Directive for an AI Agent

When a shorter prompt is needed, use this directive together with the full
standard:

> Before adding or changing code, read and follow the repository's Codebase
> Architecture and Layout Standard. Organize code by feature, route, resource,
> or provider ownership. Keep
> feature-specific components, types, helpers, and tests beside their owner;
> promote code only when independent consumers genuinely share the same
> behavior. Group several files that implement one capability in a descriptively
> named folder. Use module entry points as public facades and high-level
> orchestrators, not as containers for every implementation detail. Technical
> folders such as `commands/` and `utils/` are optional. Make pages and API
> handlers thin orchestrators that validate inputs, call precisely named
> helpers, update state or map responses, and handle boundary errors. Prefer
> functions and plain typed data over classes. Make each function read as a
> coherent narrative at a consistent abstraction level. Extract a dense pure
> policy or substantial cohesive operation when its details interrupt that
> narrative; keep simple success, error, and fallback branches inline when they
> are already clear. Do not extract for line count, symmetry, theoretical
> purity, or helper count. Use a functional core and imperative shell when it
> improves readability. Group external integrations by provider and service
> area. Prefer descriptive standalone names, while retaining established or
> contractual abbreviations such as `sync`, `fs`, and `e2ee`. Use comments for
> non-obvious intent, ordering constraints, polling/retry behavior, major JSX or
> test regions, and meaningful phases in embedded operational scripts; do not
> narrate obvious syntax or duplicate the `spec/` folder. After moves, update
> imports, comments, documentation, contributor guidance, configuration, and
> authority references. Remove genuinely unused dependencies and obsolete
> internal compatibility scaffolding while retaining supported external
> surfaces. Optimize for clarity and ownership rather than the smallest files or
> the greatest number of folders. Co-locate tests and verify behavior at the
> layer that owns it.
