import { describe, it, expect } from 'vitest';
import { supportsClaudeAgent1mContext } from '../claudeAgentExtendedContext';

describe('supportsClaudeAgent1mContext', () => {
  it('matches the eligible Sonnet 4.5 / Opus 4.5–4.8 set', () => {
    expect(supportsClaudeAgent1mContext('claude-sonnet-4-5')).toBe(true);
    expect(supportsClaudeAgent1mContext('claude-opus-4-5')).toBe(true);
    expect(supportsClaudeAgent1mContext('claude-opus-4-6')).toBe(true);
    expect(supportsClaudeAgent1mContext('claude-opus-4-7')).toBe(true);
    expect(supportsClaudeAgent1mContext('claude-opus-4-8')).toBe(true);
  });

  it('matches dated and anthropic.-prefixed variants', () => {
    expect(supportsClaudeAgent1mContext('claude-sonnet-4-5-20250929')).toBe(true);
    expect(supportsClaudeAgent1mContext('anthropic.claude-opus-4-8')).toBe(true);
  });

  it('excludes models that run at 1M natively or do not accept the suffix', () => {
    // Sonnet 4.6 / Sonnet 4 are 1M-native in the Agent SDK — no suffix.
    expect(supportsClaudeAgent1mContext('claude-sonnet-4-6')).toBe(false);
    expect(supportsClaudeAgent1mContext('claude-sonnet-4')).toBe(false);
    // Opus 4 (4.0) and Haiku are not in the set.
    expect(supportsClaudeAgent1mContext('claude-opus-4')).toBe(false);
    expect(supportsClaudeAgent1mContext('claude-opus-4-0')).toBe(false);
    expect(supportsClaudeAgent1mContext('claude-haiku-4-5')).toBe(false);
    expect(supportsClaudeAgent1mContext('claude-3-7-sonnet')).toBe(false);
    // Fable runs at its native 200K window — no `[1m]` suffix.
    expect(supportsClaudeAgent1mContext('claude-fable-5')).toBe(false);
  });
});
