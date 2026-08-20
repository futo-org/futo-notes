// The dependency vulnerability scan behind `just audit` and CI's test:audit
// (docs/architecture-gates.md). Every step runs even after an earlier one fails.
//
// Staleness means "listed but not reported", so anything that makes a tool report less than
// reality condemns live acknowledgements. Hence: every result is validated as a report before
// it is read, and every ignore-list bypass is asserted to have worked.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let status = 0;

function fail(message) {
  console.error(`\n${message}`);
  status = 1;
  return null;
}

function run(command, args, cwd = ROOT) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error?.code === 'ENOENT') {
    console.error(
      `\nAUDIT-DID-NOT-RUN: ${command} is not installed, so that half was not scanned.`,
    );
    return 1;
  }
  return result.status ?? 1;
}

// Both tools exit non-zero precisely when they have findings, so the exit code says
// nothing about success — `check` is what separates a report from a failure.
function runJson(command, args, cwd, check) {
  let stdout;
  try {
    stdout = execFileSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return fail(
        `could not run ${command} in ${cwd} — is the tool installed and the cwd present?`,
      );
    }
    stdout = error.stdout ?? '';
  }
  const start = stdout.indexOf('{');
  if (start === -1) return fail(`${command} ${args.join(' ')} produced no JSON.`);
  let json;
  try {
    json = JSON.parse(stdout.slice(start));
  } catch {
    return fail(`${command} ${args.join(' ')} produced unparseable JSON.`);
  }
  const problem = check(json);
  return problem ? fail(`${command} ${args.join(' ')}: ${problem}`) : json;
}

// A renamed id field reads as undefined, which would condemn every entry in the file.
const hasId = (row) => typeof row?.advisory?.id === 'string' && row.advisory.id !== '';

// Yanked-crate warnings carry a null advisory, so there is no id to match against.
const advisoryRows = (rows) => rows.filter((row) => row?.advisory);

function cargoReport(json) {
  if (!json?.settings) return 'no settings in the output';
  const list = json?.vulnerabilities?.list;
  if (!Array.isArray(list)) return 'no vulnerabilities.list in the output';
  if (!list.every(hasId)) return 'a reported vulnerability carries no advisory.id';
  if (typeof json?.warnings !== 'object' || json.warnings === null) return 'no warnings object';
  if (!advisoryRows(Object.values(json.warnings).flat()).every(hasId)) {
    return 'a reported warning carries no advisory.id';
  }
  return null;
}

function npmReport(json) {
  if (json?.error) return `${json.error.code ?? 'error'} — ${json.error.message ?? 'no message'}`;
  if (typeof json?.metadata?.totalDependencies !== 'number') return 'no metadata.totalDependencies';
  if (typeof json?.advisories !== 'object' || json.advisories === null)
    return 'no advisories object';
  const reported = Object.values(json.advisories);
  if (reported.some((a) => typeof a?.github_advisory_id !== 'string' || !a.github_advisory_id)) {
    return 'a reported advisory carries no github_advisory_id';
  }
  return null;
}

// Neither tool has a flag to bypass its own ignore list, so the unfiltered set has to be
// read from a cwd where that config does not exist.
function liveCargo() {
  const json = runJson(
    'cargo-audit',
    ['audit', '--file', path.join(ROOT, 'Cargo.lock'), '--json'],
    os.tmpdir(),
    cargoReport,
  );
  if (!json) return null;
  const { ignore, severity, informational_warnings: informational } = json.settings;
  const unfiltered =
    !ignore?.length &&
    severity == null &&
    ['unmaintained', 'unsound'].every((kind) => informational?.includes(kind));
  if (!unfiltered) {
    return fail(
      `cargo-audit applied a config (${JSON.stringify(json.settings)}), ` +
        'so stale entries cannot be detected.',
    );
  }
  // Warnings count as reported: an unmaintained/unsound id never reaches vulnerabilities.list.
  const reported = [
    ...json.vulnerabilities.list,
    ...advisoryRows(Object.values(json.warnings).flat()),
  ];
  return new Set(reported.map((row) => row.advisory.id));
}

// Line-based rather than a regex anchored on `^key:\n`: one trailing space after the
// colon, or a CRLF, would make that a silent no-op.
function withoutTopLevelKey(text, key) {
  const out = [];
  let dropping = false;
  for (const line of text.split('\n')) {
    if (dropping && (line.trim() === '' || /^[ \t]/.test(line) || /^#/.test(line))) continue;
    dropping = false;
    if (new RegExp(`^${key}:\\s*\\r?$`).test(line)) {
      dropping = true;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

function liveNpm(realDependencyCount) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-stale-'));
  try {
    for (const file of ['pnpm-lock.yaml', 'package.json']) {
      fs.copyFileSync(path.join(ROOT, file), path.join(dir, file));
    }
    // `packages:` goes too — the member manifests it globs are not copied here.
    let workspace = fs.readFileSync(path.join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
    for (const key of ['auditConfig', 'packages']) workspace = withoutTopLevelKey(workspace, key);
    if (workspace.replace(/^\s*#.*$/gm, '').includes('ignoreGhsas')) {
      return fail(
        'the audit mirror still carries ignoreGhsas, so stale entries cannot be detected.',
      );
    }
    fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), workspace);
    // Every scope, not `--prod`: pnpm applies ignoreGhsas to dev findings as well, so a
    // prod-only mirror would miss a dev-only acknowledgement and name it fixed.
    const json = runJson('pnpm', ['audit', '--json'], dir, npmReport);
    if (!json) return null;
    const mirrored = json.metadata.totalDependencies;
    if (mirrored < realDependencyCount) {
      return fail(
        `the audit mirror resolved ${mirrored} dependencies against the tree's ` +
          `${realDependencyCount}, so stale entries cannot be detected reliably.`,
      );
    }
    return new Set(Object.values(json.advisories).map((advisory) => advisory.github_advisory_id));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const idIn = (line) =>
  line
    .match(/^\s*(?:"(RUSTSEC-\d{4}-\d{4})"|- (GHSA-[\w-]+))/i)
    ?.slice(1)
    .find(Boolean);

// A miscased entry does not suppress its advisory, so it must not read as fixed either.
const canon = (id) => id.toUpperCase();

// The one staleness answer the summary, the report and prune all read.
function staleIn({ ids, live }) {
  if (!ids || !live) return null;
  const reported = new Set([...live].map(canon));
  return ids.filter((id) => !reported.has(canon(id)));
}

// An indented comment describes its entry; a column-0 one is the file's own header.
const entryComment = (line) => /^[ \t]+#/.test(line);

// Both lists are written as blank-line-separated blocks — a comment plus the ids it
// describes — so an entry goes away prose and all, unless surviving ids still need it.
function prune({ file, stale }) {
  const full = path.join(ROOT, file);
  const doomed = new Set(stale.map(canon));
  const lines = fs.readFileSync(full, 'utf8').split('\n');

  const out = [];
  for (let i = 0; i < lines.length;) {
    if (lines[i].trim() === '') {
      out.push(lines[i]);
      i += 1;
      continue;
    }
    let end = i;
    while (end < lines.length && lines[end].trim() !== '') end += 1;
    const block = lines.slice(i, end);
    const blockIds = block.map(idIn).filter(Boolean);
    const allStale = blockIds.length > 0 && blockIds.every((id) => doomed.has(id));
    out.push(
      ...block.filter((line) => {
        const id = idIn(line);
        if (id) return !doomed.has(canon(id));
        // Structure survives regardless: the first entry shares its block with
        // `[advisories]` / `ignore = [`.
        return !(allStale && entryComment(line));
      }),
    );
    i = end;
  }

  // A removed entry leaves its blank-line separator behind.
  const tidy = out.filter((line, i) => {
    if (line.trim() !== '') return true;
    const previous = out[i - 1] ?? '';
    const next = out.slice(i + 1).find((line) => line.trim() !== '');
    if (next === undefined || /^\s*[\]}]/.test(next)) return false;
    return previous.trim() !== '' && !/[:[]$/.test(previous.trimEnd());
  });
  fs.writeFileSync(full, `${tidy.join('\n').replace(/\n+$/, '')}\n`);
}

// Line-anchored from the list onward, so prose mentioning an id is not an acknowledgement.
function listedIds(file, blockStart, idPattern) {
  let text;
  try {
    text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  } catch (error) {
    return fail(`could not read ${file}: ${error.message}`);
  }
  const start = text.indexOf(blockStart);
  if (start === -1) return fail(`${file} no longer contains \`${blockStart}\`.`);
  return [...text.slice(start + blockStart.length).matchAll(idPattern)].map((match) => match[1]);
}

// The gating scans; their own output is the report.
if (run('cargo-audit', ['audit']) !== 0) status = 1;
if (run('pnpm', ['audit', '--prod']) !== 0) status = 1;

// `--prod` is the gate, so the all-scope run is what makes dev-only findings visible at all.
const prodReport = runJson('pnpm', ['audit', '--prod', '--json'], ROOT, npmReport);
const allReport = runJson('pnpm', ['audit', '--json'], ROOT, npmReport);

const groups = [
  {
    file: '.cargo/audit.toml',
    ids: listedIds('.cargo/audit.toml', 'ignore = [', /^\s*"(RUSTSEC-\d{4}-\d{4})"/gim),
    live: liveCargo(),
  },
  {
    file: 'pnpm-workspace.yaml',
    ids: listedIds('pnpm-workspace.yaml', 'ignoreGhsas:', /^\s*- (GHSA-[\w-]+)/gim),
    // Compared against the all-scope count, matching the all-scope mirror above.
    live: allReport ? liveNpm(allReport.metadata.totalDependencies) : null,
  },
];

for (const group of groups) group.stale = staleIn(group);

console.log('');
for (const { file, ids, stale } of groups) {
  if (!ids) {
    console.log(`${file}: entry list NOT found.`);
    continue;
  }
  // How many of OUR ids are still live — the live set also holds every unacknowledged warning.
  const state = stale
    ? `${ids.length - stale.length} still reported by the audit`
    : 'NOT checked for staleness';

  console.log(`${file}: ${ids.length} ignored, ${state}.`);
}

// A group that failed either way is never called stale, which would condemn all of it.
const checked = groups.filter((group) => group.stale?.length);
const stale = checked.flatMap(({ file, stale }) => stale.map((id) => `${file}: ${id}`));
if (stale.length) {
  console.log('\nFixed or gone:');
  for (const line of stale) console.log(`  ${line}`);
  if (process.argv.includes('--fix')) {
    for (const group of checked) prune(group);
    console.log('\nRemoved. Commit alongside the bump that fixed them.');
  } else {
    console.log('\nRun `just audit --fix` to remove them.');
    status = 1;
  }
}

// ── Everything found, in one place ──

// A third cargo run: the gating scan prints text, and liveCargo's is unfiltered. `--no-fetch`
// because the gating scan already updated the database.
const cargoRows = (() => {
  const json = runJson('cargo-audit', ['audit', '--json', '--no-fetch'], ROOT, cargoReport);
  if (!json) return null;
  const row = (state, entry) => ({
    state,
    id: entry.advisory?.id ?? '—',
    what: `${entry.package.name} ${entry.package.version}`,
  });
  const warnings = Object.entries(json.warnings).flatMap(([kind, list]) =>
    list.map((entry) => row(kind, entry)),
  );
  return [
    ...json.vulnerabilities.list.map((entry) => row('vulnerability', entry)),
    ...warnings.sort((a, b) => a.state.localeCompare(b.state) || a.what.localeCompare(b.what)),
  ];
})();

const SEVERITY = ['critical', 'high', 'moderate', 'low', 'info'];
const npmRows = (() => {
  if (!prodReport || !allReport) return null;
  const gated = new Set(Object.values(prodReport.advisories).map((a) => a.github_advisory_id));
  return Object.values(allReport.advisories)
    .map((advisory) => ({
      state: gated.has(advisory.github_advisory_id) ? 'gated' : 'dev-only',
      severity: advisory.severity,
      id: advisory.github_advisory_id,
      what: advisory.module_name,
    }))
    .sort(
      (a, b) =>
        (a.state === 'gated' ? 0 : 1) - (b.state === 'gated' ? 0 : 1) ||
        SEVERITY.indexOf(a.severity) - SEVERITY.indexOf(b.severity) ||
        a.what.localeCompare(b.what),
    );
})();

function table(label, rows, columns) {
  if (!rows) {
    console.log(`\n${label} — NOT summarized; see the failure above.`);
    return;
  }
  console.log(`\n${label}`);
  if (!rows.length) {
    console.log('  nothing found.');
    return;
  }
  const width = columns.map((key) => Math.max(...rows.map((row) => row[key].length)));
  for (const row of rows) {
    const cells = columns.map((key, i) =>
      i === columns.length - 1 ? row[key] : row[key].padEnd(width[i]),
    );
    console.log(`  ${cells.join('  ')}`);
  }
}

table('Rust — cargo audit', cargoRows, ['state', 'id', 'what']);
table('npm — pnpm audit', npmRows, ['state', 'severity', 'id', 'what']);

const count = (rows, test) => rows.filter(test).length;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// `?` rather than 0: an unreadable list is not an empty one.
const ack = (file) =>
  `${groups.find((group) => group.file === file)?.ids?.length ?? '?'} acknowledged`;

const totals = [
  cargoRows
    ? [
        plural(
          count(cargoRows, (row) => row.state === 'vulnerability'),
          'vulnerability',
          'vulnerabilities',
        ),
        plural(
          count(cargoRows, (row) => row.state !== 'vulnerability'),
          'warning',
          'warnings',
        ),
        ack('.cargo/audit.toml'),
      ].join(', ')
    : 'not summarized',
  npmRows
    ? [
        `${count(npmRows, (row) => row.state === 'gated')} gated`,
        `${count(npmRows, (row) => row.state === 'dev-only')} dev-only`,
        ack('pnpm-workspace.yaml'),
      ].join(', ')
    : 'not summarized',
];
console.log(`\nRust: ${totals[0]}  ·  npm: ${totals[1]}`);

process.exit(status);
