/**
 * Tests for minionTool
 *
 * Tests the minion tool's helper functions and configuration.
 * Full integration tests would require mocking the entire agentic loop.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  minionTool,
  SAVEPOINT_START,
  formatModelString,
  parseModelString,
  resolveMinionModelRef,
  buildMinionTools,
  resolveChildNesting,
  checkPersonaDelegation,
  truncateError,
  parseSimplifiedOutput,
  stripNsPrefix,
  findPriorAssistantClaudeAgentUuid,
  applyClaudeAgentRewindOnFailure,
  applyClaudeAgentRewindOnRollback,
  resolveRetryStash,
  stripVerifyFeedbackNote,
} from '../minionTool';
import { LoopRegistry } from '../../../engine/LoopRegistry';
import type {
  ToolResult,
  ToolExecuteReturn,
  ModelReference,
  SystemPromptContext,
  ToolOptions,
  Message,
  MinionChat,
} from '../../../protocol/types';
import type { VfsAdapter } from '../../vfs/vfsAdapter';
import type { UnifiedStorage } from '../../storage/unifiedStorage';
import { stubBackendDeps } from './testStubs';

// minionTool's tests don't reach into vfs adapter methods — the empty
// stub satisfies ToolContext's shape.
const mockAdapter = {} as VfsAdapter;
const mockAdapterFactory = (_ns?: string) => mockAdapter;

// Minimal storage stub for execute tests that reach Phase 2 of minionTool
// (which calls saveMinionChat when creating a fresh minion chat). The stub
// is threaded through `ToolContext.storage` instead of mocking the singleton.
const mockStorage = {
  saveMinionChat: vi.fn(() => Promise.resolve()),
} as unknown as UnifiedStorage;

const mockDeps = { ...stubBackendDeps, storage: mockStorage };

/** Consume an async generator to get the final ToolResult */
async function collectToolResult(gen: ToolExecuteReturn): Promise<ToolResult> {
  if (gen instanceof Promise) return gen;
  let result = await gen.next();
  while (!result.done) result = await gen.next();
  return result.value;
}

describe('minionTool', () => {
  describe('tool definition', () => {
    it('has correct name and display properties', () => {
      expect(minionTool.name).toBe('minion');
      expect(minionTool.displayName).toBe('Minion');
      expect(minionTool.displaySubtitle).toBe('Delegate tasks to a sub-agent');
    });

    it('has icons defined', () => {
      expect(minionTool.iconInput).toBe('🤖');
      expect(minionTool.iconOutput).toBe('🤖');
    });

    it('has required input schema properties', () => {
      const schema =
        typeof minionTool.inputSchema === 'function'
          ? minionTool.inputSchema({})
          : minionTool.inputSchema;
      expect(schema.type).toBe('object');
      expect(schema.required).toEqual([]);
      expect(schema.properties).toHaveProperty('action');
      expect(schema.properties).toHaveProperty('message');
      expect(schema.properties).toHaveProperty('minionChatId');
      expect(schema.properties).toHaveProperty('enabledTools');
      expect(schema.properties).toHaveProperty('displayName');
      expect(schema.properties).toHaveProperty('injectFiles');
      expect(schema.properties).toHaveProperty('verifyHook');
    });

    it('exposes allowNesting only when the project allows nesting', () => {
      const off = minionTool.inputSchema as (o: ToolOptions) => { properties: object };
      expect(off({}).properties).not.toHaveProperty('allowNesting');
      expect(off({ allowNesting: true }).properties).toHaveProperty('allowNesting');
    });

    it('exposes availablePersonas only when namespaced AND nesting are both on', () => {
      const schema = minionTool.inputSchema as (o: ToolOptions) => { properties: object };
      // nesting on but not namespaced → hidden (child can't be a persona delegator)
      expect(schema({ allowNesting: true }).properties).not.toHaveProperty('availablePersonas');
      // namespaced but nesting off → hidden (child can't delegate at all)
      expect(schema({ namespacedMinion: 'persona' }).properties).not.toHaveProperty(
        'availablePersonas'
      );
      // both on → exposed
      expect(schema({ namespacedMinion: 'persona', allowNesting: true }).properties).toHaveProperty(
        'availablePersonas'
      );
    });

    it('schema verbosity property is a low/medium/high enum', () => {
      const schema =
        typeof minionTool.inputSchema === 'function'
          ? minionTool.inputSchema({})
          : minionTool.inputSchema;
      const prop = schema.properties!.verbosity as { type: string; enum: string[] };
      expect(prop.type).toBe('string');
      expect(prop.enum).toEqual(['low', 'medium', 'high']);
    });

    it('schema verifyHook property is a string', () => {
      const schema =
        typeof minionTool.inputSchema === 'function'
          ? minionTool.inputSchema({})
          : minionTool.inputSchema;
      const prop = schema.properties!.verifyHook as { type: string };
      expect(prop.type).toBe('string');
    });

    it('description mentions verifyHook', () => {
      const descFn = minionTool.description;
      if (typeof descFn !== 'function') throw new Error('Expected description to be a function');
      const desc = descFn({});
      expect(desc).toContain('verifyHook');
    });

    it('schema injectFiles items accept a path string or an object with framing', () => {
      const schema =
        typeof minionTool.inputSchema === 'function'
          ? minionTool.inputSchema({})
          : minionTool.inputSchema;
      const prop = schema.properties!.injectFiles as {
        type: string;
        items: {
          anyOf: Array<{
            type: string;
            properties?: Record<string, unknown>;
            required?: string[];
          }>;
        };
      };
      expect(prop.type).toBe('array');
      const [stringForm, objectForm] = prop.items.anyOf;
      expect(stringForm.type).toBe('string');
      expect(objectForm.type).toBe('object');
      expect(objectForm.properties).toHaveProperty('path');
      expect(objectForm.properties).toHaveProperty('preamble');
      expect(objectForm.properties).toHaveProperty('postamble');
      expect(objectForm.required).toEqual(['path']);
    });

    it('schema injectFilesAfter mirrors the injectFiles item shape', () => {
      const schema =
        typeof minionTool.inputSchema === 'function'
          ? minionTool.inputSchema({})
          : minionTool.inputSchema;
      const after = schema.properties!.injectFilesAfter as {
        type: string;
        items: unknown;
        description: string;
      };
      const before = schema.properties!.injectFiles as { items: unknown };
      expect(after.type).toBe('array');
      expect(after.items).toEqual(before.items);
      expect(after.description).toContain('after the message');
    });

    it('schema fileLineNumbers property is a boolean', () => {
      const schema =
        typeof minionTool.inputSchema === 'function'
          ? minionTool.inputSchema({})
          : minionTool.inputSchema;
      const prop = schema.properties!.fileLineNumbers as { type: string };
      expect(prop.type).toBe('boolean');
    });

    it('description mentions injectFiles', () => {
      const descFn = minionTool.description;
      if (typeof descFn !== 'function') throw new Error('Expected description to be a function');
      const desc = descFn({});
      expect(desc).toContain('injectFiles');
      expect(desc).toContain('injectFilesAfter');
    });

    it('schema always includes displayName regardless of options', () => {
      const withNamespaced =
        typeof minionTool.inputSchema === 'function'
          ? minionTool.inputSchema({ namespacedMinion: 'all' })
          : minionTool.inputSchema;
      expect(withNamespaced.properties).toHaveProperty('displayName');

      const withoutNamespaced =
        typeof minionTool.inputSchema === 'function'
          ? minionTool.inputSchema({ namespacedMinion: 'off' })
          : minionTool.inputSchema;
      expect(withoutNamespaced.properties).toHaveProperty('displayName');

      const noOpts =
        typeof minionTool.inputSchema === 'function'
          ? minionTool.inputSchema({})
          : minionTool.inputSchema;
      expect(noOpts.properties).toHaveProperty('displayName');
    });

    it('schema action property has correct enum values', () => {
      const schema =
        typeof minionTool.inputSchema === 'function'
          ? minionTool.inputSchema({})
          : minionTool.inputSchema;
      const actionProp = schema.properties!.action as { enum: string[] };
      expect(actionProp.enum).toEqual(['message', 'retry']);
    });

    it('description mentions retry capability', () => {
      const descFn = minionTool.description;
      if (typeof descFn !== 'function') throw new Error('Expected description to be a function');
      const desc = descFn({});
      expect(desc).toContain('Retry the last run');
      expect(desc).toContain('minionChatId');
    });

    it('schema omits action when autoRollback is enabled', () => {
      const schema =
        typeof minionTool.inputSchema === 'function'
          ? minionTool.inputSchema({ autoRollback: true })
          : minionTool.inputSchema;
      expect(schema.properties).not.toHaveProperty('action');
    });

    it('schema includes action when autoRollback is not set', () => {
      const schema =
        typeof minionTool.inputSchema === 'function'
          ? minionTool.inputSchema({})
          : minionTool.inputSchema;
      expect(schema.properties).toHaveProperty('action');
    });

    it('description mentions auto-recovery when autoRollback is enabled', () => {
      const descFn = minionTool.description;
      if (typeof descFn !== 'function') throw new Error('Expected description to be a function');
      const desc = descFn({ autoRollback: true });
      expect(desc).toContain('automatically recovers');
      expect(desc).not.toContain('Retry the last run');
    });

    it('description mentions retry when autoRollback is not set', () => {
      const descFn = minionTool.description;
      if (typeof descFn !== 'function') throw new Error('Expected description to be a function');
      const desc = descFn({});
      expect(desc).toContain('Retry the last run');
      expect(desc).not.toContain('automatically recovers');
    });

    it('schema includes enableWeb when allowWebSearch is true', () => {
      const schema =
        typeof minionTool.inputSchema === 'function'
          ? minionTool.inputSchema({ allowWebSearch: true })
          : minionTool.inputSchema;
      expect(schema.properties).toHaveProperty('enableWeb');
    });

    it('schema excludes enableWeb when allowWebSearch is false', () => {
      const schema =
        typeof minionTool.inputSchema === 'function'
          ? minionTool.inputSchema({ allowWebSearch: false })
          : minionTool.inputSchema;
      expect(schema.properties).not.toHaveProperty('enableWeb');
    });

    it('schema excludes enableWeb when allowWebSearch is missing', () => {
      const schema =
        typeof minionTool.inputSchema === 'function'
          ? minionTool.inputSchema({})
          : minionTool.inputSchema;
      expect(schema.properties).not.toHaveProperty('enableWeb');
    });

    it('schema includes persona when namespacedMinion is "all"', () => {
      const schema =
        typeof minionTool.inputSchema === 'function'
          ? minionTool.inputSchema({ namespacedMinion: 'all' })
          : minionTool.inputSchema;
      expect(schema.properties).toHaveProperty('persona');
    });

    it('schema includes persona when namespacedMinion is "persona"', () => {
      const schema =
        typeof minionTool.inputSchema === 'function'
          ? minionTool.inputSchema({ namespacedMinion: 'persona' })
          : minionTool.inputSchema;
      expect(schema.properties).toHaveProperty('persona');
    });

    it('schema excludes persona when namespacedMinion is "off"', () => {
      const schema =
        typeof minionTool.inputSchema === 'function'
          ? minionTool.inputSchema({ namespacedMinion: 'off' })
          : minionTool.inputSchema;
      expect(schema.properties).not.toHaveProperty('persona');
    });

    it('schema excludes persona when namespacedMinion is missing', () => {
      const schema =
        typeof minionTool.inputSchema === 'function'
          ? minionTool.inputSchema({})
          : minionTool.inputSchema;
      expect(schema.properties).not.toHaveProperty('persona');
    });

    it('description mentions persona when namespacedMinion is "all"', () => {
      const descFn = minionTool.description;
      if (typeof descFn !== 'function') throw new Error('Expected description to be a function');
      const desc = descFn({ namespacedMinion: 'all' });
      expect(desc).toContain('persona');
    });

    it('description mentions persona when namespacedMinion is "persona"', () => {
      const descFn = minionTool.description;
      if (typeof descFn !== 'function') throw new Error('Expected description to be a function');
      const desc = descFn({ namespacedMinion: 'persona' });
      expect(desc).toContain('persona');
    });

    it('description omits persona when namespacedMinion is "off"', () => {
      const descFn = minionTool.description;
      if (typeof descFn !== 'function') throw new Error('Expected description to be a function');
      const desc = descFn({ namespacedMinion: 'off' });
      expect(desc).not.toContain('persona');
    });

    it('description mentions web search only when allowWebSearch is true', () => {
      const descFn = minionTool.description;
      if (typeof descFn !== 'function') {
        throw new Error('Expected description to be a function');
      }

      const withWeb = descFn({ allowWebSearch: true });
      const withoutWeb = descFn({ allowWebSearch: false });
      const noOpts = descFn({});

      expect(withWeb).toContain('web search');
      expect(withoutWeb).not.toContain('web search');
      expect(noOpts).not.toContain('web search');
    });

    it('has option definitions for model, models, system prompt, allowWebSearch, autoRollback, verifyFeedback, returnMode, disableReasoning, deferReturn, deferred/return messages, autoAckMessage, namespacedMinion, and fileInjectionMode', () => {
      expect(minionTool.optionDefinitions).toBeDefined();
      expect(minionTool.optionDefinitions).toHaveLength(23);

      const verifyFeedbackOpt = minionTool.optionDefinitions?.find(o => o.id === 'verifyFeedback');
      expect(verifyFeedbackOpt).toBeDefined();
      expect(verifyFeedbackOpt?.type).toBe('boolean');
      if (verifyFeedbackOpt?.type === 'boolean') {
        expect(verifyFeedbackOpt.default).toBe(false);
      }

      const systemPromptOpt = minionTool.optionDefinitions?.find(o => o.id === 'systemPrompt');
      expect(systemPromptOpt).toBeDefined();
      expect(systemPromptOpt?.type).toBe('longtext');

      const modelOpt = minionTool.optionDefinitions?.find(o => o.id === 'model');
      expect(modelOpt).toBeDefined();
      expect(modelOpt?.type).toBe('model');

      const webSearchOpt = minionTool.optionDefinitions?.find(o => o.id === 'allowWebSearch');
      expect(webSearchOpt).toBeDefined();
      expect(webSearchOpt?.type).toBe('boolean');
      if (webSearchOpt?.type === 'boolean') {
        expect(webSearchOpt.default).toBe(false);
      }

      const autoRollbackOpt = minionTool.optionDefinitions?.find(o => o.id === 'autoRollback');
      expect(autoRollbackOpt).toBeDefined();
      expect(autoRollbackOpt?.type).toBe('boolean');
      if (autoRollbackOpt?.type === 'boolean') {
        expect(autoRollbackOpt.default).toBe(false);
      }

      const returnModeOpt = minionTool.optionDefinitions?.find(o => o.id === 'returnMode');
      expect(returnModeOpt).toBeDefined();
      expect(returnModeOpt?.type).toBe('select');
      if (returnModeOpt?.type === 'select') {
        expect(returnModeOpt.default).toBe('both');
        expect(returnModeOpt.choices).toHaveLength(5);
        expect(returnModeOpt.choices.map(c => c.value)).toEqual([
          'no-return',
          'both',
          'return-only',
          'enforced',
          'auto-enforced',
        ]);
      }

      const disableReasoningOpt = minionTool.optionDefinitions?.find(
        o => o.id === 'disableReasoning'
      );
      expect(disableReasoningOpt).toBeDefined();
      expect(disableReasoningOpt?.type).toBe('boolean');
      if (disableReasoningOpt?.type === 'boolean') {
        expect(disableReasoningOpt.default).toBe(false);
      }

      const allowNestingOpt = minionTool.optionDefinitions?.find(o => o.id === 'allowNesting');
      expect(allowNestingOpt).toBeDefined();
      expect(allowNestingOpt?.type).toBe('boolean');
      if (allowNestingOpt?.type === 'boolean') {
        expect(allowNestingOpt.default).toBe(false);
      }

      const maxNestingDepthOpt = minionTool.optionDefinitions?.find(
        o => o.id === 'maxNestingDepth'
      );
      expect(maxNestingDepthOpt).toBeDefined();
      expect(maxNestingDepthOpt?.type).toBe('number');
      if (maxNestingDepthOpt?.type === 'number') {
        expect(maxNestingDepthOpt.default).toBe(3);
        expect(maxNestingDepthOpt.visibleWhen).toEqual({ optionId: 'allowNesting', value: true });
      }

      const namespacedOpt = minionTool.optionDefinitions?.find(o => o.id === 'namespacedMinion');
      expect(namespacedOpt).toBeDefined();
      expect(namespacedOpt?.type).toBe('select');
      if (namespacedOpt?.type === 'select') {
        expect(namespacedOpt.default).toBe('off');
        expect(namespacedOpt.choices).toHaveLength(3);
        expect(namespacedOpt.choices.map(c => c.value)).toEqual(['off', 'persona', 'all']);
      }

      const personaListingOpt = minionTool.optionDefinitions?.find(
        o => o.id === 'personaListingMode'
      );
      expect(personaListingOpt).toBeDefined();
      expect(personaListingOpt?.type).toBe('select');
      if (personaListingOpt?.type === 'select') {
        expect(personaListingOpt.default).toBe('detailed');
        expect(personaListingOpt.choices.map(c => c.value)).toEqual([
          'detailed',
          'name-only',
          'none',
        ]);
        expect(personaListingOpt.visibleWhen).toEqual({
          optionId: 'namespacedMinion',
          value: ['persona', 'all'],
        });
      }

      const deferReturnOpt = minionTool.optionDefinitions?.find(o => o.id === 'deferReturn');
      expect(deferReturnOpt).toBeDefined();
      expect(deferReturnOpt?.type).toBe('select');
      if (deferReturnOpt?.type === 'select') {
        expect(deferReturnOpt.default).toBe('no');
        expect(deferReturnOpt.choices).toHaveLength(3);
        expect(deferReturnOpt.choices.map(c => c.value)).toEqual(['no', 'auto-ack', 'free-run']);
      }

      const autoAckOpt = minionTool.optionDefinitions?.find(o => o.id === 'autoAckMessage');
      expect(autoAckOpt).toBeDefined();
      expect(autoAckOpt?.type).toBe('text');

      const modelsOpt = minionTool.optionDefinitions?.find(o => o.id === 'models');
      expect(modelsOpt).toBeDefined();
      expect(modelsOpt?.type).toBe('modellist');

      const fileInjOpt = minionTool.optionDefinitions?.find(o => o.id === 'fileInjectionMode');
      expect(fileInjOpt).toBeDefined();
      expect(fileInjOpt?.type).toBe('select');
      if (fileInjOpt?.type === 'select') {
        expect(fileInjOpt.default).toBe('inline');
        expect(fileInjOpt.choices.map(c => c.value)).toEqual([
          'inline',
          'separate-block',
          'as-file',
          'mock-tool-call',
        ]);
      }
    });

    it('description omits return tool paragraph when returnMode is no-return', () => {
      const desc =
        typeof minionTool.description === 'function'
          ? minionTool.description({ returnMode: 'no-return' })
          : minionTool.description;
      expect(desc).not.toContain("'return' tool");
    });

    it('description includes return tool paragraph with legacy noReturnTool=false', () => {
      const desc =
        typeof minionTool.description === 'function'
          ? minionTool.description({ noReturnTool: false })
          : minionTool.description;
      expect(desc).toContain("'return' tool");
    });

    it('description respects legacy noReturnTool=true via resolveReturnMode', () => {
      const desc =
        typeof minionTool.description === 'function'
          ? minionTool.description({ noReturnTool: true })
          : minionTool.description;
      expect(desc).not.toContain("'return' tool");
    });

    it('schema includes model enum when namespacedMinion + models configured', () => {
      const models: ModelReference[] = [
        { apiDefinitionId: 'api_1', modelId: 'claude-3' },
        { apiDefinitionId: 'api_2', modelId: 'us.anthropic.claude-3-5-sonnet:0' },
      ];
      const schema =
        typeof minionTool.inputSchema === 'function'
          ? minionTool.inputSchema({ namespacedMinion: 'all', models })
          : minionTool.inputSchema;
      expect(schema.properties).toHaveProperty('model');
      const modelProp = schema.properties!.model as { enum: string[] };
      expect(modelProp.enum).toEqual(['api_1:claude-3', 'api_2:us.anthropic.claude-3-5-sonnet:0']);
    });

    it('schema excludes model param when namespacedMinion is "off"', () => {
      const models: ModelReference[] = [{ apiDefinitionId: 'a', modelId: 'b' }];
      const schema =
        typeof minionTool.inputSchema === 'function'
          ? minionTool.inputSchema({ namespacedMinion: 'off', models })
          : minionTool.inputSchema;
      expect(schema.properties).not.toHaveProperty('model');
    });

    it('schema excludes model param when models list is empty', () => {
      const schema =
        typeof minionTool.inputSchema === 'function'
          ? minionTool.inputSchema({ namespacedMinion: 'all', models: [] })
          : minionTool.inputSchema;
      expect(schema.properties).not.toHaveProperty('model');
    });

    it('description mentions model selection when namespacedMinion + models configured', () => {
      const descFn = minionTool.description;
      if (typeof descFn !== 'function') throw new Error('Expected description to be a function');
      const models: ModelReference[] = [{ apiDefinitionId: 'a', modelId: 'b' }];
      const desc = descFn({ namespacedMinion: 'all', models });
      expect(desc).toContain('model parameter');
    });

    it('description omits model selection when no models configured', () => {
      const descFn = minionTool.description;
      if (typeof descFn !== 'function') throw new Error('Expected description to be a function');
      const desc = descFn({ namespacedMinion: 'all' });
      expect(desc).not.toContain('model parameter');
    });
  });

  describe('truncateError', () => {
    it('returns short messages unchanged', () => {
      expect(truncateError('Short error')).toBe('Short error');
    });

    it('returns exactly-at-limit messages unchanged', () => {
      const msg = 'x'.repeat(200);
      expect(truncateError(msg)).toBe(msg);
    });

    it('truncates long messages and appends ellipsis', () => {
      const msg = 'A'.repeat(300);
      const result = truncateError(msg);
      expect(result).toHaveLength(203); // 200 + '...'
      expect(result).toMatch(/^A{200}\.\.\.$/);
    });

    it('respects custom limit', () => {
      const msg = 'Hello World!';
      expect(truncateError(msg, 5)).toBe('Hello...');
    });
  });

  describe('formatModelString', () => {
    it('formats apiDefinitionId:modelId', () => {
      expect(formatModelString({ apiDefinitionId: 'api_1', modelId: 'claude-3' })).toBe(
        'api_1:claude-3'
      );
    });

    it('preserves colons in modelId (Bedrock ARNs)', () => {
      expect(
        formatModelString({
          apiDefinitionId: 'bedrock',
          modelId: 'us.anthropic.claude-3-5-sonnet:0',
        })
      ).toBe('bedrock:us.anthropic.claude-3-5-sonnet:0');
    });
  });

  describe('parseModelString', () => {
    it('parses standard format', () => {
      expect(parseModelString('api_1:claude-3')).toEqual({
        apiDefinitionId: 'api_1',
        modelId: 'claude-3',
      });
    });

    it('splits on first colon only (Bedrock ARN)', () => {
      expect(parseModelString('bedrock:us.anthropic.claude-3-5-sonnet:0')).toEqual({
        apiDefinitionId: 'bedrock',
        modelId: 'us.anthropic.claude-3-5-sonnet:0',
      });
    });

    it('returns undefined for string without colon', () => {
      expect(parseModelString('nocolon')).toBeUndefined();
    });
  });

  describe('resolveMinionModelRef', () => {
    const chat = { apiDefinitionId: 'api_chat', modelId: 'model-chat' };
    const defaultOption = { model: { apiDefinitionId: 'api_default', modelId: 'model-default' } };

    it('prefers an explicitly requested model', () => {
      expect(resolveMinionModelRef({ model: 'api_x:model-x' }, chat, defaultOption)).toEqual({
        apiDefinitionId: 'api_x',
        modelId: 'model-x',
      });
    });

    it('falls back to the chat-stored model on continuation', () => {
      expect(resolveMinionModelRef({}, chat, defaultOption)).toEqual({
        apiDefinitionId: 'api_chat',
        modelId: 'model-chat',
      });
    });

    it('falls back to the default option when no model and no chat', () => {
      expect(resolveMinionModelRef({}, undefined, defaultOption)).toEqual({
        apiDefinitionId: 'api_default',
        modelId: 'model-default',
      });
    });

    it('skips an unparseable input.model and uses the next source', () => {
      expect(resolveMinionModelRef({ model: 'nocolon' }, chat, defaultOption)).toEqual({
        apiDefinitionId: 'api_chat',
        modelId: 'model-chat',
      });
    });

    it('returns undefined when nothing resolves', () => {
      expect(resolveMinionModelRef({}, undefined, undefined)).toBeUndefined();
    });
  });

  describe('renderInput', () => {
    it('renders basic message', () => {
      const input = { message: 'Do something' };
      const result = minionTool.renderInput!(input);
      expect(result).toContain('Do something');
    });

    it('renders with minionChatId', () => {
      const input = { message: 'Continue task', minionChatId: 'minion_abc123' };
      const result = minionTool.renderInput!(input);
      expect(result).toContain('Continue: minion_abc123');
      expect(result).toContain('Continue task');
    });

    it('renders with enabled tools', () => {
      const input = { message: 'Task', enabledTools: ['js', 'fs'] };
      const result = minionTool.renderInput!(input);
      expect(result).toContain('Tools: js, fs');
    });

    it('renders with web enabled', () => {
      const input = { message: 'Search task', enableWeb: true };
      const result = minionTool.renderInput!(input);
      expect(result).toContain('Web: enabled');
    });

    it('renders all options combined', () => {
      const input = {
        message: 'Complex task',
        minionChatId: 'minion_xyz',
        enabledTools: ['memory', 'js'],
        enableWeb: true,
      };
      const result = minionTool.renderInput!(input);
      expect(result).toContain('Continue: minion_xyz');
      expect(result).toContain('Tools: memory, js');
      expect(result).toContain('Web: enabled');
      expect(result).toContain('Complex task');
    });

    it('renders verbosity override', () => {
      const result = minionTool.renderInput!({ message: 'Task', verbosity: 'low' });
      expect(result).toContain('Verbosity: low');
    });

    it('renders retry action', () => {
      const input = { action: 'retry', minionChatId: 'minion_abc' };
      const result = minionTool.renderInput!(input);
      expect(result).toContain('Action: retry');
      expect(result).toContain('Continue: minion_abc');
    });

    it('renders retry with replacement message', () => {
      const input = { action: 'retry', minionChatId: 'minion_abc', message: 'New instruction' };
      const result = minionTool.renderInput!(input);
      expect(result).toContain('Action: retry');
      expect(result).toContain('New instruction');
    });

    it('renders model when specified', () => {
      const input = { message: 'Task', model: 'api_1:claude-3' };
      const result = minionTool.renderInput!(input);
      expect(result).toContain('Model: api_1:claude-3');
    });

    it('renders displayName when specified', () => {
      const input = { message: 'Task', displayName: 'Code Reviewer' };
      const result = minionTool.renderInput!(input);
      expect(result).toContain('Display: Code Reviewer');
    });

    it('renders injectFiles when specified', () => {
      const input = { message: 'Analyze', injectFiles: ['/src/foo.ts', '/README.md'] };
      const result = minionTool.renderInput!(input);
      expect(result).toContain('Files: /src/foo.ts, /README.md');
    });

    it('renders the path of object-form injectFiles entries', () => {
      const input = {
        message: 'Analyze',
        injectFiles: ['/src/foo.ts', { path: '/diary.md' }],
      };
      const result = minionTool.renderInput!(input);
      expect(result).toContain('Files: /src/foo.ts, /diary.md');
    });

    it('marks injectFiles entries carrying custom framing', () => {
      const input = {
        message: 'Analyze',
        injectFiles: [
          '/src/foo.ts',
          { path: '/diary.md', preamble: 'She read:' },
          { path: '/notes.md', postamble: 'End of notes.' },
        ],
      };
      const result = minionTool.renderInput!(input);
      expect(result).toContain('Files: /src/foo.ts, /diary.md (framed), /notes.md (framed)');
    });

    it('renders injectFilesAfter on its own line, with the framing marker', () => {
      const result = minionTool.renderInput!({
        message: 'Analyze',
        injectFiles: ['/lead.ts'],
        injectFilesAfter: ['/trail.ts', { path: '/diary.md', preamble: 'She read:' }],
      });
      expect(result).toContain('Files: /lead.ts');
      expect(result).toContain('FilesAfter: /trail.ts, /diary.md (framed)');
    });

    it('omits FilesAfter when injectFilesAfter is not passed', () => {
      const result = minionTool.renderInput!({ message: 'Analyze', injectFiles: ['/lead.ts'] });
      expect(result).not.toContain('FilesAfter');
    });

    it('renders maxOutputTokens, thinkingKeepTurns and pruneThinkingBeforeApiCall', () => {
      const result = minionTool.renderInput!({
        message: 'Task',
        maxOutputTokens: 4096,
        thinkingKeepTurns: 2,
        pruneThinkingBeforeApiCall: true,
      });
      expect(result).toContain('MaxTokens: 4096');
      expect(result).toContain('KeepThinking: 2');
      expect(result).toContain('PruneThinking: on');
    });

    it('renders thinkingKeepTurns -1 as "all"', () => {
      const result = minionTool.renderInput!({ message: 'Task', thinkingKeepTurns: -1 });
      expect(result).toContain('KeepThinking: all');
    });

    it('renders explicitly-disabled booleans instead of hiding them', () => {
      const result = minionTool.renderInput!({
        message: 'Task',
        enableWeb: false,
        allowNesting: false,
        remote: false,
        pruneThinkingBeforeApiCall: false,
      });
      expect(result).toContain('Web: disabled');
      expect(result).toContain('Nesting: denied');
      expect(result).toContain('Remote: local');
      expect(result).toContain('PruneThinking: off');
    });

    it('renders empty tool and persona grants as an explicit (none)', () => {
      const result = minionTool.renderInput!({
        message: 'Task',
        enabledTools: [],
        availablePersonas: [],
      });
      expect(result).toContain('Tools: (none)');
      expect(result).toContain('Grants personas: (none)');
    });

    it('omits every override the caller did not pass', () => {
      const result = minionTool.renderInput!({ message: 'Just a task' });
      for (const label of [
        'Tools:',
        'Web:',
        'Nesting:',
        'Remote:',
        'MaxTokens:',
        'KeepThinking:',
        'PruneThinking:',
        'Verbosity:',
        'Temp:',
        'Reasoning:',
      ]) {
        expect(result).not.toContain(label);
      }
      expect(result).toContain('Just a task');
    });

    it('omits Files line when injectFiles is empty', () => {
      const input = { message: 'Task', injectFiles: [] };
      const result = minionTool.renderInput!(input);
      expect(result).not.toContain('Files:');
    });

    it('omits Files line when injectFiles is absent', () => {
      const input = { message: 'Task' };
      const result = minionTool.renderInput!(input);
      expect(result).not.toContain('Files:');
    });

    it('renders verifyHook name when specified', () => {
      const input = { message: 'Task', verifyHook: 'check-output' };
      const result = minionTool.renderInput!(input);
      expect(result).toContain('VerifyHook: check-output');
    });

    it('omits VerifyHook line when verifyHook is absent', () => {
      const input = { message: 'Task' };
      const result = minionTool.renderInput!(input);
      expect(result).not.toContain('VerifyHook');
    });
  });

  describe('renderOutput', () => {
    it('returns error output as-is', () => {
      const output = 'Error: Something went wrong';
      const result = minionTool.renderOutput!(output, true);
      expect(result).toBe(output);
    });

    it('returns non-JSON output as-is', () => {
      const output = 'Task completed successfully';
      const result = minionTool.renderOutput!(output, false);
      expect(result).toBe(output);
    });

    it('shows text captured, result, and chatId when all present', () => {
      const output = JSON.stringify({
        text: 'Some intermediate output',
        result: 'Final answer',
        stopReason: 'end_turn',
        minionChatId: 'minion_abc',
      });
      const rendered = minionTool.renderOutput!(output, false);
      expect(rendered).toBe('Text output captured.\n\nFinal answer\n\n[minionChatId: minion_abc]');
    });

    it('shows text captured and chatId when no result (no return tool)', () => {
      const output = JSON.stringify({
        text: 'Task completed successfully',
        stopReason: 'end_turn',
        minionChatId: 'minion_abc',
      });
      const rendered = minionTool.renderOutput!(output, false);
      expect(rendered).toBe('Text output captured.\n\n[minionChatId: minion_abc]');
    });

    it('omits text captured line when text is empty', () => {
      const output = JSON.stringify({
        text: '',
        result: 'Return value',
        stopReason: 'end_turn',
        minionChatId: 'minion_abc',
      });
      const rendered = minionTool.renderOutput!(output, false);
      expect(rendered).toBe('Return value\n\n[minionChatId: minion_abc]');
    });

    it('does not truncate long text', () => {
      const output = JSON.stringify({
        text: 'A'.repeat(600),
        stopReason: 'end_turn',
        minionChatId: 'minion_abc',
      });
      const rendered = minionTool.renderOutput!(output, false);
      expect(rendered).toBe('Text output captured.\n\n[minionChatId: minion_abc]');
    });

    it('shows warning when present in output', () => {
      const output = JSON.stringify({
        text: '',
        stopReason: 'end_turn',
        minionChatId: 'minion_abc',
        warning: 'Return tool was not called',
      });
      const rendered = minionTool.renderOutput!(output, false);
      expect(rendered).toContain('⚠ Return tool was not called');
      expect(rendered).toContain('[minionChatId: minion_abc]');
    });
  });

  describe('parseSimplifiedOutput', () => {
    it('parses output without hasCoT tag', () => {
      const output = '<minionChatId>minion_abc</minionChatId>\nSome result';
      const parsed = parseSimplifiedOutput(output);
      expect(parsed).toEqual({ minionChatId: 'minion_abc', hasCoT: false, body: 'Some result' });
    });

    it('parses output with hasCoT tag', () => {
      const output = '<minionChatId>minion_abc</minionChatId>\n<hasCoT />\nSome result';
      const parsed = parseSimplifiedOutput(output);
      expect(parsed).toEqual({ minionChatId: 'minion_abc', hasCoT: true, body: 'Some result' });
    });

    it('parses output with hasCoT but empty body', () => {
      const output = '<minionChatId>minion_abc</minionChatId>\n<hasCoT />\n';
      const parsed = parseSimplifiedOutput(output);
      expect(parsed).toEqual({ minionChatId: 'minion_abc', hasCoT: true, body: '' });
    });

    it('returns undefined for non-matching output', () => {
      expect(parseSimplifiedOutput('plain text')).toBeUndefined();
    });
  });

  describe('renderOutput hasCoT', () => {
    it('shows CoT indicator in JSON format when hasCoT is true', () => {
      const output = JSON.stringify({
        hasCoT: true,
        text: 'output',
        stopReason: 'end_turn',
        minionChatId: 'minion_abc',
      });
      const rendered = minionTool.renderOutput!(output, false);
      expect(rendered).toContain('[CoT: yes]');
      expect(rendered).toContain('Text output captured.');
      expect(rendered).toContain('[minionChatId: minion_abc]');
    });

    it('omits CoT indicator in JSON format when hasCoT is false', () => {
      const output = JSON.stringify({
        hasCoT: false,
        text: 'output',
        stopReason: 'end_turn',
        minionChatId: 'minion_abc',
      });
      const rendered = minionTool.renderOutput!(output, false);
      expect(rendered).not.toContain('[CoT');
    });

    it('shows CoT indicator in simplified format when hasCoT tag present', () => {
      const output = '<minionChatId>minion_abc</minionChatId>\n<hasCoT />\nResult text';
      const rendered = minionTool.renderOutput!(output, false);
      expect(rendered).toContain('[CoT: yes]');
      expect(rendered).toContain('Result text');
      expect(rendered).toContain('[minionChatId: minion_abc]');
    });

    it('omits CoT indicator in simplified format when no hasCoT tag', () => {
      const output = '<minionChatId>minion_abc</minionChatId>\nResult text';
      const rendered = minionTool.renderOutput!(output, false);
      expect(rendered).not.toContain('[CoT');
      expect(rendered).toContain('Result text');
    });
  });

  describe('buildMinionTools', () => {
    const project = ['js', 'fs', 'memory', 'minion'];

    it('intersects requested tools with project tools', () => {
      expect(buildMinionTools(['js', 'web'], project, false)).toEqual(['js']);
    });

    it('returns no tools when none requested', () => {
      expect(buildMinionTools(undefined, project, false)).toEqual([]);
      expect(buildMinionTools([], project, false)).toEqual([]);
    });

    it('appends the return tool when includeReturn is set', () => {
      expect(buildMinionTools(['js'], project, true)).toEqual(['js', 'return']);
    });

    it("strips 'minion' by default (nesting gate off)", () => {
      expect(buildMinionTools(['js', 'minion'], project, false)).toEqual(['js']);
    });

    it("keeps 'minion' when includeMinion is true (nesting allowed under cap)", () => {
      expect(buildMinionTools(['js', 'minion'], project, false, true)).toEqual(['js', 'minion']);
    });

    it("only keeps 'minion' if it is also a project tool", () => {
      expect(buildMinionTools(['js', 'minion'], ['js', 'fs'], false, true)).toEqual(['js']);
    });

    it("auto-adds 'minion' when granted even if not requested (authoritative grant)", () => {
      expect(buildMinionTools(['js'], project, false, true)).toEqual(['js', 'minion']);
    });

    it("drops 'minion' when not granted even if requested", () => {
      expect(buildMinionTools(['js', 'minion'], project, false, false)).toEqual(['js']);
    });
  });

  describe('resolveChildNesting', () => {
    it('requires all three gates: project + grant + depth', () => {
      // project off → never
      expect(resolveChildNesting(false, true, 1, 3)).toBe(false);
      // no per-call grant → never (explicit opt-in)
      expect(resolveChildNesting(true, false, 1, 3)).toBe(false);
      // all gates pass, depth ok (grandchild at 2 <= 3)
      expect(resolveChildNesting(true, true, 1, 3)).toBe(true);
    });

    it('blocks when a grandchild would exceed the cap', () => {
      // childDepth 3, cap 3 → grandchild at 4 > 3
      expect(resolveChildNesting(true, true, 3, 3)).toBe(false);
      // childDepth 2, cap 3 → grandchild at 3 <= 3
      expect(resolveChildNesting(true, true, 2, 3)).toBe(true);
    });
  });

  describe('checkPersonaDelegation', () => {
    it('allows anything when the ceiling is unrestricted (root)', () => {
      expect(checkPersonaDelegation(undefined, 'a', ['a', 'b'])).toBeNull();
    });

    it('allows a persona within the ceiling and an exempt default', () => {
      expect(checkPersonaDelegation(['b', 'c', 'd'], 'c', undefined)).toBeNull();
      expect(checkPersonaDelegation(['b', 'c', 'd'], 'default', undefined)).toBeNull();
    });

    it('rejects adopting a persona outside the ceiling', () => {
      const err = checkPersonaDelegation(['b', 'c', 'd'], 'a', undefined);
      expect(err).toContain('persona "a"');
      expect(err).toContain('b, c, d');
    });

    it('rejects granting personas outside the ceiling', () => {
      const err = checkPersonaDelegation(['b', 'c', 'd'], 'b', ['c', 'a']);
      expect(err).toContain('cannot grant');
      expect(err).toContain('a');
    });

    it('allows granting a subset of the ceiling', () => {
      expect(checkPersonaDelegation(['b', 'c', 'd'], 'b', ['c', 'd'])).toBeNull();
    });
  });

  describe('execute', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('returns Phase 1 error when message action has no message', async () => {
      const result = await collectToolResult(
        minionTool.execute({}, undefined, {
          projectId: 'proj_123',
          vfsAdapter: mockAdapter,
          createVfsAdapter: mockAdapterFactory,
          signal: new AbortController().signal,
          ...mockDeps,
        })
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('"message" is required');
      expect(result.content).toContain('Resend to reattempt.');
    });

    it('returns Phase 1 error when retry action has no minionChatId', async () => {
      const result = await collectToolResult(
        minionTool.execute({ action: 'retry' }, undefined, {
          projectId: 'proj_123',
          vfsAdapter: mockAdapter,
          createVfsAdapter: mockAdapterFactory,
          signal: new AbortController().signal,
          ...mockDeps,
        })
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('"minionChatId" is required');
      expect(result.content).toContain('Resend to reattempt.');
    });

    it('returns Phase 1 error when projectId is missing', async () => {
      const result = await collectToolResult(
        minionTool.execute({ message: 'test' }, undefined, undefined)
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('projectId is required');
      expect(result.content).toContain('Resend to reattempt.');
    });

    it('returns a depth-cap error when nesting would exceed the default max', async () => {
      // minionDepth 3 → child would run at depth 4, over the default cap of 3.
      const result = await collectToolResult(
        minionTool.execute({ message: 'go deeper' }, undefined, {
          projectId: 'proj_123',
          minionDepth: 3,
          vfsAdapter: mockAdapter,
          createVfsAdapter: mockAdapterFactory,
          signal: new AbortController().signal,
          ...mockDeps,
        })
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('max minion nesting depth (3)');
      // Fires before any chat is created.
      expect(mockStorage.saveMinionChat).not.toHaveBeenCalled();
    });

    it('honors a custom maxNestingDepth tool option for the cap', async () => {
      // maxNestingDepth 1 → even a top-level minion (childDepth 1) is allowed,
      // but a depth-1 minion spawning a child (childDepth 2) is rejected.
      const result = await collectToolResult(
        minionTool.execute(
          { message: 'go deeper' },
          { maxNestingDepth: 1 },
          {
            projectId: 'proj_123',
            minionDepth: 1,
            vfsAdapter: mockAdapter,
            createVfsAdapter: mockAdapterFactory,
            signal: new AbortController().signal,
            ...mockDeps,
          }
        )
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('max minion nesting depth (1)');
    });

    it('does not trip the depth cap for an under-cap minion call', async () => {
      // minionDepth 1, default cap 3 → child at depth 2 is allowed, so the
      // call proceeds past the guard and fails later (model not configured).
      const result = await collectToolResult(
        minionTool.execute({ message: 'task' }, undefined, {
          projectId: 'proj_123',
          minionDepth: 1,
          vfsAdapter: mockAdapter,
          createVfsAdapter: mockAdapterFactory,
          signal: new AbortController().signal,
          ...mockDeps,
        })
      );
      expect(result.content).not.toContain('max minion nesting depth');
    });

    it('returns checksum mismatch error for garbled minionChatId', async () => {
      // 34-char random part with wrong checksum → LLM copy error
      const garbledId = 'minion_' + 'a'.repeat(34);
      const result = await collectToolResult(
        minionTool.execute({ message: 'test', minionChatId: garbledId }, undefined, {
          projectId: 'proj_123',
          vfsAdapter: mockAdapter,
          createVfsAdapter: mockAdapterFactory,
          signal: new AbortController().signal,
          ...mockDeps,
        })
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('checksum mismatch');
    });

    it('returns Phase 2 error when model is not configured (after chat creation)', async () => {
      const result = await collectToolResult(
        minionTool.execute(
          { message: 'test' },
          {}, // No model configured
          {
            projectId: 'proj_123',
            vfsAdapter: mockAdapter,
            createVfsAdapter: mockAdapterFactory,
            signal: new AbortController().signal,
            ...mockDeps,
          }
        )
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('Minion model not configured');
      expect(result.content).toContain('Resend to reattempt.');
    });

    it('returns Phase 2 error when input.model provided but models list not configured', async () => {
      const result = await collectToolResult(
        minionTool.execute(
          { message: 'test', model: 'api_1:claude-3' },
          { model: { apiDefinitionId: 'api_1', modelId: 'claude-3' } },
          {
            projectId: 'proj_123',
            vfsAdapter: mockAdapter,
            createVfsAdapter: mockAdapterFactory,
            signal: new AbortController().signal,
            ...mockDeps,
          }
        )
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('no models list configured');
    });

    it('returns Phase 2 error when input.model is not in configured models list', async () => {
      const models: ModelReference[] = [{ apiDefinitionId: 'api_1', modelId: 'claude-3' }];
      const result = await collectToolResult(
        minionTool.execute(
          { message: 'test', model: 'api_2:gpt-4' },
          { model: { apiDefinitionId: 'api_1', modelId: 'claude-3' }, models },
          {
            projectId: 'proj_123',
            vfsAdapter: mockAdapter,
            createVfsAdapter: mockAdapterFactory,
            signal: new AbortController().signal,
            ...mockDeps,
          }
        )
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('not in the configured models list');
      expect(result.content).toContain('api_1:claude-3');
    });

    it('returns Phase 2 error when input.model has invalid format', async () => {
      const models: ModelReference[] = [{ apiDefinitionId: 'api_1', modelId: 'claude-3' }];
      const result = await collectToolResult(
        minionTool.execute(
          { message: 'test', model: 'nocolon' },
          { model: { apiDefinitionId: 'api_1', modelId: 'claude-3' }, models },
          {
            projectId: 'proj_123',
            vfsAdapter: mockAdapter,
            createVfsAdapter: mockAdapterFactory,
            signal: new AbortController().signal,
            ...mockDeps,
          }
        )
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('Invalid model format');
    });

    it('exports SAVEPOINT_START sentinel', () => {
      expect(SAVEPOINT_START).toBe('_start');
    });
  });

  describe('stripNsPrefix', () => {
    it('returns path unchanged when no prefix', () => {
      expect(stripNsPrefix('/minions/code/notes.md')).toBe('/minions/code/notes.md');
      expect(stripNsPrefix('/minions/code/notes.md', undefined)).toBe('/minions/code/notes.md');
    });

    it('strips matching namespace prefix from path', () => {
      expect(stripNsPrefix('/minions/code/notes.md', '/minions/code')).toBe('/notes.md');
      expect(stripNsPrefix('/minions/code/deep/file.ts', '/minions/code')).toBe('/deep/file.ts');
    });

    it('returns / when path equals the prefix exactly', () => {
      expect(stripNsPrefix('/minions/code', '/minions/code')).toBe('/');
    });

    it('does not strip non-matching prefix', () => {
      expect(stripNsPrefix('/share/common.md', '/minions/code')).toBe('/share/common.md');
      expect(stripNsPrefix('/other/path.md', '/minions/code')).toBe('/other/path.md');
    });

    it('does not strip partial prefix match', () => {
      // /minions/coder should NOT match /minions/code
      expect(stripNsPrefix('/minions/coder/file.md', '/minions/code')).toBe(
        '/minions/coder/file.md'
      );
    });
  });

  describe('systemPrompt persona listing (getMinionSystemPromptInjection)', () => {
    const PERSONA_FILES = [
      { name: 'research.md', type: 'file' as const },
      { name: 'reviewer.md', type: 'file' as const },
    ];

    /** Build a VFS adapter stub exposing two personas under /minions/. */
    function buildPersonaAdapter() {
      const readFile = vi.fn(async (path: string) => {
        if (path === '/minions/research.md') return '# Deep research agent\nbody';
        if (path === '/minions/reviewer.md') return 'Code review specialist\nbody';
        throw new Error(`unexpected readFile ${path}`);
      });
      const adapter = {
        isDirectory: vi.fn(async () => true),
        readDir: vi.fn(async () => PERSONA_FILES),
        readFile,
      } as unknown as VfsAdapter;
      return { adapter, readFile };
    }

    function buildCtx(adapter: VfsAdapter): SystemPromptContext {
      return {
        projectId: 'test-project',
        apiDefinitionId: 'test-api',
        modelId: 'test-model',
        apiType: 'chatgpt',
        createVfsAdapter: () => adapter,
      };
    }

    const injection = minionTool.systemPrompt as (
      ctx: SystemPromptContext,
      opts: ToolOptions
    ) => Promise<string>;

    it('returns empty string when namespacedMinion is off regardless of mode', async () => {
      const { adapter } = buildPersonaAdapter();
      expect(await injection(buildCtx(adapter), { namespacedMinion: 'off' })).toBe('');
      expect(
        await injection(buildCtx(adapter), {
          namespacedMinion: 'off',
          personaListingMode: 'detailed',
        })
      ).toBe('');
    });

    it('detailed (default) lists each persona name with its first-line gist', async () => {
      const { adapter, readFile } = buildPersonaAdapter();
      const result = await injection(buildCtx(adapter), { namespacedMinion: 'persona' });

      expect(result).toContain('## Available Minion Personas');
      expect(result).toContain('- **research**: Deep research agent');
      expect(result).toContain('- **reviewer**: Code review specialist');
      expect(result).toContain('Use the `persona` parameter');
      expect(readFile).toHaveBeenCalled();
    });

    it('name-only lists names without gists and never reads persona bodies', async () => {
      const { adapter, readFile } = buildPersonaAdapter();
      const result = await injection(buildCtx(adapter), {
        namespacedMinion: 'persona',
        personaListingMode: 'name-only',
      });

      expect(result).toContain('## Available Minion Personas');
      expect(result).toContain('- **research**');
      expect(result).toContain('- **reviewer**');
      expect(result).not.toContain('Deep research agent');
      expect(result).not.toContain('Code review specialist');
      expect(result).toContain('Use the `persona` parameter');
      expect(readFile).not.toHaveBeenCalled();
    });

    it('none returns empty string and does not touch the VFS', async () => {
      const { adapter } = buildPersonaAdapter();
      const result = await injection(buildCtx(adapter), {
        namespacedMinion: 'persona',
        personaListingMode: 'none',
      });

      expect(result).toBe('');
      expect(adapter.readDir).not.toHaveBeenCalled();
      expect(adapter.isDirectory).not.toHaveBeenCalled();
    });

    it('filters the listing to minionAvailablePersonas when the loop has a ceiling', async () => {
      const { adapter } = buildPersonaAdapter();
      const ctx = { ...buildCtx(adapter), minionAvailablePersonas: ['reviewer'] };
      const result = await injection(ctx, { namespacedMinion: 'persona' });

      expect(result).toContain('- **reviewer**');
      expect(result).not.toContain('- **research**');
    });

    it('returns empty string when the ceiling excludes every persona', async () => {
      const { adapter } = buildPersonaAdapter();
      const ctx = { ...buildCtx(adapter), minionAvailablePersonas: [] };
      const result = await injection(ctx, { namespacedMinion: 'persona' });

      expect(result).toBe('');
    });
  });
});

describe('claude-agent SDK rewind on failure', () => {
  // Minimal message factories — the rewind scan only reads id/role/metadata.
  const asst = (id: string, uuid?: string): Message<unknown> =>
    ({
      id,
      role: 'assistant',
      ...(uuid ? { metadata: { claudeAgentMessageUuid: uuid } } : {}),
    }) as unknown as Message<unknown>;
  const user = (id: string): Message<unknown> =>
    ({ id, role: 'user' }) as unknown as Message<unknown>;

  describe('findPriorAssistantClaudeAgentUuid', () => {
    it('returns undefined on a first turn (savepoint = SAVEPOINT_START)', () => {
      expect(
        findPriorAssistantClaudeAgentUuid([asst('msg_a', 'uuid-a')], SAVEPOINT_START)
      ).toBeUndefined();
    });

    it('returns undefined when the savepoint id is absent from the messages', () => {
      expect(
        findPriorAssistantClaudeAgentUuid([asst('msg_a', 'uuid-a')], 'msg_missing')
      ).toBeUndefined();
    });

    it('returns the assistant uuid sitting at the savepoint', () => {
      expect(
        findPriorAssistantClaudeAgentUuid([user('msg_u'), asst('msg_a', 'uuid-a')], 'msg_a')
      ).toBe('uuid-a');
    });

    it('walks back past uuid-less / non-assistant messages to the prior assistant', () => {
      const messages = [asst('msg_a1', 'uuid-1'), user('msg_u'), asst('msg_a2'), user('msg_tr')];
      // savepoint is the trailing tool-result message; the scan lands on the
      // most recent assistant that carries a uuid.
      expect(findPriorAssistantClaudeAgentUuid(messages, 'msg_tr')).toBe('uuid-1');
    });
  });

  describe('applyClaudeAgentRewindOnFailure', () => {
    const makeStorage = () => {
      const saveMinionChat = vi.fn(() => Promise.resolve());
      return { storage: { saveMinionChat } as unknown as UnifiedStorage, saveMinionChat };
    };
    const makeChat = (over: Partial<MinionChat> = {}): MinionChat =>
      ({
        id: 'minion_1',
        savepoint: 'msg_a',
        claudeAgentSessionId: 'sess-1',
        claudeAgentResumeAt: undefined,
        ...over,
      }) as unknown as MinionChat;

    it('is a no-op for non-claude-agent minions (fields untouched, no save)', async () => {
      const { storage, saveMinionChat } = makeStorage();
      const chat = makeChat();
      await applyClaudeAgentRewindOnFailure(
        storage,
        chat,
        false,
        [asst('msg_a', 'uuid-a')],
        [],
        'turn error'
      );
      expect(saveMinionChat).not.toHaveBeenCalled();
      expect(chat.claudeAgentSessionId).toBe('sess-1');
      expect(chat.claudeAgentResumeAt).toBeUndefined();
    });

    it('rewinds to the prior assistant turn on a non-first-turn failure (session preserved)', async () => {
      const { storage, saveMinionChat } = makeStorage();
      const chat = makeChat({ savepoint: 'msg_a' });
      await applyClaudeAgentRewindOnFailure(
        storage,
        chat,
        true,
        [user('msg_u'), asst('msg_a', 'uuid-a')], // history up to the savepoint
        [asst('msg_failed', 'uuid-failed')], // the failed turn's new messages
        'turn error'
      );
      expect(chat.claudeAgentResumeAt).toBe('uuid-a');
      expect(chat.claudeAgentSessionId).toBe('sess-1');
      expect(saveMinionChat).toHaveBeenCalledOnce();
    });

    it('drops the SDK session on a first-turn failure (no prior assistant)', async () => {
      const { storage, saveMinionChat } = makeStorage();
      const chat = makeChat({ savepoint: SAVEPOINT_START });
      await applyClaudeAgentRewindOnFailure(
        storage,
        chat,
        true,
        [],
        [asst('msg_failed', 'uuid-failed')],
        'turn error'
      );
      expect(chat.claudeAgentSessionId).toBeUndefined();
      expect(chat.claudeAgentResumeAt).toBeUndefined();
      expect(saveMinionChat).toHaveBeenCalledOnce();
    });

    it('drops the SDK session when the prior turn carries no message uuid', async () => {
      const { storage, saveMinionChat } = makeStorage();
      const chat = makeChat({ savepoint: 'msg_a' });
      await applyClaudeAgentRewindOnFailure(
        storage,
        chat,
        true,
        [asst('msg_a')],
        [],
        'abnormal stop'
      );
      expect(chat.claudeAgentSessionId).toBeUndefined();
      expect(chat.claudeAgentResumeAt).toBeUndefined();
      expect(saveMinionChat).toHaveBeenCalledOnce();
    });
  });

  describe('applyClaudeAgentRewindOnRollback', () => {
    const makeStorage = () => {
      const saveMinionChat = vi.fn(() => Promise.resolve());
      return { storage: { saveMinionChat } as unknown as UnifiedStorage, saveMinionChat };
    };
    const makeChat = (over: Partial<MinionChat> = {}): MinionChat =>
      ({
        id: 'minion_1',
        claudeAgentSessionId: 'sess-1',
        claudeAgentResumeAt: undefined,
        ...over,
      }) as unknown as MinionChat;
    // A minion conversation: user, assistant(uuid-1), tool-result, assistant(uuid-3), user
    const convo = (): Message<unknown>[] => [
      user('m0'),
      asst('m1', 'uuid-1'),
      user('m2'),
      asst('m3', 'uuid-3'),
      user('m4'),
    ];

    it('is a no-op for non-claude-agent minions (no save, fields untouched)', async () => {
      const { storage, saveMinionChat } = makeStorage();
      const chat = makeChat({ claudeAgentSessionId: undefined });
      await applyClaudeAgentRewindOnRollback(storage, chat, convo(), 'm2');
      expect(saveMinionChat).not.toHaveBeenCalled();
      expect(chat.claudeAgentResumeAt).toBeUndefined();
    });

    it('sets resumeAt to the kept assistant tail uuid (session preserved)', async () => {
      const { storage, saveMinionChat } = makeStorage();
      const chat = makeChat();
      // Roll back to assistant m1: delete from m2 onward, kept tail = m1.
      await applyClaudeAgentRewindOnRollback(storage, chat, convo(), 'm2');
      expect(chat.claudeAgentResumeAt).toBe('uuid-1');
      expect(chat.claudeAgentSessionId).toBe('sess-1');
      expect(saveMinionChat).toHaveBeenCalledOnce();
    });

    it('walks back past a uuid-less kept tail to the prior assistant uuid', async () => {
      const { storage, saveMinionChat } = makeStorage();
      const chat = makeChat();
      // Kept tail m2 is an assistant with no uuid → scan lands on m1's uuid-1.
      const messages = [user('m0'), asst('m1', 'uuid-1'), asst('m2'), user('m3')];
      await applyClaudeAgentRewindOnRollback(storage, chat, messages, 'm3');
      expect(chat.claudeAgentResumeAt).toBe('uuid-1');
      expect(saveMinionChat).toHaveBeenCalledOnce();
    });

    it('drops the SDK session when rolling back to the very start', async () => {
      const { storage, saveMinionChat } = makeStorage();
      const chat = makeChat();
      // firstDeleted is the first message → nothing kept → no prior assistant.
      await applyClaudeAgentRewindOnRollback(storage, chat, convo(), 'm0');
      expect(chat.claudeAgentSessionId).toBeUndefined();
      expect(chat.claudeAgentResumeAt).toBeUndefined();
      expect(saveMinionChat).toHaveBeenCalledOnce();
    });

    it('drops the SDK session when the kept tail has no prior assistant', async () => {
      const { storage, saveMinionChat } = makeStorage();
      const chat = makeChat();
      const messages = [user('m0'), user('m1'), asst('m2', 'uuid-2')];
      await applyClaudeAgentRewindOnRollback(storage, chat, messages, 'm1');
      expect(chat.claudeAgentSessionId).toBeUndefined();
      expect(chat.claudeAgentResumeAt).toBeUndefined();
      expect(saveMinionChat).toHaveBeenCalledOnce();
    });

    it('is a no-op when the cutoff message id is absent (no save, fields untouched)', async () => {
      const { storage, saveMinionChat } = makeStorage();
      const chat = makeChat();
      await applyClaudeAgentRewindOnRollback(storage, chat, convo(), 'm_missing');
      expect(saveMinionChat).not.toHaveBeenCalled();
      expect(chat.claudeAgentResumeAt).toBeUndefined();
      expect(chat.claudeAgentSessionId).toBe('sess-1');
    });
  });
});

describe('resolveRetryStash', () => {
  const stash = {
    modelFamily: 'anthropic',
    fullContent: [{ type: 'tool_result', content: 'original payload' }],
    renderingContent: undefined,
    injectedFiles: undefined,
    injectionMode: undefined,
  };

  it('hands back the stash when the recovered original is auto-resent', () => {
    const r = resolveRetryStash(
      { stashedRetryContent: stash, recoveredMessage: 'play e4' },
      'play e4'
    );
    expect(r.isTrueRetry).toBe(true);
    expect(r.stash).toBe(stash);
  });

  it('drops the stash when a different message arrives after the rollback', () => {
    // The "hi after abort" case: reusing the stash would render (and for
    // fullContent-canon providers, send) the rolled-back message instead.
    const r = resolveRetryStash({ stashedRetryContent: stash, recoveredMessage: 'play e4' }, 'hi');
    expect(r.isTrueRetry).toBe(false);
    expect(r.stash).toBeUndefined();
  });

  it('drops the stash when no original could be recovered', () => {
    const r = resolveRetryStash(
      { stashedRetryContent: stash, recoveredMessage: undefined },
      'play e4'
    );
    expect(r.isTrueRetry).toBe(false);
    expect(r.stash).toBeUndefined();
  });

  it('is not a true retry when nothing was rolled back', () => {
    const r = resolveRetryStash(
      { stashedRetryContent: undefined, recoveredMessage: undefined },
      'play e4'
    );
    expect(r.isTrueRetry).toBe(false);
    expect(r.stash).toBeUndefined();
  });
});

describe('stripVerifyFeedbackNote', () => {
  const note = '[Previous attempt was rejected by verification: empty output]';

  it('returns text without a note unchanged', () => {
    expect(stripVerifyFeedbackNote('play e4')).toBe('play e4');
  });

  it('strips a trailing verify-feedback note', () => {
    expect(stripVerifyFeedbackNote(`play e4\n\n${note}`)).toBe('play e4');
  });

  it('strips a note whose reason spans multiple lines', () => {
    const multiline = '[Previous attempt was rejected by verification: bad\nmove]';
    expect(stripVerifyFeedbackNote(`play e4\n\n${multiline}`)).toBe('play e4');
  });

  it('leaves a note-like fragment alone when it does not end the message', () => {
    const text = `play e4\n\n${note} and more text`;
    expect(stripVerifyFeedbackNote(text)).toBe(text);
  });
});

describe('minion chat busy guard', () => {
  const makeContext = (registry: LoopRegistry) => ({
    projectId: 'proj_123',
    vfsAdapter: mockAdapter,
    createVfsAdapter: mockAdapterFactory,
    signal: new AbortController().signal,
    ...mockDeps,
    loopRegistry: registry,
  });

  it('rejects a concurrent send to a held minion chat id without stealing the hold', async () => {
    const registry = new LoopRegistry();
    expect(registry.acquireMinionChat('minion_held')).toBe(true);

    const result = await collectToolResult(
      minionTool.execute(
        { message: 'hi', minionChatId: 'minion_held' },
        undefined,
        makeContext(registry)
      )
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('busy');
    // The rejected call must not have released the first caller's hold.
    expect(registry.acquireMinionChat('minion_held')).toBe(false);
    registry.releaseMinionChat('minion_held');
  });

  it('releases the hold when a call finishes, even on an error result', async () => {
    const registry = new LoopRegistry();
    const garbledId = 'minion_' + 'a'.repeat(34);

    const result = await collectToolResult(
      minionTool.execute(
        { message: 'hi', minionChatId: garbledId },
        undefined,
        makeContext(registry)
      )
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('checksum mismatch');
    // Failed inside the guarded body → the finally released the hold.
    expect(registry.acquireMinionChat(garbledId)).toBe(true);
  });
});
