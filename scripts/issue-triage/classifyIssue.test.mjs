import { describe, expect, it } from 'vitest';

import { classifyIssue } from './classifyIssue.mjs';

describe('classifyIssue', () => {
  it('classifies the community "Feature Request" prefix as a feature', () => {
    expect(classifyIssue({ title: 'Feature Request: Pinned notes' }).kind).toBe('feature');
    expect(classifyIssue({ title: 'Feature Request (Android): Make note option' }).kind).toBe(
      'feature',
    );
  });

  it('lets the feature-request prefix win over bug words in the body', () => {
    const result = classifyIssue({
      title: 'Feature Request: dark mode',
      body: 'the current light mode is broken and crashes my eyes',
    });
    expect(result.kind).toBe('feature');
  });

  it('classifies wrong-behavior reports as bugs', () => {
    expect(
      classifyIssue({ title: 'Android app "bug": Black text against the dark mode' }).kind,
    ).toBe('bug');
    expect(classifyIssue({ title: 'App crashes on launch' }).kind).toBe('bug');
    expect(classifyIssue({ title: 'Sync', body: "search doesn't work anymore" }).kind).toBe('bug');
  });

  it('does not fire bug terms on substrings', () => {
    // "debugging" contains "bug", "terror" contains "error" — word boundaries
    // must keep these out of the bug bucket.
    expect(classifyIssue({ title: 'Notes about debugging workflow' }).kind).toBe('other');
    expect(classifyIssue({ title: 'A tale of terror and adventure' }).kind).toBe('other');
  });

  it('classifies down to other when there is no clear signal', () => {
    expect(classifyIssue({ title: 'Ability to rename & move folders' }).kind).toBe('other');
    expect(classifyIssue({ title: 'How do I export my notes?' }).kind).toBe('other');
  });

  it('tolerates missing title and body', () => {
    expect(classifyIssue({}).kind).toBe('other');
  });
});
