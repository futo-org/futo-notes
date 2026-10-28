#!/usr/bin/env node
/** `just test-conformance-relocation`: build the real conformance test in an
 * owned copy, remove model runtime fixtures and relocate the license checkout.
 * Runs the actual binaries, then proves a newly added license part is discovered
 * without recompilation. Copies tracked model/core/license sources and goldens;
 * changes no repository fixture bytes.
 * Requires the pinned Rust toolchain and already-fetched dependencies (offline).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const usage = 'usage: just test-conformance-relocation';

export function proveConformanceRelocation() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'futo-conformance-relocation-'));
  const checkout = path.join(scratch, 'checkout');
  const env = { ...process.env, CARGO_TARGET_DIR: path.join(scratch, 'target') };
  try {
    const list = spawnSync(
      'git',
      [
        'ls-files',
        '-z',
        '--',
        'Cargo.toml',
        'Cargo.lock',
        'rust-toolchain.toml',
        'crates/futo-notes-core',
        'crates/futo-notes-model',
        'crates/futo-notes-license',
        'tests/conformance',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    if (list.status !== 0) throw new Error(list.stderr || 'cannot enumerate tracked sources');
    for (const rel of list.stdout.split('\0').filter(Boolean)) {
      const dest = path.join(checkout, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(root, rel), dest);
    }
    const manifest = path.join(checkout, 'Cargo.toml');
    const original = fs.readFileSync(manifest, 'utf8');
    const reduced = original.replace(
      /members = \[[\s\S]*?\]/,
      'members = ["crates/futo-notes-core", "crates/futo-notes-model", "crates/futo-notes-license"]',
    );
    if (reduced === original) throw new Error('cannot isolate conformance workspace members');
    fs.writeFileSync(manifest, reduced);
    const build = spawnSync(
      'cargo',
      [
        'test',
        '--offline',
        '-p',
        'futo-notes-model',
        '-p',
        'futo-notes-license',
        '--test',
        'conformance',
        '--no-run',
        '--message-format=json',
      ],
      { cwd: checkout, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
    if (build.stderr) process.stderr.write(build.stderr);
    if (build.error) throw build.error;
    if (build.status !== 0) throw new Error('conformance proof build failed');
    const executables = build.stdout
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line))
      .filter(
        (event) =>
          event.reason === 'compiler-artifact' &&
          event.target.name === 'conformance' &&
          event.executable,
      );
    if (executables.length !== 2)
      throw new Error('expected model and license conformance executables');
    const executable = (crate) => {
      const matches = executables.filter((event) => event.package_id.includes(crate));
      if (matches.length !== 1) throw new Error(`expected one executable for ${crate}`);
      return matches[0].executable;
    };
    const run = (binary, cwd, args = []) => {
      const result = spawnSync(binary, args, { cwd, env, encoding: 'utf8' });
      process.stdout.write(result.stdout ?? '');
      process.stderr.write(result.stderr ?? '');
      if (result.error) throw result.error;
      return result;
    };
    const requirePass = (result, minimum, label) => {
      const summary = result.stdout?.match(/test result: ok\. (\d+) passed; 0 failed;/);
      if (result.status !== 0 || !summary || Number(summary[1]) < minimum)
        throw new Error(`${label} failed or omitted its golden tests`);
    };
    const model = executable('futo-notes-model');
    const license = executable('futo-notes-license');
    const fixtures = path.join(checkout, 'tests/conformance');
    const retained = path.join(scratch, 'retained-fixtures');
    fs.renameSync(fixtures, retained);
    requirePass(run(model, scratch), 6, 'model fixture relocation');
    fs.renameSync(retained, fixtures);
    const relocated = path.join(scratch, 'relocated');
    fs.renameSync(checkout, relocated);
    const licenseCwd = path.join(relocated, 'crates/futo-notes-license');
    requirePass(run(license, licenseCwd), 10, 'license checkout relocation');
    const vector = 'relocation-new-part-must-be-read';
    const extraPart = path.join(relocated, 'tests/conformance/license/zz-relocation-proof.json');
    fs.writeFileSync(
      extraPart,
      JSON.stringify({
        licenseKey: [
          {
            name: vector,
            input: 'bad',
            normalized: 'intentional-wrong-normalization',
            valid: false,
          },
        ],
      }),
    );
    console.log('Negative discovery proof: the next test must fail naming the newly added vector.');
    const negative = run(license, licenseCwd, ['--exact', 'input_rules::license_key_grammar']);
    if (negative.status === 0 || !(negative.stdout + negative.stderr).includes(vector))
      throw new Error('new license fixture part was omitted or failed without naming its vector');
    fs.unlinkSync(extraPart);
    requirePass(run(license, licenseCwd), 10, 'license fixture cleanup');
    console.log(
      'Conformance relocation PASS: model fixtures embedded; license uses current checkout and new parts.',
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--help') console.log(usage);
    else {
      if (args.length) throw new Error(usage);
      proveConformanceRelocation();
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
