# Shell probes without quoting surprises

Use `just node-eval '<JavaScript>' [argument ...]` for a small asynchronous probe. It runs
an ES module with the pinned Node version, so top-level `await` works without `tsx -e`'s
CommonJS transform. Arguments after the source are available as `process.argv.slice(1)`.
The recipe passes source and arguments as positional values, without another shell evaluation.

```sh
just node-eval 'console.log(await Promise.resolve(42))'
just node-eval 'console.log(JSON.stringify(process.argv.slice(1)))' 'two words' '$HOME'
```

For multiline programs or patterns containing both quote styles, write a `.mjs` file in your
private scratch directory with a **quoted** heredoc delimiter, then run that file. The shell
must not interpret Markdown fences, dollar signs, or backticks in the program. Keep unrelated
patches separate and read the current file before choosing replacement bounds. An inline
`node -e "..."` is still shell code: backticks inside those double quotes execute before Node
starts. Compare values as separate `console.log` arguments or parenthesize equality expressions
before concatenating a label. Wrap recursive callbacks explicitly (`rows.flatMap(row => scan(row))`)
when the helper's second parameter is an accumulator; `flatMap(scan)` passes the row index there.

## Search and shell state

- `rg -n 'pattern' path` searches recursively by default. Its `-r` means **replace matched
  output**, so `rg -rn` silently substitutes `n`; it is not grep's recursive flag.
- After editing a file, cross-check surprising search output against `git diff` and a direct
  file read before deciding the edit failed. Check the working directory and exact path too.
- Use names such as `pipeline_state` or `probe_result`. `status` is read-only in zsh. Avoid
  `HOME`, `home`, and other shell/system parameters for task variables.
- Use a command's working-directory option or `(cd /some/path && command)` for a temporary
  excursion. Do not rely on a persistent tool session keeping its previous directory.
- A multiline verification script starts with `set -e` (and `set -o pipefail` in Bash).
  Otherwise the exit code of a later `git diff` can hide a failed check.
- macOS's system Bash is 3.2 and has no associative arrays. Portable shell helpers use a
  `case` statement or a Node `Map`. GNU `timeout` is absent on a stock Mac; check for `gtimeout`
  before using it. Node's `spawnSync` supports a `timeout` in milliseconds without coreutils.
- Use `/usr/bin/log` for macOS device logging; a login-shell function named `log` can shadow it.

## Use the owning verifier

`just check` runs the repository's formatter policy; that policy excludes Markdown. A separate
Prettier invocation on an existing hand-formatted Markdown table does not establish a regression.
Svelte is checked with `just check-svelte` (the `check:svelte` package script); the ESLint script covers TypeScript and a targeted
ESLint invocation on `.svelte` can report an ignored file. In Svelte 5, multiple `svelte-ignore`
codes are comma-separated.

For a small ordinary YAML file, use the installed parser rather than assuming Python has PyYAML:

```sh
just node-eval 'import yaml from "js-yaml"; import { readFileSync } from "node:fs"; yaml.load(readFileSync(process.argv[1], "utf8")); console.log("YAML parsed")' path/to/file.yml
```

GitLab YAML's `!reference` needs its custom schema; use GitLab CI lint for the full pipeline.
For Cargo manifests, `cargo metadata --no-deps --format-version 1` checks the real TOML with Cargo.
For other TOML, check that the available Python has `tomllib` before choosing it as a parser.
Cargo-audit's TOML setting is `advisories.severity_threshold`; the JSON report calls it
`settings.severity`. Validate a fixture by running the consuming tool, rather than deriving its
input schema from an output field.

After changing a dependency, check the resolved package version and the install exit code.
`pnpm add` at this workspace root requires `-w`; redirecting its diagnostics can hide
`ERR_PNPM_ADDING_TO_ROOT`. Never infer a successful dependency bisect from a quiet command.
