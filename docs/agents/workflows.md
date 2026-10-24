# Checking workflow scripts

Use `just check-workflows` to validate the repository's workflow scripts, or pass individual
files: `just check-workflows .claude/workflows/bugfix-pipeline.js`.

These scripts are async function bodies run by the workflow engine. They allow top-level
`await` and `return`, plus the engine's `export const meta` declaration. Plain `node --check`
parses a JavaScript module instead and rejects a valid workflow's return statement.

The checker parses the export declaration, removes only its `export` keyword, and compiles
the body as an async function. It does not invoke that function, evaluate metadata, start
agents, access a device, or run the workflow. Other exports are rejected. A syntax error names
the selected file; parser errors also identify the source line. This proves syntax only,
not that workflow APIs or agent responses will behave correctly at runtime.
