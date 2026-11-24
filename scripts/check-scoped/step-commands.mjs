export const DIFFERENTIAL = 'tests/conformance/title-rules-differential.mjs';

export function commandsFor(step, fsTests) {
  const pnpm = (...a) => ['pnpm', ['run', ...a]];
  switch (step.id) {
    case 'arch-gate':
      return [pnpm('check:arch-gate:portable')];
    case 'sync-contract':
      return [pnpm('check:sync-contract')];
    case 'test-rust':
      return [['cargo', ['test', ...step.args.flatMap((p) => ['-p', p])]]];
    case 'rust-conformance':
      return [['cargo', ['test', '-p', 'futo-notes-model', '--test', 'conformance']]];
    case 'test-license':
      return [['cargo', ['test', '-p', 'futo-notes-license']]];
    case 'differential':
      return [['node', ['--experimental-strip-types', DIFFERENTIAL]]];
    case 'rust-fmt':
      return [['cargo', ['fmt', '--all', '--check']]];
    case 'clippy':
      return [['cargo', ['clippy', '--workspace']]];
    case 'eslint':
      return [pnpm('lint')];
    case 'svelte-check':
      return [pnpm('check:svelte')];
    case 'prettier':
      return [['node', ['scripts/format.mjs', ...step.args]]];
    case 'vitest':
      if (step.whole) return [pnpm('test:full')];
      return [
        ['node', ['scripts/editor-deps.mjs']],
        // The desktop editor's tests, fs-reading so always run, load the real engine.
        ['node', ['scripts/build-editor-wasm.mjs']],
        [
          'node_modules/.bin/vitest',
          ['related', '--run', '--passWithNoTests', ...new Set([...step.args, ...fsTests])],
        ],
      ];
    case 'tsc':
      return [['pnpm', ['exec', 'tsc', '--noEmit']]];
    case 'build':
      return [pnpm('build')];
    default:
      throw new Error(`no command for step ${step.id}`);
  }
}
