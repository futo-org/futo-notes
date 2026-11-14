import { afterEach, expect, it, vi } from 'vitest';
import { AndroidNativeEditorClient } from './editor-client.mjs';

const state = {
  editor: { ready: true, source: '**bold**\r\n🌲尾', display: 'bold\n🌲尾', truncated: false },
};
function client() {
  const fetch = vi.fn(async () => ({ ok: true, json: async () => state }));
  vi.stubGlobal('fetch', fetch);
  const device = { adb: vi.fn() };
  return {
    client: new AndroidNativeEditorClient({ name: 'native', repoRoot: process.cwd(), device }),
    fetch,
    device,
  };
}
afterEach(() => vi.unstubAllGlobals());

it('reads exact Rust source through the native listener rather than rendered text', async () => {
  const rig = client();
  expect(await rig.client.readOpenEditorContent()).toBe('**bold**\r\n🌲尾');
  expect(rig.device.adb.mock.calls[0][0]).toEqual([
    'forward',
    expect.stringMatching(/^tcp:\d+$/),
    'localabstract:futo-puppet',
  ]);
});

it('locates a native caret in UTF-16 display units rather than Markdown source units', async () => {
  const rig = client();
  await rig.client.placeCaretAtStartOf('尾');
  const requests = rig.fetch.mock.calls.map(([url, options]) => ({
    path: new URL(url).pathname,
    args: JSON.parse(options.body),
  }));
  expect(requests).toEqual([
    { path: '/state', args: {} },
    { path: '/do/Select', args: { from: 7, to: 7 } },
  ]);
});

it('configures sync through the native control without retyping a focused URL field', async () => {
  const rig = client();
  rig.client.disconnectSync = vi.fn(async () => {});
  rig.device.screen = () => ({ has: (label) => label === 'Disconnect' });
  rig.device.waitFor = async (_description, _timeout, predicate) => {
    expect(await predicate()).toBe(true);
  };
  await rig.client.connectSync('http://127.0.0.1:3134/', 'fixture password');
  const [url, options] = rig.fetch.mock.calls[0];
  expect(new URL(url).pathname).toBe('/do/ConnectSync');
  expect(JSON.parse(options.body)).toEqual({
    url: 'http://10.0.2.2:3134/',
    password: 'fixture password',
  });
});
