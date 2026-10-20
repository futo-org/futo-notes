// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { needsSelectionNet } from './mobileBlockDnd';
import { s, UA } from './__fixtures__/mobileBlockDndView';

describe('needsSelectionNet', () => {
  it.each([
    ['iOS WKWebView', { userAgent: UA.iosWebView }, true],
    ['iOS Chrome (CriOS is WebKit)', { userAgent: UA.iosChrome }, true],
    ['iOS Edge', { userAgent: UA.iosEdge }, true],
    ['iOS Firefox', { userAgent: UA.iosFirefox }, true],
    ['desktop Safari', { userAgent: UA.safariDesktop }, true],
    ['iPad in desktop mode (Safari UA)', { userAgent: UA.ipadSafariDesktopMode }, true],
    ['WebKitGTK', { userAgent: UA.webKitGtk }, true],
    ['Firefox desktop', { userAgent: UA.firefoxDesktop }, true],
    ['Firefox Android', { userAgent: UA.firefoxAndroid }, true],
    ['an unknown engine', { userAgent: 'SomeBrowser/1.0' }, true],
    ['no navigator', undefined, true],
    // Chromium: no net, with or without `userAgentData` (WebView < 116 has none).
    ['Android WebView 90 (no userAgentData)', { userAgent: UA.androidWebView90 }, false],
    [
      'Android WebView 120',
      { userAgent: UA.androidWebView120, userAgentData: { mobile: true } },
      false,
    ],
    ['Chrome desktop', { userAgent: UA.chromeDesktop, userAgentData: {} }, false],
    ['Chrome desktop without userAgentData', { userAgent: UA.chromeDesktop }, false],
    ['userAgentData alone', { userAgentData: {} }, false],
  ] as const)('%s', (_name, nav, expected) => {
    expect(needsSelectionNet(nav)).toBe(expected);
  });
});
