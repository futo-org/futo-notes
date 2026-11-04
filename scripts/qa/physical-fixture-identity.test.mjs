// Public subprocess contract: real CLI parsing, source provenance and signed
// products, with only external Apple commands replaced by a recording provider.
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import { expect, it, vi } from 'vitest';
import { sandbox } from '../ios-capture-fixture-signed-test-data.mjs';
import { sourceProvenance } from '../ios-capture-fixture.mjs';
import { buildSignedFixture } from '../ios-capture-fixture-signed.mjs';
import { setupBuild } from './physical-fixture-ios-test-data.mjs';
import { runPhysicalFixtureCLI } from './physical-fixture-cli.mjs';

const A = 'A1111111-1111-4111-8111-111111111111';
const B = 'B1111111-1111-4111-8111-111111111111';

// Subprocess-driven file: its identity CLI child runs under spawnSync's own 30s bound. The 5s default went red on loaded
// CI runners (audit 2026-11), so the file timeout is set to 40s to cover that bound.
vi.setConfig({ testTimeout: 40_000 });

it('actual identity CLI binds the requested UUID before any OS verification', () => {
  const t = sandbox();
  const repo = fileURLToPath(new URL('../..', import.meta.url));
  cpSync(join(repo, 'scripts'), join(t.root, 'scripts'), { recursive: true });
  writeFileSync(
    join(t.root, '.gitignore'),
    readFileSync(join(t.root, '.gitignore'), 'utf8') + 'node_modules\n',
  );
  symlinkSync(join(repo, 'node_modules'), join(t.root, 'node_modules'));
  execFileSync('git', ['-C', t.root, 'add', '.']);
  execFileSync('git', [
    '-C',
    t.root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'CLI source',
  ]);
  const source = sourceProvenance(t.root);
  Object.assign(t.selected, {
    sourceSHA: source.sourceSHA,
    sourceFingerprint: source.sourceFingerprint,
  });
  const target = {
    __xctestrun_metadata__: { FormatVersion: 1 },
    Editor294FixtureUITests: {
      IsUITestBundle: true,
      UITargetAppBundleIdentifier: 'org.futo.fixture.editor294',
      TestHostBundleIdentifier: 'org.futo.fixture.editor294.uitests.xctrunner',
      TestHostPath: '__TESTROOT__/Debug-iphoneos/Editor294FixtureUITests-Runner.app',
      UITargetAppPath: '__TESTROOT__/Debug-iphoneos/Editor294Fixture.app',
      TestBundlePath: '__TESTHOST__/PlugIns/Editor294FixtureUITests.xctest',
    },
  };
  for (const runID of [A, B]) {
    t.selected.runID = runID;
    buildSignedFixture(t.root, t.selected, {
      command(program, args, options) {
        const result = t.command(program, args, options);
        if (program === 'xcodebuild')
          writeFileSync(
            join(
              t.root,
              'apps/ios/FixtureCapture/.build-signed',
              runID,
              'DerivedData/Build/Products/Editor294Fixture_iphoneos.xctestrun',
            ),
            JSON.stringify(target),
          );
        return result;
      },
    });
  }
  const provider = join(t.root, 'run/fake-os.mjs');
  const calls = join(t.root, 'run/os-calls.jsonl');
  mkdirSync(join(t.root, 'run'), { mode: 0o700 });
  writeFileSync(
    provider,
    `
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
cp.spawnSync=(program,args,options)=>{
  appendFileSync(${JSON.stringify(calls)},JSON.stringify({program,args})+'\\n');
  let stdout='';
  if(program==='plutil')stdout=readFileSync(args.at(-1),'utf8');
  else if(program==='/usr/bin/plutil')stdout=options.input;
  else if(program==='/usr/bin/security')stdout='fake CMS';
  else if(program==='/usr/bin/python3')stdout=${JSON.stringify(t.command('/usr/bin/python3', []))};
  else if(program==='/usr/bin/codesign'){
    if(args.includes('--extract-certificates'))return {status:1,stdout:'',stderr:args[2]+': No such file or directory'};
    const extraction=args.find(arg=>arg.startsWith('--extract-certificates='));
    if(extraction)writeFileSync(extraction.slice('--extract-certificates='.length)+'0','abc',{mode:0o600});
    if(args.includes('--entitlements')){
      const info=JSON.parse(readFileSync(join(args.at(-1),'Info.plist')));
      stdout=JSON.stringify({'application-identifier':'TESTTEAM01.'+info.CFBundleIdentifier,'com.apple.developer.team-identifier':'TESTTEAM01','get-task-allow':true});
    }
  }else throw Error('UNEXPECTED OS: '+program);
  return {status:0,stdout,stderr:''};
};syncBuiltinESMExports();`,
  );
  const invoke = () =>
    spawnSync(
      process.execPath,
      [
        '--import',
        provider,
        join(t.root, 'scripts/qa/physical-fixture-ios.mjs'),
        '--identity',
        '--run',
        A,
      ],
      { encoding: 'utf8', timeout: 30000 },
    );
  const honest = invoke();
  expect(honest.status, honest.stderr).toBe(0);
  expect(JSON.parse(honest.stdout).signing).toEqual({
    status: 'independently-verified-signed-output',
    runID: A,
  });
  expect(readFileSync(calls, 'utf8')).toContain('/usr/bin/codesign');
  const output = join(t.root, 'apps/ios/FixtureCapture/.build-signed');
  // A still has complete valid products and receipt; only its selector is B.
  writeFileSync(join(output, A, 'selection.json'), readFileSync(join(output, B, 'selection.json')));
  writeFileSync(calls, '');
  const redirected = invoke();
  expect(redirected.status, redirected.stdout).toBe(1);
  expect(redirected.stderr).toContain('Signed fixture selection differs from requested run');
  expect(readFileSync(calls, 'utf8')).toBe('');
  for (const invalid of [null, false, 1, [], {}, { runID: [A] }, { runID: A.toLowerCase() }]) {
    writeFileSync(join(output, A, 'selection.json'), JSON.stringify(invalid));
    writeFileSync(calls, '');
    const refused = invoke();
    expect(refused.status, JSON.stringify(invalid)).toBe(1);
    expect(refused.stderr).toContain('Signed fixture selection differs from requested run');
    expect(readFileSync(calls, 'utf8')).toBe('');
  }
});

it('public executor refuses a different selection UUID before any OS provider', () => {
  const t = setupBuild();
  const path = join(t.signedOutput, 'selection.json');
  const selection = JSON.parse(readFileSync(path));
  selection.runID = B;
  writeFileSync(path, JSON.stringify(selection));
  expect(() => t.executor.inspectBuild(t.plan)).toThrow('Signed fixture receipt identity differs');
  expect(t.commands).toEqual([]);
});

it.each(['read', 'close'])(
  '%s refuses a retained manifest redirect before the executor',
  async (operation) => {
    const t = sandbox();
    const scratch = join(t.root, 'run');
    mkdirSync(scratch, { mode: 0o700 });
    mkdirSync(join(scratch, A), { mode: 0o700 });
    writeFileSync(join(scratch, A, 'manifest.json'), JSON.stringify({ runID: B }), { mode: 0o600 });
    let calls = 0;
    await expect(
      runPhysicalFixtureCLI([operation, '--run', A], {
        root: t.root,
        scratch,
        executor: new Proxy(
          {},
          {
            get() {
              calls++;
              throw new Error('UNEXPECTED EXECUTOR');
            },
          },
        ),
      }),
    ).rejects.toThrow('Retained manifest differs from requested run');
    expect(calls).toBe(0);
  },
);
