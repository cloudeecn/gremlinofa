import { describe, it, expect } from 'vitest';
import { supportsClaudeAgent1mContext } from '../claudeAgentExtendedContext';

describe('supportsClaudeAgent1mContext', () => {
  it('matches Opus 4.6, which Claude Code runs at 200K without the suffix', () => {
    expect(supportsClaudeAgent1mContext('claude-opus-4-6')).toBe(true);
  });

  it('matches dated and anthropic.-prefixed variants', () => {
    expect(supportsClaudeAgent1mContext('claude-opus-4-6-20260101')).toBe(true);
    expect(supportsClaudeAgent1mContext('anthropic.claude-opus-4-6')).toBe(true);
  });

  it('leaves Sonnet 4.6 at 200K: its 1M variant needs usage credits on every plan', () => {
    expect(supportsClaudeAgent1mContext('claude-sonnet-4-6')).toBe(false);
    expect(supportsClaudeAgent1mContext('claude-sonnet-4-6-20260101')).toBe(false);
  });

  it('excludes natively-1M models', () => {
    for (const id of [
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-opus-5-5',
      'claude-sonnet-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'claude-fable-5-2',
    ]) {
      expect(supportsClaudeAgent1mContext(id), id).toBe(false);
    }
  });

  it('excludes 200K-only models the suffix is not documented for', () => {
    for (const id of ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5']) {
      expect(supportsClaudeAgent1mContext(id), id).toBe(false);
    }
  });
});
