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
