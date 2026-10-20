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
