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
