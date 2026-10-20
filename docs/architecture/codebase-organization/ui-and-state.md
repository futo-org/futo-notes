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
