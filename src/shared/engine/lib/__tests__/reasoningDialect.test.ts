import { describe, expect, it } from 'vitest';
import { resolveReasoningDialect, wantsReasoningHistory } from '../reasoningDialect';
import type { APIDefinition, Model } from '../../../protocol/types';

const model = (overrides: Partial<Model> = {}): Model => ({
  id: 'test-model',
  name: 'Test Model',
  apiType: 'chatgpt',
  matchedMode: 'exact',
  ...overrides,
});

const apiDef = (advancedSettings?: APIDefinition['advancedSettings']): APIDefinition => ({
  id: 'test-api',
  apiType: 'chatgpt',
  name: 'Test API',
  baseUrl: '',
  apiKey: 'key',
  advancedSettings,
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe('resolveReasoningDialect', () => {
  it('defaults to openai with nothing configured', () => {
    expect(resolveReasoningDialect()).toBe('openai');
    expect(resolveReasoningDialect(model(), apiDef())).toBe('openai');
  });

  it('takes the definition dialect when the model declares none', () => {
    expect(resolveReasoningDialect(model(), apiDef({ reasoningDialect: 'enable-thinking' }))).toBe(
      'enable-thinking'
    );
  });

  it("lets a model's own dialect beat the definition", () => {
    // Kimi K2.x and K3 live in one Moonshot definition and want different shapes.
    expect(
      resolveReasoningDialect(
        model({ reasoningDialect: 'enable-thinking' }),
        apiDef({ reasoningDialect: 'thinking-object' })
      )
    ).toBe('enable-thinking');
  });

  it('treats an explicit openai on the model as an answer, not an absence', () => {
    expect(
      resolveReasoningDialect(
        model({ reasoningDialect: 'openai' }),
        apiDef({ reasoningDialect: 'thinking-object' })
      )
    ).toBe('openai');
  });

  describe('override', () => {
    it('flips precedence when the definition asks for it', () => {
      expect(
        resolveReasoningDialect(
          model({ reasoningDialect: 'thinking-object' }),
          apiDef({ reasoningDialect: 'enable-thinking', reasoningDialectOverride: true })
        )
      ).toBe('enable-thinking');
    });

    it('is implied by the openrouter dialect', () => {
      // deepseek/deepseek-chat served through OpenRouter speaks OpenRouter's
      // shape, not DeepSeek's, even though its metadata says thinking-object.
      expect(
        resolveReasoningDialect(
          model({ reasoningDialect: 'thinking-object' }),
          apiDef({ reasoningDialect: 'openrouter' })
        )
      ).toBe('openrouter');
    });

    it('does nothing when the definition declares no dialect', () => {
      expect(
        resolveReasoningDialect(
          model({ reasoningDialect: 'thinking-object' }),
          apiDef({ reasoningDialectOverride: true })
        )
      ).toBe('thinking-object');
    });
  });

  describe('legacy deFactoThinking', () => {
    it('reads true as thinking-object on either level', () => {
      expect(resolveReasoningDialect(model({ deFactoThinking: true }))).toBe('thinking-object');
      expect(resolveReasoningDialect(model(), apiDef({ deFactoThinking: true }))).toBe(
        'thinking-object'
      );
    });

    it('reads an explicit false on the model as openai, blocking the definition', () => {
      expect(
        resolveReasoningDialect(
          model({ deFactoThinking: false }),
          apiDef({ deFactoThinking: true })
        )
      ).toBe('openai');
    });

    it('loses to the enum on the same level', () => {
      expect(
        resolveReasoningDialect(
          model({ reasoningDialect: 'enable-thinking', deFactoThinking: true })
        )
      ).toBe('enable-thinking');
      expect(
        resolveReasoningDialect(
          model(),
          apiDef({ reasoningDialect: 'enable-thinking', deFactoThinking: true })
        )
      ).toBe('enable-thinking');
    });

    it('is overridable like the enum', () => {
      expect(
        resolveReasoningDialect(
          model({ deFactoThinking: true }),
          apiDef({ reasoningDialect: 'openrouter' })
        )
      ).toBe('openrouter');
    });
  });
});

describe('wantsReasoningHistory', () => {
  it('asks for history at -1 and at 2 or more', () => {
    expect(wantsReasoningHistory(-1)).toBe(true);
    expect(wantsReasoningHistory(2)).toBe(true);
    expect(wantsReasoningHistory(10)).toBe(true);
  });

  it('leaves the vendor default alone at undefined, 0 and 1', () => {
    expect(wantsReasoningHistory(undefined)).toBe(false);
    expect(wantsReasoningHistory(0)).toBe(false);
    expect(wantsReasoningHistory(1)).toBe(false);
  });
});
