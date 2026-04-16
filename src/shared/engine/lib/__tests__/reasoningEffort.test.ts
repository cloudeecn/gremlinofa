import { describe, it, expect } from 'vitest';
import { mapReasoningEffort, REASONING_EFFORTS } from '../reasoningEffort';

describe('REASONING_EFFORTS', () => {
  it('contains all effort levels in order', () => {
    expect(REASONING_EFFORTS).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
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
});
