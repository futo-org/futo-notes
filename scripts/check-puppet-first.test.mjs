import { describe, expect, it } from 'vitest';

import { scanText } from './check-puppet-first.mjs';

const ruleIds = (text) => scanText(text).map((hit) => hit.rule);

describe('check-puppet-first scanText', () => {
  it('fails every outside driver, the MCP bridge under its qualified name included', () => {
    expect(
      ruleIds(
        [
          'xdotool key ctrl+b',
          'ydotool click 0xC0',
          'wtype hello',
          'idb ui tap 10 20',
          'adb exec-out input tap 10 20',
          'call mcp__tauri__webview_interact with the ref',
        ].join('\n'),
      ),
    ).toEqual(['os-input', 'os-input', 'os-input', 'idb-input', 'adb-input', 'bridge-input']);
  });

  it('leaves prose that names an OS input tool to forbid it', () => {
    expect(
      scanText('- **OS-level input** (`xdotool`, `wtype`) reaches the focused window'),
    ).toEqual([]);
  });

  it('allows a marked section up to the next heading of any level, not past it', () => {
    const text = [
      '### Allowed',
      '<!-- check-puppet-first: the share sheet -->',
      '```bash',
      '# a shell comment, not a heading',
      'axe tap --id share',
      '```',
      '### Not allowed',
      'axe tap --id bold',
    ].join('\n');
    expect(scanText(text)).toEqual([{ line: 8, rule: 'axe-input', text: 'axe tap --id bold' }]);
  });
});
