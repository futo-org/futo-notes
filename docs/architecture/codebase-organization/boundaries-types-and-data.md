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
