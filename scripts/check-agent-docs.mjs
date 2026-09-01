// Self-validation gate for agent instruction files (architecture-hardening
// M19-adjacent: instruction files are followed literally by agents, so a
// stale `just <recipe>`, `pnpm run <script>`, or repo path silently sends an
// agent down a dead end). Scans README.md, CONTRIBUTING.md, every AGENTS.md
// (root + nested), .claude/skills/**/SKILL.md + their references/*.md, and
// .claude/workflows/*.js, then validates every `just`/`pnpm run`/repo-path
// reference found inside backtick spans or fenced code blocks. It also
// protects required verification command chains whose individual commands
// can all exist while the instruction that composes them is incomplete.
//
//   node scripts/check-agent-docs.mjs   (just check-agent-docs)
//
// Escape hatch for a DELIBERATE reference to something removed, or a path
// that only resolves given shell context this checker can't see (e.g. a
// preceding `cd` in the same fenced script) — explain why in the
// surrounding prose, then put one of these markers on its own line:
//   ignore-next-line:  suppresses references on the line right after it.
//     <!-- check-agent-docs: ignore-next-line -->   (Markdown)
//     // check-agent-docs: ignore-next-line          (JS)
//     # check-agent-docs: ignore-next-line           (shell)
//   ignore-next-block: place before a fenced ``` block to suppress the
//     WHOLE block — use this instead of ignore-next-line when the
//     reference sits on a shell continuation line, where inserting a
//     comment line would break the `\`-joined command.
//     <!-- check-agent-docs: ignore-next-block -->
//
// It ALSO validates the skill directory itself: a tracked symlink under
// .claude/skills/ must point at tracked content. MR !207 committed 22 symlinks
// into the gitignored `.agents/skills/`; they resolved in the one checkout that
// had `.agents/` populated and dangled in every fresh clone and every
// `git worktree add` — where parallel QA legs and CI run. The reference checks
// above could never see it, because readdir() reports a symlink as neither file
// nor directory, so the whole subtree was skipped. Local, GITIGNORED links (what
// `just skills-link` creates) are fine and invisible to this check.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Repo paths are only validated when they look path-like: they must contain
// a '/' (bare words like `justfile` or version numbers are not checked), and
// then either end in a file extension or start under one of these roots —
// conservative on purpose to avoid false positives on prose.
const KNOWN_PATH_PREFIXES = [
  'src/',
  'apps/',
  'crates/',
  'packages/',
  'docs/',
  'tests/',
  'scripts/',
  'markdown-spec/',
];

// Fenced blocks in these languages are example/illustrative source (mostly
// third-party reference skills such as swift-concurrency-pro), not shell
// commands or repo references — a quoted placeholder filename or an English
// comment containing "just" reads as a broken reference otherwise. None of
// this repo's own instruction files use these fences for real commands.
const CODE_LANGUAGE_DENYLIST = new Set([
  'swift',
  'kotlin',
  'kt',
  'java',
  'objc',
  'objectivec',
  'objective-c',
  'rust',
  'rs',
  'c',
  'cpp',
  'c++',
  'python',
  'py',
]);

const LINE_IGNORE_MARKERS = new Set([
  '<!-- check-agent-docs: ignore-next-line -->',
  '// check-agent-docs: ignore-next-line',
  '# check-agent-docs: ignore-next-line',
]);

const BLOCK_IGNORE_MARKERS = new Set(['<!-- check-agent-docs: ignore-next-block -->']);

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'target',
  'dist',
  '.build',
  '.build-device',
  '.build-device-release',
]);

// ---------------------------------------------------------------------------
// justfile / package.json parsing
// ---------------------------------------------------------------------------

const JUST_ALIAS_RE = /^alias\s+([a-zA-Z_][a-zA-Z0-9_-]*)\s*:=/;
// A recipe header: an unindented, non-comment line whose name is followed
// (optionally through parameters or a dependency list) by the FIRST colon on
// the line — covers both `name params:` and `name: dep1 dep2` shapes.
const JUST_RECIPE_RE = /^([a-zA-Z_][a-zA-Z0-9_-]*)[^\n:]*:(?!=)/;

// Recipe/alias names invocable as `just <name>`, parsed directly from the
// justfile text rather than shelling out to `just` (CI's pinned image does
// not have it — see the justfile's own arch-gate comment).
export function parseJustRecipes(justfileText) {
  const names = new Set();
  for (const rawLine of justfileText.split('\n')) {
    if (/^\s/.test(rawLine)) continue; // recipe body line
    const trimmed = rawLine.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const alias = JUST_ALIAS_RE.exec(rawLine);
    if (alias) {
      names.add(alias[1]);
      continue;
    }
    const recipe = JUST_RECIPE_RE.exec(rawLine);
    if (recipe) names.add(recipe[1]);
  }
  return names;
}

export function parsePackageScripts(packageJsonText) {
  const pkg = JSON.parse(packageJsonText);
  return new Set(Object.keys(pkg.scripts ?? {}));
}

// ---------------------------------------------------------------------------
// Reference extraction
// ---------------------------------------------------------------------------

function extractPathCandidate(rawToken) {
  const token = rawToken.replace(/^[(["'[]+/, '').replace(/[)\]"'.,;:!?]+$/, '');
  if (!token.includes('/')) return null;
  if (token.startsWith('/') || token.startsWith('~')) return null; // absolute/home path, not repo-relative
  if (token.includes('$') || token.includes('{') || token.includes('<') || token.includes('>'))
    return null;
  if (token.includes('\\') || token.includes('|') || token.includes('..')) return null; // sed/alternation/git-range/ellipsis, not a path
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(token)) return null; // URL

  const hasKnownPrefix = KNOWN_PATH_PREFIXES.some((prefix) => token.startsWith(prefix));
  const hasExtension = /\.[a-zA-Z0-9]{1,10}$/.test(token.replace(/\/+$/, ''));
  return hasKnownPrefix || hasExtension ? token : null;
}

// Extracts every `just <recipe>`, `pnpm run <script>`, and repo-path
// reference found inside backtick spans (inline `` `like this` ``) or
// fenced ``` code blocks, with the 1-based line number it was found on. A
// line matching the ignore-next-line marker suppresses references on the
// line right after it; the ignore-next-block marker (placed before a
// fence) suppresses the whole block. Fenced blocks tagged with a
// denylisted example-source language (see CODE_LANGUAGE_DENYLIST) are
// skipped entirely — an English comment or placeholder string inside
// example Swift/Kotlin is not a repo reference.
export function extractReferences(text) {
  const refs = [];
  let inFence = false;
  let fenceLanguageDenied = false;
  let fenceBlockIgnored = false;
  let ignoreNextLine = false;
  let ignoreNextBlock = false;
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const lineNo = i + 1;
    const trimmed = rawLine.trim();

    if (LINE_IGNORE_MARKERS.has(trimmed)) {
      ignoreNextLine = true;
      continue;
    }
    if (BLOCK_IGNORE_MARKERS.has(trimmed)) {
      ignoreNextBlock = true;
      continue;
    }
    const fence = /^```\s*([a-zA-Z0-9+-]*)/.exec(trimmed);
    if (fence) {
      inFence = !inFence;
      fenceLanguageDenied = inFence && CODE_LANGUAGE_DENYLIST.has(fence[1].toLowerCase());
      fenceBlockIgnored = inFence && ignoreNextBlock;
      ignoreNextLine = false;
      ignoreNextBlock = false;
      continue;
    }

    const shouldIgnore = ignoreNextLine;
    ignoreNextLine = false;
    if (shouldIgnore || (inFence && (fenceLanguageDenied || fenceBlockIgnored))) continue;

    const segments = inFence
      ? [rawLine]
      : [...rawLine.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);

    for (const segment of segments) {
      for (const match of segment.matchAll(/\bjust\s+([a-zA-Z][a-zA-Z0-9_-]*)/g)) {
        refs.push({ line: lineNo, kind: 'just', value: match[1] });
      }
      for (const match of segment.matchAll(/\bpnpm run\s+([a-zA-Z][a-zA-Z0-9_:-]*)/g)) {
        refs.push({ line: lineNo, kind: 'pnpm', value: match[1] });
      }
      // Split on parens/quotes too (not just whitespace) so an embedded
      // reference like `import('/src/x.ts')` isolates cleanly. Braces,
      // brackets, and commas are deliberately NOT delimiters here — they
      // must stay attached so a brace-expansion path list (which contains
      // '{' and is skipped outright, see extractPathCandidate) isn't
      // fragmented into a validated-looking prefix.
      for (const token of segment.split(/[\s()'"`;]+/)) {
        const pathValue = extractPathCandidate(token);
        if (pathValue) refs.push({ line: lineNo, kind: 'path', value: pathValue });
      }
    }
  }

  return refs;
}

// A glob's static prefix directory is the last '/'-delimited segment before
// the first glob character; brace patterns (`{a,b}`) are never extracted in
// the first place (see extractPathCandidate), only `*`/`?` globs reach here.
export function resolvePathCheckTarget(token) {
  const globIndex = token.search(/[*?]/);
  if (globIndex === -1) return { target: token.replace(/\/+$/, ''), isGlob: false };

  const prefix = token.slice(0, globIndex);
  const dir = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix.slice(0, prefix.lastIndexOf('/'));
  return { target: dir || '.', isGlob: true };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateReferences(refs, { justRecipes, pnpmScripts, pathExists }) {
  const violations = [];

  for (const ref of refs) {
    if (ref.kind === 'just') {
      if (!justRecipes.has(ref.value)) {
        violations.push({ line: ref.line, message: `just ${ref.value} — no such justfile recipe` });
      }
    } else if (ref.kind === 'pnpm') {
      if (!pnpmScripts.has(ref.value)) {
        violations.push({
          line: ref.line,
          message: `pnpm run ${ref.value} — no such package.json script`,
        });
      }
    } else if (ref.kind === 'path') {
      const { target, isGlob } = resolvePathCheckTarget(ref.value);
      if (!pathExists(target)) {
        violations.push({
          line: ref.line,
          message: isGlob
            ? `${ref.value} — glob's static prefix directory '${target}' does not exist`
            : `${ref.value} — path does not exist`,
        });
      }
    }
  }

  return violations;
}

const VERIFY_SKILL_PATH = '.claude/skills/verify/SKILL.md';
const SHARED_NOTE_RULE_COMMANDS = ['pnpm run test:editor:minimal', 'just test-rust'];

export function validateRequiredVerificationChains(file, text) {
  if (file.replaceAll(path.sep, '/') !== VERIFY_SKILL_PATH) return [];

  const sharedHeading = /^### shared\b[^\n]*$/m.exec(text);
  if (!sharedHeading) {
    return [{ line: 1, message: 'verify skill is missing its shared note-rule section' }];
  }

  const followingText = text.slice(sharedHeading.index + sharedHeading[0].length);
  const nextHeadingOffset = followingText.search(/^### /m);
  const sharedSection =
    nextHeadingOffset === -1 ? followingText : followingText.slice(0, nextHeadingOffset);
  const missingCommands = SHARED_NOTE_RULE_COMMANDS.filter(
    (command) => !sharedSection.includes(command),
  );

  if (missingCommands.length === 0) return [];

  const line = text.slice(0, sharedHeading.index).split('\n').length;
  return [
    {
      line,
      message: `shared note-rule verification chain is missing: ${missingCommands.join(', ')}`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Skill-directory shape
// ---------------------------------------------------------------------------

// A skill directory that git carries must resolve from git's contents alone.
// `isTracked`/`pathExists` are injected so this is unit-testable and so the
// gate can be reasoned about without a repo.
export function validateSkillLinks(entries, { isTracked, resolveLink, targetIsTracked }) {
  const violations = [];

  for (const entry of entries) {
    if (!entry.isSymlink) continue;
    if (!isTracked(entry.rel)) continue; // a local, gitignored link — fine

    const target = resolveLink(entry.rel);
    if (target === null) {
      violations.push({
        line: 1,
        message:
          `${entry.rel} — tracked symlink whose target does not exist. ` +
          `A committed skill link must resolve in a fresh clone; this one does not.`,
      });
      continue;
    }
    if (!targetIsTracked(target)) {
      violations.push({
        line: 1,
        message:
          `${entry.rel} → ${target} — tracked symlink into untracked/gitignored content. ` +
          `It resolves only in a checkout that happens to have that path, and dangles in ` +
          `every fresh clone and git worktree. Commit the skill for real, or drop the link ` +
          `and create it locally with \`just skills-link\` (which keeps it gitignored).`,
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Instruction-surface discovery
// ---------------------------------------------------------------------------

function findFiles(dir, matches, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Repo-local worktrees and nested repositories are separate checkouts
      // with their own instruction surfaces. Scanning through their `.git`
      // marker would validate unrelated branch state as if it belonged here.
      if (fs.existsSync(path.join(full, '.git'))) continue;
      findFiles(full, matches, out);
    } else if (matches(full)) {
      out.push(full);
    }
  }
  return out;
}

export function collectInstructionFiles(root) {
  const files = [];

  for (const name of ['README.md', 'CONTRIBUTING.md']) {
    const full = path.join(root, name);
    if (fs.existsSync(full)) files.push(full);
  }

  files.push(...findFiles(root, (full) => path.basename(full) === 'AGENTS.md'));

  const skillsDir = path.join(root, '.claude', 'skills');
  if (fs.existsSync(skillsDir)) {
    files.push(
      ...findFiles(skillsDir, (full) => {
        if (!full.endsWith('.md')) return false;
        const rel = path.relative(skillsDir, full).split(path.sep);
        return rel[rel.length - 1] === 'SKILL.md' || rel.includes('references');
      }),
    );
  }

  // Subagent definitions are instruction surfaces too: .claude/agents/app-qa.md
  // tells an agent how to drive the REAL apps, and it was invisible to this gate
  // while check-qa-input-safety already scanned it. A stale `just` recipe or a
  // broken path there sends a subagent down the same dead end as one in a
  // SKILL.md (pc_4cdae245beda, filed as a blocker).
  const agentsDir = path.join(root, '.claude', 'agents');
  if (fs.existsSync(agentsDir)) {
    files.push(...findFiles(agentsDir, (full) => full.endsWith('.md')));
  }

  const workflowsDir = path.join(root, '.claude', 'workflows');
  if (fs.existsSync(workflowsDir)) {
    for (const name of fs.readdirSync(workflowsDir)) {
      if (name.endsWith('.js')) files.push(path.join(workflowsDir, name));
    }
  }

  return files;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

// `git check-ignore` is the source of truth for "this path is expected to be
// absent from a fresh checkout" (generated/output dirs, gitignored configs) —
// reusing it avoids re-implementing .gitignore glob matching, and every CI
// image that can run this checker also has git. A directory-only pattern
// (e.g. `Sources/Generated/`) only matches when git can tell the query is a
// directory; a never-built generated dir doesn't exist yet to stat, so also
// try with a trailing slash appended.
function isGitIgnored(repoRelativeTarget) {
  const asFile = spawnSync('git', ['check-ignore', '-q', repoRelativeTarget], { cwd: ROOT });
  if (asFile.status === 0) return true;
  const asDir = spawnSync('git', ['check-ignore', '-q', `${repoRelativeTarget}/`], { cwd: ROOT });
  return asDir.status === 0;
}

// Every skill's root directory (the folder directly containing SKILL.md),
// for the cross-skill "the `/other-skill` skill's `references/x.md`"
// fallback below.
function listSkillRoots() {
  const skillsDir = path.join(ROOT, '.claude', 'skills');
  if (!fs.existsSync(skillsDir)) return [];
  return fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(skillsDir, entry.name));
}

// A referenced path may be root-relative (the documented convention for
// `src/`, `apps/`, etc.), relative to the file that mentions it (a skill
// pointing at its own `references/` sibling, including a file already
// inside `references/` pointing at another via the skill-root-relative
// `references/x.md` form), a bare sub-path shown under a top-level
// directory named earlier in an ASCII directory-tree diagram (e.g.
// `lib/rules.ts` meaning `src/lib/rules.ts`), or a cross-skill mention
// (e.g. AGENTS.md pointing at "the `/verify` skill's `references/ios.md`").
// Try all before calling a reference broken.
function makePathExists(fromDir) {
  const skillRoots = listSkillRoots();
  return (target) => {
    if (fs.existsSync(path.join(ROOT, target)) || isGitIgnored(target)) return true;

    if (fromDir) {
      const relativeToRoot = path.relative(ROOT, path.join(fromDir, target));
      if (fs.existsSync(path.join(fromDir, target)) || isGitIgnored(relativeToRoot)) return true;
    }

    if (KNOWN_PATH_PREFIXES.some((prefix) => fs.existsSync(path.join(ROOT, prefix + target))))
      return true;

    return skillRoots.some((skillRoot) => fs.existsSync(path.join(skillRoot, target)));
  };
}

// Entries directly under .claude/skills/, with the one bit readdir() gives us
// that the rest of this file throws away: whether each is a symlink.
function listSkillEntries() {
  const skillsDir = path.join(ROOT, '.claude', 'skills');
  if (!fs.existsSync(skillsDir)) return [];
  return fs.readdirSync(skillsDir, { withFileTypes: true }).map((entry) => ({
    rel: `.claude/skills/${entry.name}`,
    isSymlink: entry.isSymbolicLink(),
  }));
}

function isTrackedByGit(repoRelativePath) {
  const result = spawnSync('git', ['ls-files', '--error-unmatch', '--', repoRelativePath], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  return result.status === 0;
}

// The resolved target as a repo-relative path, or null when it does not exist.
// A target outside the repo can never be tracked, so it is returned as-is and
// fails the tracked check with its real path in the message.
function resolveSkillLink(repoRelativePath) {
  const abs = path.join(ROOT, repoRelativePath);
  if (!fs.existsSync(abs)) {
    return null;
  }
  const real = fs.realpathSync(abs);
  const rel = path.relative(ROOT, real);
  return rel.startsWith('..') ? real : rel.replaceAll(path.sep, '/');
}

function main() {
  const files = collectInstructionFiles(ROOT);
  const justRecipes = parseJustRecipes(fs.readFileSync(path.join(ROOT, 'justfile'), 'utf8'));
  const pnpmScripts = parsePackageScripts(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  let totalRefs = 0;
  const allViolations = [];

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const refs = extractReferences(text);
    totalRefs += refs.length;
    const rel = path.relative(ROOT, file);
    const pathExists = makePathExists(path.dirname(file));
    for (const violation of validateReferences(refs, { justRecipes, pnpmScripts, pathExists })) {
      allViolations.push({ file: rel, ...violation });
    }
    for (const violation of validateRequiredVerificationChains(rel, text)) {
      allViolations.push({ file: rel, ...violation });
    }
  }

  const skillEntries = listSkillEntries();
  for (const violation of validateSkillLinks(skillEntries, {
    isTracked: isTrackedByGit,
    resolveLink: resolveSkillLink,
    targetIsTracked: isTrackedByGit,
  })) {
    allViolations.push({ file: '.claude/skills', ...violation });
  }

  if (allViolations.length > 0) {
    console.error('Agent-docs self-validation gate FAILED:\n');
    for (const violation of allViolations) {
      console.error(`  ${violation.file}:${violation.line}  ${violation.message}`);
    }
    console.error(
      `\n${allViolations.length} broken reference(s) across ${files.length} instruction file(s).`,
    );
    process.exit(1);
  }

  console.log(
    `Agent-docs gate OK — ${files.length} instruction file(s), ${totalRefs} reference(s) checked ` +
      `(just/pnpm run/paths), ${skillEntries.length} skill entr(ies) checked for tracked ` +
      `dangling links, 0 broken.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
