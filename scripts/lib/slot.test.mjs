import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ENV_NAMES, PORT_BASES, envLines, portsFor, slotOf, webPort } from './slot.mjs';

const CLI = fileURLToPath(new URL('./slot.mjs', import.meta.url));
const runCli = (...args) => execFileSync('node', [CLI, ...args], { encoding: 'utf8' }).trim();

// Deliberate second implementation: a slot addresses already-claimed devices
// and running servers, so the value must never change.
function legacySlot(root) {
  return parseInt(createHash('md5').update(root).digest('hex').slice(0, 8), 16) % 50;
}

const ROOTS = [
  '/Users/mason/futo-notes',
  '/Users/mason/futo-notes/.claude/worktrees/mcp-perf-testing-issues-6e0198',
  '/home/mason/futo-notes',
  '/tmp/wt',
];

describe('slotOf', () => {
  it('matches the algorithm every previous copy used', () => {
    for (const root of ROOTS) {
      expect(slotOf(root)).toBe(legacySlot(root));
    }
  });

  it('is in range for every root', () => {
    for (const root of ROOTS) {
      expect(slotOf(root)).toBeGreaterThanOrEqual(0);
      expect(slotOf(root)).toBeLessThan(50);
    }
  });

  it('pins known roots to fixed slots', () => {
    expect(slotOf('/Users/mason/futo-notes')).toBe(13);
    expect(slotOf('/tmp/wt')).toBe(27);
    expect(slotOf('/')).toBe(2);
  });
});

describe('portsFor', () => {
  it('offsets every base by the slot', () => {
    const root = ROOTS[0];
    const slot = slotOf(root);
    expect(portsFor(root)).toEqual({
      tauriVite: PORT_BASES.tauriVite + slot,
      web: PORT_BASES.web + slot,
      sync: PORT_BASES.sync + slot,
      cdp: PORT_BASES.cdp + slot,
    });
  });

  // /verify's SKILL.md publishes these ranges, so the literals are the contract.
  it('pins the published port bases', () => {
    expect(PORT_BASES).toEqual({ tauriVite: 5200, web: 5250, sync: 3100, cdp: 9330 });
  });

  it('keeps the tauri-dev and web ranges disjoint so both can run at once', () => {
    const slots = Array.from({ length: 50 }, (_, i) => i);
    const tauri = slots.map((s) => PORT_BASES.tauriVite + s);
    const web = slots.map((s) => PORT_BASES.web + s);
    expect(tauri.filter((p) => web.includes(p))).toEqual([]);
    expect(Math.max(...tauri)).toBe(5249);
    expect(Math.max(...web)).toBe(5299);
  });

  it('gives different worktrees different ports', () => {
    const a = portsFor(ROOTS[0]).web;
    const b = portsFor(ROOTS[1]).web;
    expect(a).not.toBe(b);
  });
});

// The justfile and skills call these strings; renaming one breaks them with
// nothing else red.
describe('CLI selectors', () => {
  it('prints the slot of the repo it runs in', () => {
    const { root } = JSON.parse(runCli('json'));
    expect(runCli('slot')).toBe(String(slotOf(root)));
  });

  it('exposes one selector per port, each matching portsFor', () => {
    const root = JSON.parse(runCli('json')).root;
    for (const name of Object.keys(PORT_BASES)) {
      expect(Number(runCli(name))).toBe(portsFor(root)[name]);
    }
  });

  it('defaults to json carrying root, slot and every port', () => {
    const out = JSON.parse(runCli());
    expect(Object.keys(out.ports).sort()).toEqual(Object.keys(PORT_BASES).sort());
    expect(out.slot).toBe(slotOf(out.root));
  });

  it('emits eval-able exports for every port', () => {
    const root = JSON.parse(runCli('json')).root;
    const lines = runCli('env').split('\n');
    expect(lines).toContain(`export SLOT=${slotOf(root)}`);
    for (const [key, envName] of Object.entries(ENV_NAMES)) {
      expect(lines).toContain(`export ${envName}=${portsFor(root)[key]}`);
    }
    expect(envLines(root)).toBe(runCli('env'));
  });

  it('every port has a shell name, so `env` can never silently drop one', () => {
    expect(Object.keys(ENV_NAMES).sort()).toEqual(Object.keys(PORT_BASES).sort());
  });

  it('pins the published shell variable names', () => {
    expect(ENV_NAMES).toEqual({
      tauriVite: 'VITE_PORT',
      web: 'WEB_VITE_PORT',
      sync: 'SYNC_PORT',
      cdp: 'CDP_PORT',
    });
  });

  it('fails loudly on an unknown selector', () => {
    expect(() => runCli('nope')).toThrow();
  });
});

describe('webPort', () => {
  it('derives from the slot by default', () => {
    delete process.env.FUTO_DEV_PORT;
    expect(webPort(ROOTS[0])).toBe(PORT_BASES.web + slotOf(ROOTS[0]));
  });

  it('gives the same port from an unrelated cwd', () => {
    delete process.env.FUTO_DEV_PORT;
    const fromRoot = execFileSync(
      'node',
      ['-e', `import(${JSON.stringify(CLI)}).then((m) => console.log(m.webPort()))`],
      { cwd: '/', encoding: 'utf8' },
    ).trim();
    expect(Number(fromRoot)).toBe(Number(runCli('web')));
  });

  it('honors FUTO_DEV_PORT so a one-off run can pin the port', () => {
    process.env.FUTO_DEV_PORT = '5173';
    try {
      expect(webPort(ROOTS[0])).toBe(5173);
    } finally {
      delete process.env.FUTO_DEV_PORT;
    }
  });

  // Must fail here, not reach vite as `port: NaN` under strictPort.
  it.each(['foo', '', '0', '70000', '5173.5'])('rejects FUTO_DEV_PORT=%o', (value) => {
    process.env.FUTO_DEV_PORT = value;
    try {
      if (value === '') {
        expect(webPort(ROOTS[0])).toBe(PORT_BASES.web + slotOf(ROOTS[0]));
      } else {
        expect(() => webPort(ROOTS[0])).toThrow(/FUTO_DEV_PORT/);
      }
    } finally {
      delete process.env.FUTO_DEV_PORT;
    }
  });
});
