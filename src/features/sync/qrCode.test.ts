import { describe, expect, it } from 'vitest';

import { qrCodeDrawing } from './qrCode';

/** A payload the shape Rust actually produces (hosted/pairing.rs `Payload`). */
const PAIRING_PAYLOAD = JSON.stringify({
  futo_notes_pairing: 1,
  id: '01JBXYZABCDEF0123456789ABCD',
  public_key: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc',
  device_name: 'Kitchen laptop',
  platform: 'desktop',
});

describe('drawing a pairing code', () => {
  it('turns a real pairing payload into a square grid with modules in it', () => {
    const { size, path } = qrCodeDrawing(PAIRING_PAYLOAD);

    // A payload this long needs a mid-range QR version; the exact one is the
    // encoder's business, but it is always square and always bigger than the
    // 8-square quiet border on its own.
    expect(size).toBeGreaterThan(20);
    expect(path).toMatch(/^M\d+ \d+h1v1h-1z/);
    expect(path.split('z').length - 1).toBeGreaterThan(100);
  });

  it('leaves the quiet border a scanner needs, so nothing is drawn in it', () => {
    const { size, path } = qrCodeDrawing(PAIRING_PAYLOAD);
    const boxes = [...path.matchAll(/M(\d+) (\d+)h/g)].map(([, x, y]) => ({
      x: Number(x),
      y: Number(y),
    }));

    const minimum = Math.min(...boxes.map((box) => Math.min(box.x, box.y)));
    const maximum = Math.max(...boxes.map((box) => Math.max(box.x, box.y)));
    expect(minimum).toBe(4);
    expect(maximum).toBe(size - 5);
  });

  it('draws the same payload the same way, so a re-render is not a new code', () => {
    expect(qrCodeDrawing(PAIRING_PAYLOAD)).toEqual(qrCodeDrawing(PAIRING_PAYLOAD));
  });

  it('draws a different payload differently', () => {
    expect(qrCodeDrawing(PAIRING_PAYLOAD).path).not.toEqual(
      qrCodeDrawing(PAIRING_PAYLOAD.replace('Kitchen laptop', 'Studio iMac')).path,
    );
  });
});
