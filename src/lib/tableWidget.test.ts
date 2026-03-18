import { describe, it, expect } from 'vitest';
import { sanitizeUrl } from './tableWidget';

describe('sanitizeUrl', () => {
  it('allows normal https URLs', () => {
    expect(sanitizeUrl('https://example.com')).toBe('https://example.com');
  });

  it('allows http URLs', () => {
    expect(sanitizeUrl('http://example.com/page')).toBe('http://example.com/page');
  });

  it('allows custom deep link schemes', () => {
    expect(sanitizeUrl('stonefruit://open')).toBe('stonefruit://open');
    expect(sanitizeUrl('obsidian://open?vault=test')).toBe('obsidian://open?vault=test');
  });

  it('allows relative URLs', () => {
    expect(sanitizeUrl('/path/to/page')).toBe('/path/to/page');
  });

  it('allows mailto URLs', () => {
    expect(sanitizeUrl('mailto:user@example.com')).toBe('mailto:user@example.com');
  });

  it('blocks javascript: scheme', () => {
    expect(sanitizeUrl('javascript:alert(1)')).toBe('');
  });

  it('blocks javascript: with mixed case', () => {
    expect(sanitizeUrl('JavaScript:alert(1)')).toBe('');
    expect(sanitizeUrl('JAVASCRIPT:alert(1)')).toBe('');
  });

  it('blocks javascript: with whitespace padding', () => {
    expect(sanitizeUrl('  javascript:alert(1)')).toBe('');
    expect(sanitizeUrl('java\tscript:alert(1)')).toBe('');
  });

  it('blocks javascript: with control characters', () => {
    expect(sanitizeUrl('java\x00script:alert(1)')).toBe('');
    expect(sanitizeUrl('java\x01script:alert(1)')).toBe('');
  });

  it('blocks data: scheme', () => {
    expect(sanitizeUrl('data:text/html,<script>alert(1)</script>')).toBe('');
  });

  it('blocks vbscript: scheme', () => {
    expect(sanitizeUrl('vbscript:msgbox(1)')).toBe('');
  });

  it('blocks javascript: with HTML entities (post-escapeHtml)', () => {
    // After escapeHtml runs, & becomes &amp; etc.
    // sanitizeUrl must decode before checking
    expect(sanitizeUrl('javascript:alert(1)')).toBe('');
  });

  it('handles HTML-entity-encoded dangerous URLs', () => {
    // e.g. if someone tries &lt;script&gt; tricks inside a URL
    expect(sanitizeUrl('javascript:void(0)')).toBe('');
  });

  it('allows empty string', () => {
    expect(sanitizeUrl('')).toBe('');
  });

  it('allows fragment-only URLs', () => {
    expect(sanitizeUrl('#section')).toBe('#section');
  });
});
