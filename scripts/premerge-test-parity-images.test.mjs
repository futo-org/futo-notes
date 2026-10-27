import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ROOT,
  gitlabPipeline,
  cirrusTasks,
  topLevelBlock,
} from './premerge-test-parity.helpers.mjs';

describe('pre-merge CI routing contracts: container images and Node', () => {
  it('limits the pre-baked image to jobs that benefit from it', () => {
    const defaultBlock = topLevelBlock(gitlabPipeline, /^default:$/m);
    const testImageBlock = topLevelBlock(gitlabPipeline, /^\.ci-test-image:$/m);
    const rustWorkspaceJob = topLevelBlock(gitlabPipeline, /^test:rust:workspace:$/m);
    const syncJob = topLevelBlock(gitlabPipeline, /^test:cross-platform-sync:$/m);

    expect(defaultBlock).toMatch(/^\s+image: .*\/kitchensink@sha256:[a-f0-9]{64}$/m);
    expect(testImageBlock).toMatch(/^\s+name: .*\/ci\/test@sha256:[a-f0-9]{64}$/m);
    expect(testImageBlock).toContain('pull_policy: if-not-present');
    expect(rustWorkspaceJob).toContain('extends: .ci-test-image');
    expect(syncJob).toContain('extends: .ci-test-image');
  });

  it('runs every if-not-present image job on the one runner that allows its pull policy', () => {
    // Runner 55 (dind) only allows pull_policy always and refuses a job that
    // asks for if-not-present, so the image and an office-runner tag
    // ($LINUX_RUNNER_TAG = dind_fast, or futo_notes_serial) travel together.
    const androidImageBlock = topLevelBlock(gitlabPipeline, /^\.ci-android-image:$/m);
    expect(androidImageBlock).toMatch(/^\s+name: \$IMAGE_ANDROID$/m);
    expect(androidImageBlock).toContain('pull_policy: if-not-present');
    // The Android image is reached only through the template, so a new job
    // cannot pick it up with the slow `always` policy (or without the tag).
    expect(gitlabPipeline).not.toMatch(/^\s+image: \$IMAGE_ANDROID$/m);

    const jobs = gitlabPipeline.split(/(?=^[^ #\n][^\n]*:\n)/m);
    const imageJobs = jobs.filter((job) => /^ {2}extends: \.ci-(?:test|android)-image$/m.test(job));
    const names = imageJobs.map((job) => job.split('\n')[0]);
    for (const job of [
      'build:android-native:',
      'publish:android:',
      'test:rust:ffi-android:',
      'test:cross-platform-sync:android:',
    ]) {
      expect(names).toContain(job);
    }
    for (const job of imageJobs) {
      expect(job, job.split('\n')[0]).toMatch(
        /^ {2}tags:\n {4}- (?:\$LINUX_RUNNER_TAG|futo_notes_serial)$/m,
      );
    }
  });

  // Both of these fail far from the change: a broken COPY surfaces only when
  // someone runs the manual image rebuild, with `just check` silent until then.
  it('keeps the baked-Node images buildable', () => {
    const dockerignore = readFileSync(join(ROOT, '.dockerignore'), 'utf8');
    for (const file of ['ci/test.Dockerfile', 'ci/android.Dockerfile']) {
      const dockerfile = readFileSync(join(ROOT, file), 'utf8');
      expect(dockerfile).toContain('COPY .nvmrc');
      expect(dockerfile).toContain('COPY ci/install-fnm.sh');
      // Baking is what makes every job's `fnm use` an offline no-op. Matched as
      // a command, since the surrounding comment also names it.
      expect(dockerfile).toMatch(/^\s+cd \/tmp && fnm install /m);
      // A job that never calls `fnm use` must still get .nvmrc's Node, not the
      // base image's default.
      expect(dockerfile).toMatch(/^ENV PATH=\$FNM_DIR\/aliases\/default\/bin:/m);
    }
    // .dockerignore denies everything by default, so both COPY sources resolve
    // only because they are re-included. `!ci/` with a trailing slash does NOT
    // match the directory — it silently drops the file and the image build dies
    // with "not found", so assert the exact forms that work.
    expect(dockerignore).toMatch(/^!\.nvmrc$/m);
    expect(dockerignore).toMatch(/^!ci$/m);
    expect(dockerignore).toMatch(/^!ci\/install-fnm\.sh$/m);
  });

  // A floating tag lets a registry push swap the toolchain with no commit to
  // point at, so this asserts the whole set rather than the two it started with.
  it('pins every container image by digest', () => {
    const lines = gitlabPipeline.split('\n');
    const refs = [];
    lines.forEach((line, index) => {
      const scalar = /^\s*(?:image|-\s*name):\s*(\S+)\s*$/.exec(line);
      if (scalar) {
        refs.push(scalar[1]);
        return;
      }
      if (!/^\s*image:\s*$/.test(line)) return;
      for (let next = index + 1; next < lines.length && /^\s/.test(lines[next]); next += 1) {
        const named = /^\s*name:\s*(\S+)\s*$/.exec(lines[next]);
        if (named) {
          refs.push(named[1]);
          return;
        }
      }
    });

    expect(refs.length).toBeGreaterThan(10);
    const digest = /@sha256:[a-f0-9]{64}$/;
    expect(refs.filter((ref) => !digest.test(ref) && !/^\$IMAGE_[A-Z_]+$/.test(ref))).toEqual([]);

    const declared = [...gitlabPipeline.matchAll(/^\s+(IMAGE_[A-Z_]+):\s*(\S+)\s*$/gm)];
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter(([, , value]) => !digest.test(value)).map(([, name]) => name)).toEqual(
      [],
    );
    // Same image named twice must carry the SAME digest. The two Linux release
    // jobs both pin ubuntu:22.04 by inline literal (they hold the updater key, and
    // `variables:` loses to a run-pipeline variable), so bumping one and not the
    // other leaves both digest-pinned — and every check above still passes.
    const byName = new Map();
    for (const ref of refs.filter((r) => digest.test(r))) {
      const [name, sha] = ref.split('@sha256:');
      if (!byName.has(name)) byName.set(name, new Set());
      byName.get(name).add(sha);
    }
    expect([...byName].filter(([, shas]) => shas.size > 1).map(([name]) => name)).toEqual([]);

    // Referencing an undeclared $IMAGE_* resolves to empty, not to an error.
    const declaredNames = declared.map(([, name]) => name);
    refs
      .filter((ref) => ref.startsWith('$IMAGE_'))
      .forEach((ref) => expect(declaredNames).toContain(ref.slice(1)));
  });

  // .nvmrc holds the exact patch and every surface activates it through fnm.
  // Before fnm there were three capability tiers — nodesource and Homebrew could
  // express only a major line, and Windows pinned against a moving LTS pointer —
  // so "the pinned version" meant something different on each OS.
  it('activates every Node through fnm from .nvmrc', () => {
    const nvmrc = readFileSync(join(ROOT, '.nvmrc'), 'utf8').trim();
    expect(nvmrc).toMatch(/^\d+\.\d+\.\d+$/);
    const engines = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).engines;
    expect(engines.node).toContain(nvmrc);
    // fnm resolves engines.node when no .nvmrc exists (FNM_RESOLVE_ENGINES is on
    // by default), and it resolves a RANGE — so a bound-less `>=22` would let
    // --install-if-missing quietly fetch a newer major. Keep the upper bound.
    expect(engines.node).toMatch(/<\s*\d+/);

    // `fnm use` is both the pin and the verification: it exits non-zero rather
    // than falling back to another Node. Matched as a script line, because the
    // neighboring comments name the command too.
    const activates = /^\s+- fnm use --install-if-missing$/m;
    expect(topLevelBlock(gitlabPipeline, /^default:$/m)).toMatch(activates);

    // No surface may return to a major-only installer, which cannot honor the
    // patch in .nvmrc — that inability is why each of these was replaced.
    expect(cirrusTasks).not.toMatch(/node@\d/);
    expect(cirrusTasks).not.toContain('NODE_MAJOR');
    expect(gitlabPipeline).not.toMatch(/setup_\d+\.x/);
    expect(gitlabPipeline).not.toContain('NODE_MAJOR');
    expect(gitlabPipeline).not.toContain('nvm install');

    // Relational, not a magic count: every macOS task that installs fnm must
    // also activate it, so adding a task cannot drift and cannot break this for
    // no reason.
    const brews = cirrusTasks.match(/brew install fnm/g) ?? [];
    const activations = cirrusTasks.match(/fnm use --install-if-missing/g) ?? [];
    expect(brews.length).toBeGreaterThan(0);
    expect(activations).toHaveLength(brews.length);

    // The pairing above only counts tasks that DID install fnm, and the node@NN
    // check only catches a versioned formula — so a new task written
    // `brew install node` would satisfy every assertion while running an
    // unpinned Node, which is the exact drift this test exists to stop. Bind it
    // to the thing every such task needs instead: corepack.
    expect(cirrusTasks).not.toMatch(/brew install [^\n]*\bnode\b/);
    const cirrusScriptBlocks = cirrusTasks.split(/^ {2}[\w]+_script:$/m).slice(1);
    expect(cirrusScriptBlocks.length).toBeGreaterThan(0);
    for (const block of cirrusScriptBlocks) {
      if (!block.includes('corepack enable')) continue;
      expect(block).toContain('fnm use --install-if-missing');
    }

    // fnm itself is bootstrapped, never assumed. The shared base image is another
    // team's and has no fnm, and our own images only gain it on a manual rebuild,
    // so a surface that activates fnm without installing it first dies on
    // `fnm: command not found` (exit 127). Note `eval "$(fnm env)"` does NOT
    // catch this: eval of an empty string succeeds, so the failure lands one
    // line later.
    const installer = 'sh "$CI_PROJECT_DIR/ci/install-fnm.sh"';
    expect(topLevelBlock(gitlabPipeline, /^default:$/m)).toContain(installer);
    // `test:` gates every MR, so it must never be the job running whatever Node
    // the image happens to default to. It gets the pin by INHERITING the
    // `default:` block asserted above, which is only true while it declares no
    // before_script of its own — so that absence IS the guard, and it also
    // catches the `before_script: []` that would opt out silently. Should the
    // job ever need its own block again, that block has to bootstrap and
    // activate fnm itself.
    const testJob = topLevelBlock(gitlabPipeline, /^test:$/m);
    if (/^\s+before_script:/m.test(testJob)) {
      expect(testJob).toContain(installer);
      expect(testJob).toMatch(activates);
    }
    // Asserted directly, not just via the count below: build:linux-packages and
    // build:linux-appimage both use this anchor and both hold the updater key, and
    // deleting BOTH of its lines keeps the bootstrap/activation counts equal.
    const linuxAnchor = /before_script: &linux-before-script\n([\s\S]*?)\n  cache:/.exec(
      gitlabPipeline,
    )?.[1];
    expect(linuxAnchor).toBeTruthy();
    expect(linuxAnchor).toContain(installer);
    expect(linuxAnchor).toContain('fnm use --install-if-missing');

    const gitlabActivations = gitlabPipeline.match(/fnm use --install-if-missing/g) ?? [];
    const bootstraps = gitlabPipeline.match(/sh "\$CI_PROJECT_DIR\/ci\/install-fnm\.sh"/g) ?? [];
    expect(gitlabActivations.length).toBeGreaterThan(0);
    expect(bootstraps).toHaveLength(gitlabActivations.length);

    // One place for the pinned release, checksummed rather than piped into a
    // shell — the Linux release jobs that call it hold the updater key.
    const installScript = readFileSync(join(ROOT, 'ci/install-fnm.sh'), 'utf8');
    expect(installScript).toMatch(/^FNM_VERSION=v\d+\.\d+\.\d+$/m);
    // Anchored: `| sha256sum -c - || true` still contains the substring, on the
    // path whose whole justification is that its callers hold the updater key.
    expect(installScript).toMatch(/^echo "\$sha  \$tmp\/fnm\.zip" \| sha256sum -c -$/m);
    // A transient GitHub failure must not fail the job that gates every MR.
    expect(installScript).toContain('--retry');
    // Both architectures: a hardcoded x86-64 asset fails an arm64 build with a
    // bare `exit code: 133` and no diagnostic.
    expect(installScript).toMatch(/^FNM_SHA256_X86_64=[0-9a-f]{64}$/m);
    expect(installScript).toMatch(/^FNM_SHA256_AARCH64=[0-9a-f]{64}$/m);
    // And nowhere else, which is why this pin needs no drift-registry entry.
    expect(gitlabPipeline).not.toContain('fnm-linux.zip');
    for (const file of ['ci/test.Dockerfile', 'ci/android.Dockerfile']) {
      expect(readFileSync(join(ROOT, file), 'utf8')).not.toContain('fnm-linux.zip');
    }

    // Windows splits tool from version: win-install-deps.ps1 is scp'd to the VM
    // alone and runs BEFORE the clone, so .nvmrc does not exist there yet.
    // Resolving a version in that script reads a path that does not exist and
    // kills build:windows — invisible on MRs, where the job is manual and
    // allow_failure, and fatal at tag time when windows:sign never runs.
    const winDeps = readFileSync(join(ROOT, 'ci/win-install-deps.ps1'), 'utf8');
    const winBuild = readFileSync(join(ROOT, 'ci/win-build.ps1'), 'utf8');
    expect(winDeps).toContain('Schniz.fnm');
    expect(winDeps).not.toContain('OpenJS.NodeJS');
    expect(winDeps).not.toContain('NodeVersion');
    expect(winDeps).not.toContain('Join-Path $PSScriptRoot');
    expect(gitlabPipeline).not.toContain('-NodeVersion');

    // The version is resolved after the clone, and asserted after activation —
    // this VM produces the binary that gets Authenticode signed.
    const commandIndex = (pattern) => winBuild.search(pattern);
    const clonedAt = commandIndex(/^\s*Set-Location C:\\build\\futo-notes\s*$/m);
    const activatedAt = commandIndex(
      /^\s*Invoke-Step "Activating Node from \.nvmrc" \{ fnm use --install-if-missing \}\s*$/m,
    );
    const usesNodeAt = commandIndex(/^\s*node scripts\\desktop-version\.mjs \$Version\s*$/m);
    expect(clonedAt).toBeGreaterThan(-1);
    expect(activatedAt).toBeGreaterThan(clonedAt);
    expect(usesNodeAt).toBeGreaterThan(activatedAt);
    // The abort keyword, not its message: turning `throw` into `Write-Warning`
    // keeps the sentence and drops the guarantee.
    expect(winBuild).toMatch(/throw "Node \$expectedNode is pinned/);
    // Windows artifacts are NSIS only; MSI rejects non-numeric prerelease
    // identifiers even though the pipeline collects and signs only NSIS.
    expect(winBuild).toMatch(/cargo tauri build --bundles nsis/);

    // windows:sign is the ONE sanctioned exception: Node there only runs the
    // pinned @tauri-apps/cli, which is what actually determines the updater
    // signature, and that job holds the signing key (M23). Exactly one such
    // installer may exist, so a second one cannot arrive unnoticed.
    const distroNode = gitlabPipeline.match(/apt-get install -y[^\n]*\bnodejs\b[^\n]*/g) ?? [];
    expect(distroNode).toHaveLength(1);
    expect(gitlabPipeline).toMatch(/npx --yes @tauri-apps\/cli@\d+\.\d+\.\d+ signer sign/);
  });
});
