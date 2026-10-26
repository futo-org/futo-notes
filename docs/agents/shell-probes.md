# Shell probes without quoting surprises

Use `just node-eval '<JavaScript>' [argument ...]` for async probes: it runs an ES module
with pinned Node, supports top-level `await`, and passes source/arguments literally without
another shell evaluation. Arguments are `process.argv.slice(1)`; `tsx -e` transforms to CommonJS.

```sh
just node-eval 'console.log(await Promise.resolve(42))'
just node-eval 'console.log(JSON.stringify(process.argv.slice(1)))' 'two words' '$HOME'
```

For multiline or mixed-quote programs, write a scratch `.mjs` with a **quoted** heredoc delimiter.
Double-quoted `node -e` still lets the shell execute backticks and expand dollar signs, including
Markdown fences. Read current files before choosing replacement bounds; keep unrelated patches separate.
Compare values as separate `console.log` arguments or parenthesize equality before concatenating labels.
Wrap recursive callbacks (`rows.flatMap(row => scan(row))`): `flatMap(scan)` passes an index as the
second argument, which may overwrite an accumulator.

## Search, shell state and failures

- `rg -n 'pattern' path` is recursive; `-r` replaces output, so `rg -rn` substitutes `n`.
  Cross-check surprising results against `git diff`, a direct read, the working directory and path.
- Use task variables such as `probe_result`; `status` is read-only in zsh. Avoid `HOME`/`home`
  and other system parameters. Use a tool's working-directory option or `(cd /path && command)`;
  do not assume sessions preserve cwd.
- Verification scripts use `set -e` and, in Bash, `set -o pipefail`; a later `git diff` must not
  hide an earlier failure. Check install exit codes and resolved versions after dependency changes:
  workspace-root `pnpm add` needs `-w`, and hidden diagnostics can conceal `ERR_PNPM_ADDING_TO_ROOT`.
- macOS Bash 3.2 has no associative arrays: use `case` or a Node `Map`. Stock macOS has no GNU
  `timeout`; check for `gtimeout` or use Node's `spawnSync` timeout in milliseconds.
  Use `/usr/bin/log` to avoid a login-shell function shadowing device logging.

## Use the owning verifier and parser

`just check` owns formatter policy (Markdown is excluded); separately formatting an existing
hand-formatted table does not prove a regression. Use `just check-svelte` for Svelte: targeted
ESLint may ignore `.svelte`. Svelte 5 `svelte-ignore` codes are comma-separated.

For ordinary YAML, use installed `js-yaml` rather than assuming PyYAML exists:

```sh
just node-eval 'import yaml from "js-yaml"; import { readFileSync } from "node:fs"; yaml.load(readFileSync(process.argv[1], "utf8")); console.log("YAML parsed")' path/to/file.yml
```

GitLab `!reference` needs its custom schema; use GitLab CI lint for the full pipeline.
Use `cargo metadata --no-deps --format-version 1` for Cargo TOML; check Python has `tomllib`
for other TOML. Cargo-audit config uses `advisories.severity_threshold`, while its JSON report
uses `settings.severity`: validate fixtures with the consumer, not its output schema.
