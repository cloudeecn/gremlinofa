/**
 * Tool Options Types Tests
 *
 * Tests for the tool option type system including:
 * - Type guards (isBooleanOption, isLongtextOption, isModelOption, isModelListOption, isModelReference, isModelReferenceArray)
 * - initializeToolOptions helper
 */

import { describe, it, expect } from 'vitest';
import {
  isBooleanOption,
  isLongtextOption,
  isModelOption,
  isModelListOption,
  isModelReference,
  isModelReferenceArray,
  initializeToolOptions,
  type BooleanToolOption,
  type LongtextToolOption,
  type ModelToolOption,
  type ModelListToolOption,
  type ToolOptionDefinition,
  type ToolOptions,
  type ModelReference,
} from '../index';

describe('Tool Option Type Guards', () => {
  const booleanOption: BooleanToolOption = {
    type: 'boolean',
    id: 'useSystemPrompt',
    label: 'Use System Prompt Mode',
    default: false,
  };

  const longtextOption: LongtextToolOption = {
    type: 'longtext',
    id: 'systemPrompt',
    label: 'System Prompt',
    default: '',
    placeholder: 'Enter instructions...',
  };

  const modelOption: ModelToolOption = {
    type: 'model',
    id: 'model',
    label: 'Minion Model',
  };

  const modelListOption: ModelListToolOption = {
    type: 'modellist',
    id: 'models',
    label: 'Available Models',
  };

  describe('isBooleanOption', () => {
    it('returns true for boolean options', () => {
      expect(isBooleanOption(booleanOption)).toBe(true);
    });

    it('returns false for longtext options', () => {
      expect(isBooleanOption(longtextOption)).toBe(false);
    });

    it('returns false for model options', () => {
      expect(isBooleanOption(modelOption)).toBe(false);
    });
  });

  describe('isLongtextOption', () => {
    it('returns true for longtext options', () => {
      expect(isLongtextOption(longtextOption)).toBe(true);
    });

    it('returns false for boolean options', () => {
      expect(isLongtextOption(booleanOption)).toBe(false);
    });

    it('returns false for model options', () => {
      expect(isLongtextOption(modelOption)).toBe(false);
    });
  });

  describe('isModelOption', () => {
    it('returns true for model options', () => {
      expect(isModelOption(modelOption)).toBe(true);
    });

    it('returns false for boolean options', () => {
      expect(isModelOption(booleanOption)).toBe(false);
    });

    it('returns false for longtext options', () => {
      expect(isModelOption(longtextOption)).toBe(false);
    });
  });

  describe('isModelReference', () => {
    it('returns true for valid model reference', () => {
      const ref: ModelReference = {
        apiDefinitionId: 'api_123',
        modelId: 'claude-3',
      };
      expect(isModelReference(ref)).toBe(true);
    });

    it('returns false for boolean', () => {
      expect(isModelReference(true)).toBe(false);
    });

    it('returns false for string', () => {
      expect(isModelReference('hello')).toBe(false);
    });

    it('returns false for null', () => {
      expect(isModelReference(null as unknown as boolean)).toBe(false);
    });

    it('returns false for object without required fields', () => {
      expect(isModelReference({ apiDefinitionId: 'test' } as unknown as boolean)).toBe(false);
      expect(isModelReference({ modelId: 'test' } as unknown as boolean)).toBe(false);
    });

    it('returns false for ModelReference array', () => {
      const refs: ModelReference[] = [
        { apiDefinitionId: 'api_1', modelId: 'model-1' },
        { apiDefinitionId: 'api_2', modelId: 'model-2' },
      ];
      expect(isModelReference(refs)).toBe(false);
    });
  });

  describe('isModelListOption', () => {
    it('returns true for model list options', () => {
      expect(isModelListOption(modelListOption)).toBe(true);
    });

    it('returns false for boolean options', () => {
      expect(isModelListOption(booleanOption)).toBe(false);
    });

    it('returns false for model options', () => {
      expect(isModelListOption(modelOption)).toBe(false);
    });
  });

  describe('isModelReferenceArray', () => {
    it('returns true for array of valid model references', () => {
      const refs: ModelReference[] = [
        { apiDefinitionId: 'api_1', modelId: 'model-1' },
        { apiDefinitionId: 'api_2', modelId: 'model-2' },
      ];
      expect(isModelReferenceArray(refs)).toBe(true);
    });

    it('returns true for empty array', () => {
      expect(isModelReferenceArray([])).toBe(true);
    });

    it('returns false for single ModelReference', () => {
      expect(isModelReferenceArray({ apiDefinitionId: 'a', modelId: 'b' })).toBe(false);
    });

    it('returns false for boolean', () => {
      expect(isModelReferenceArray(true)).toBe(false);
    });

    it('returns false for string', () => {
      expect(isModelReferenceArray('hello')).toBe(false);
    });

    it('returns false for array with invalid elements', () => {
      expect(isModelReferenceArray([{ apiDefinitionId: 'a' }] as unknown as ModelReference[])).toBe(
        false
      );
    });
  });
});

describe('initializeToolOptions', () => {
  const optionDefs: ToolOptionDefinition[] = [
    {
      type: 'boolean',
      id: 'useSystemPrompt',
      label: 'Use System Prompt',
      default: false,
    },
    {
      type: 'longtext',
      id: 'systemPrompt',
      label: 'System Prompt',
      default: 'Default prompt',
    },
    {
      type: 'model',
      id: 'model',
      label: 'Model',
    },
  ];

  it('returns empty object when no option definitions', () => {
    const result = initializeToolOptions(undefined, undefined, {
      apiDefinitionId: 'api_123',
      modelId: 'claude-3',
    });
    expect(result).toEqual({});
  });

  it('returns empty object when option definitions is empty array', () => {
    const result = initializeToolOptions(undefined, [], {
      apiDefinitionId: 'api_123',
      modelId: 'claude-3',
    });
    expect(result).toEqual({});
  });

  it('preserves existing values', () => {
    const existing: ToolOptions = {
      useSystemPrompt: true,
      systemPrompt: 'Custom prompt',
    };
    const result = initializeToolOptions(existing, optionDefs, {
      apiDefinitionId: 'api_123',
      modelId: 'claude-3',
    });

    expect(result.useSystemPrompt).toBe(true);
    expect(result.systemPrompt).toBe('Custom prompt');
  });

  it('initializes boolean options with default', () => {
    const result = initializeToolOptions(undefined, optionDefs, {
      apiDefinitionId: 'api_123',
      modelId: 'claude-3',
    });

    expect(result.useSystemPrompt).toBe(false);
  });

  it('initializes longtext options with default', () => {
    const result = initializeToolOptions(undefined, optionDefs, {
      apiDefinitionId: 'api_123',
      modelId: 'claude-3',
    });

    expect(result.systemPrompt).toBe('Default prompt');
  });

  it('initializes model options from project', () => {
    const result = initializeToolOptions(undefined, optionDefs, {
      apiDefinitionId: 'api_123',
      modelId: 'claude-3',
    });

    expect(result.model).toEqual({
      apiDefinitionId: 'api_123',
      modelId: 'claude-3',
    });
  });

  it('does not initialize model option when project has no model', () => {
    const result = initializeToolOptions(undefined, optionDefs, {
      apiDefinitionId: null,
      modelId: null,
    });

    expect(result.model).toBeUndefined();
  });

  it('does not initialize model option when project has only apiDefinitionId', () => {
    const result = initializeToolOptions(undefined, optionDefs, {
      apiDefinitionId: 'api_123',
      modelId: null,
    });

    expect(result.model).toBeUndefined();
  });

  it('does not overwrite existing model reference', () => {
    const existing: ToolOptions = {
      model: {
        apiDefinitionId: 'existing_api',
        modelId: 'existing_model',
      },
    };
    const result = initializeToolOptions(existing, optionDefs, {
      apiDefinitionId: 'api_123',
      modelId: 'claude-3',
    });

    expect(result.model).toEqual({
      apiDefinitionId: 'existing_api',
      modelId: 'existing_model',
    });
  });

  it('handles mixed existing and new values', () => {
    const existing: ToolOptions = {
      useSystemPrompt: true,
    };
    const result = initializeToolOptions(existing, optionDefs, {
      apiDefinitionId: 'api_123',
      modelId: 'claude-3',
    });

    expect(result.useSystemPrompt).toBe(true); // preserved
    expect(result.systemPrompt).toBe('Default prompt'); // initialized
    expect(result.model).toEqual({
      // initialized from project
      apiDefinitionId: 'api_123',
      modelId: 'claude-3',
    });
  });

  it('initializes modellist option to empty array', () => {
    const defsWithModelList: ToolOptionDefinition[] = [
      { type: 'modellist', id: 'models', label: 'Available Models' },
    ];
    const result = initializeToolOptions(undefined, defsWithModelList, {
      apiDefinitionId: 'api_123',
      modelId: 'claude-3',
    });
    expect(result.models).toEqual([]);
  });

  it('preserves existing modellist value', () => {
    const existing: ToolOptions = {
      models: [{ apiDefinitionId: 'api_1', modelId: 'model-1' }],
    };
    const defsWithModelList: ToolOptionDefinition[] = [
      { type: 'modellist', id: 'models', label: 'Available Models' },
    ];
    const result = initializeToolOptions(existing, defsWithModelList, {
      apiDefinitionId: 'api_123',
      modelId: 'claude-3',
    });
    expect(result.models).toEqual([{ apiDefinitionId: 'api_1', modelId: 'model-1' }]);
  });
});
