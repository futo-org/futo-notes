import { describe, expect, it } from 'vitest';
import { preparePromptForModel } from '../../src/plugins/llm.js';

describe('preparePromptForModel', () => {
  it('prefixes /no_think when disableThinking is requested', () => {
    const prompt = preparePromptForModel({
      purpose: 'untitled-no-more-title',
      userPrompt: 'Suggest a title for this note',
      disableThinking: true,
    });

    expect(prompt.userPrompt.startsWith('/no_think\n')).toBe(true);
  });

  it('does not duplicate /no_think when already present', () => {
    const prompt = preparePromptForModel({
      purpose: 'untitled-no-more-title',
      userPrompt: '/no_think\nSuggest a title for this note',
      disableThinking: true,
    });

    expect(prompt.userPrompt).toBe('/no_think\nSuggest a title for this note');
  });
});
