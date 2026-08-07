import { describe, it, expect } from 'vitest';
import {
  isAnthropicEffort,
  mapAnthropicEffort,
  mapReasoningEffort,
  REASONING_EFFORTS,
} from '../reasoningEffort';

describe('REASONING_EFFORTS', () => {
  it('contains all effort levels in order', () => {
    expect(REASONING_EFFORTS).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });
});

describe('mapReasoningEffort', () => {
  describe('with supported = [low, high]', () => {
    const supported = ['low', 'high'] as const;

    it('maps none to low (below range)', () => {
      expect(mapReasoningEffort('none', supported)).toBe('low');
    });

    it('maps minimal to low (below range)', () => {
      expect(mapReasoningEffort('minimal', supported)).toBe('low');
    });

    it('maps low to low (exact match)', () => {
      expect(mapReasoningEffort('low', supported)).toBe('low');
    });

    it('maps medium to low (between, maps to lower)', () => {
      expect(mapReasoningEffort('medium', supported)).toBe('low');
    });

    it('maps high to high (exact match)', () => {
      expect(mapReasoningEffort('high', supported)).toBe('high');
    });

    it('maps xhigh to high (above range)', () => {
      expect(mapReasoningEffort('xhigh', supported)).toBe('high');
    });
  });

  describe('with supported = [low, medium, high]', () => {
    const supported = ['low', 'medium', 'high'] as const;

    it('maps none to low', () => {
      expect(mapReasoningEffort('none', supported)).toBe('low');
    });

    it('maps minimal to low', () => {
      expect(mapReasoningEffort('minimal', supported)).toBe('low');
    });

    it('maps medium to medium (exact match)', () => {
      expect(mapReasoningEffort('medium', supported)).toBe('medium');
    });

    it('maps xhigh to high', () => {
      expect(mapReasoningEffort('xhigh', supported)).toBe('high');
    });
  });

  describe('with single supported value', () => {
    it('always returns that value', () => {
      const supported = ['medium'] as const;
      expect(mapReasoningEffort('none', supported)).toBe('medium');
      expect(mapReasoningEffort('low', supported)).toBe('medium');
      expect(mapReasoningEffort('medium', supported)).toBe('medium');
      expect(mapReasoningEffort('high', supported)).toBe('medium');
      expect(mapReasoningEffort('xhigh', supported)).toBe('medium');
    });
  });

  describe('with full range supported', () => {
    it('returns exact match for each level', () => {
      for (const effort of REASONING_EFFORTS) {
        expect(mapReasoningEffort(effort, REASONING_EFFORTS)).toBe(effort);
      }
    });
  });

  describe('with sparse supported values', () => {
    const supported = ['none', 'high'] as const;

    it('maps minimal to none (between, maps to lower)', () => {
      expect(mapReasoningEffort('minimal', supported)).toBe('none');
    });

    it('maps medium to none (between, maps to lower)', () => {
      expect(mapReasoningEffort('medium', supported)).toBe('none');
    });

    it('maps xhigh to high (above max)', () => {
      expect(mapReasoningEffort('xhigh', supported)).toBe('high');
    });
  });

  describe('edge cases', () => {
    it('throws on empty supported array', () => {
      expect(() => mapReasoningEffort('low', [])).toThrow('supportedEfforts must not be empty');
    });

    it('handles unsorted supported array', () => {
      const supported = ['high', 'low'] as const;
      expect(mapReasoningEffort('medium', supported)).toBe('low');
      expect(mapReasoningEffort('xhigh', supported)).toBe('high');
    });
  });

  describe('max level', () => {
    it('maps max to max when supported', () => {
      const supported = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
      expect(mapReasoningEffort('max', supported)).toBe('max');
    });

    it('maps max to highest supported when max not present', () => {
      expect(mapReasoningEffort('max', ['low', 'high'] as const)).toBe('high');
      expect(mapReasoningEffort('max', ['low', 'medium', 'xhigh'] as const)).toBe('xhigh');
    });

    it('maps xhigh to xhigh when xhigh present but max not', () => {
      expect(mapReasoningEffort('xhigh', ['low', 'medium', 'xhigh'] as const)).toBe('xhigh');
    });
  });
});

describe('isAnthropicEffort', () => {
  it('accepts the five levels Anthropic exposes', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(isAnthropicEffort(level)).toBe(true);
    }
  });

  it('rejects levels the Anthropic API has no value for', () => {
    expect(isAnthropicEffort('none')).toBe(false);
    expect(isAnthropicEffort('minimal')).toBe(false);
    expect(isAnthropicEffort(undefined)).toBe(false);
  });
});

describe('mapAnthropicEffort', () => {
  const ALL = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
  const NO_XHIGH = ['low', 'medium', 'high', 'max'] as const; // Opus 4.6 / Sonnet 4.6

  describe('omitting the parameter', () => {
    it('returns undefined when no effort was requested', () => {
      expect(mapAnthropicEffort(undefined, ALL)).toBeUndefined();
    });

    it('returns undefined when the model advertises no effort list', () => {
      expect(mapAnthropicEffort('high', undefined)).toBeUndefined();
    });

    // mapReasoningEffort throws on an empty array, and [] is the normal value
    // for models with no configurable effort — this must never reach a request.
    it('returns undefined instead of throwing on an empty list', () => {
      expect(() => mapAnthropicEffort('high', [])).not.toThrow();
      expect(mapAnthropicEffort('high', [])).toBeUndefined();
    });
  });

  describe('clamping', () => {
    it('maps below-range levels down to low', () => {
      expect(mapAnthropicEffort('none', ALL)).toBe('low');
      expect(mapAnthropicEffort('minimal', ALL)).toBe('low');
    });

    it('passes through levels the model supports', () => {
      expect(mapAnthropicEffort('medium', ALL)).toBe('medium');
      expect(mapAnthropicEffort('high', ALL)).toBe('high');
      expect(mapAnthropicEffort('xhigh', ALL)).toBe('xhigh');
      expect(mapAnthropicEffort('max', ALL)).toBe('max');
    });

    it('drops levels the Anthropic API rejects from a malformed list', () => {
      expect(mapAnthropicEffort('minimal', ['none', 'minimal', 'low', 'high'])).toBe('low');
    });

    it('maps max down to the highest supported level', () => {
      expect(mapAnthropicEffort('max', ['low', 'medium', 'high'])).toBe('high');
    });
  });

  // xhigh means "deeper than high", so it escalates rather than rounding down.
  describe('xhigh on a model without it', () => {
    it('escalates to max when max is available', () => {
      expect(mapAnthropicEffort('xhigh', NO_XHIGH)).toBe('max');
    });

    it('falls back to the highest supported level when max is not', () => {
      expect(mapAnthropicEffort('xhigh', ['low', 'medium', 'high'])).toBe('high');
    });
  });
});
