/**
 * Tests for minionTool
 *
 * Tests the minion tool's helper functions and configuration.
 * Full integration tests would require mocking the entire agentic loop.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  minionTool,
  SAVEPOINT_START,
  formatModelString,
  parseModelString,
  resolveMinionModelRef,
  buildMinionTools,
  resolveChildNesting,
  checkPersonaDelegation,
  minionPromptErrorText,
  truncateError,
  parseSimplifiedOutput,
  stripNsPrefix,
  findPriorAssistantClaudeAgentUuid,
  applyClaudeAgentRewindOnFailure,
  applyClaudeAgentRewindOnRollback,
  resolveRetryStash,
  stripVerifyFeedbackNote,
  hasInjectSpecs,
  formatMinionResult,
  isRemoteCall,
  readRemoteFlag,
  resolveRemoteTimeoutMs,
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
  ToolContext,
  ToolStreamEvent,
} from '../../../protocol/types';
import type {
  RenderingBlockGroup,
  ToolInfoRenderBlock,
  ToolResultRenderBlock,
} from '../../../protocol/types/content';
import type { VfsAdapter } from '../../vfs/vfsAdapter';
import { UnifiedStorage } from '../../storage/unifiedStorage';
import type { EncryptionCore } from '../../encryption/encryptionCore';
import {
  createMockAdapter,
  createMockEncryptionService,
  createTestProject,
} from '../../storage/__tests__/testUtils';
import { generateChecksummedId } from '../../../protocol/idGenerator';
import { formatFileWithLineNumbers } from '../../../engine/lib/formatFileContent';
import { stubBackendDeps } from './testStubs';
import { AgentPromptError } from '../../agentic/agentSystemPrompt';

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

    it('description and message schema say message may be omitted for inject-only calls', () => {
      const descFn = minionTool.description;
      if (typeof descFn !== 'function') throw new Error('Expected description to be a function');
      expect(descFn({})).toContain('message may be omitted');
      const schema =
        typeof minionTool.inputSchema === 'function'
          ? minionTool.inputSchema({})
          : minionTool.inputSchema;
      const message = schema.properties.message as { description: string };
      expect(message.description).toContain('unless injectFiles / injectFilesAfter');
      expect(schema.required).not.toContain('message');
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

    it('schema gates prePersonaSystemPromptFile on namespacedMinion', () => {
      const buildSchema = (opts: ToolOptions) =>
        typeof minionTool.inputSchema === 'function'
          ? minionTool.inputSchema(opts)
          : minionTool.inputSchema;
      expect(buildSchema({ namespacedMinion: 'all' }).properties).toHaveProperty(
        'prePersonaSystemPromptFile'
      );
      expect(buildSchema({ namespacedMinion: 'persona' }).properties).toHaveProperty(
        'prePersonaSystemPromptFile'
      );
      expect(buildSchema({ namespacedMinion: 'off' }).properties).not.toHaveProperty(
        'prePersonaSystemPromptFile'
      );
      expect(buildSchema({}).properties).not.toHaveProperty('prePersonaSystemPromptFile');
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

    it('renders an inject-only call without a trailing blank message line', () => {
      const result = minionTool.renderInput!({ injectFiles: ['/a.ts'] });
      expect(result).toContain('Files: /a.ts');
      expect(result.endsWith('\n')).toBe(false);
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
      expect(parsed).toEqual({
        minionChatId: 'minion_abc',
        hasCoT: false,
        remote: false,
        body: 'Some result',
      });
    });

    it('parses output with hasCoT tag', () => {
      const output = '<minionChatId>minion_abc</minionChatId>\n<hasCoT />\nSome result';
      const parsed = parseSimplifiedOutput(output);
      expect(parsed).toEqual({
        minionChatId: 'minion_abc',
        hasCoT: true,
        remote: false,
        body: 'Some result',
      });
    });

    it('parses output with hasCoT but empty body', () => {
      const output = '<minionChatId>minion_abc</minionChatId>\n<hasCoT />\n';
      const parsed = parseSimplifiedOutput(output);
      expect(parsed).toEqual({ minionChatId: 'minion_abc', hasCoT: true, remote: false, body: '' });
    });

    it('returns undefined for non-matching output', () => {
      expect(parseSimplifiedOutput('plain text')).toBeUndefined();
    });

    it('parses the remote marker line', () => {
      const output = '<minionChatId>minion_abc</minionChatId>\n<remote />\nShip it';
      expect(parseSimplifiedOutput(output)).toEqual({
        minionChatId: 'minion_abc',
        hasCoT: false,
        remote: true,
        body: 'Ship it',
      });
    });

    it('only reads markers from the header, not from the body', () => {
      const output = '<minionChatId>minion_abc</minionChatId>\nThe tag <hasCoT /> is literal';
      expect(parseSimplifiedOutput(output)?.hasCoT).toBe(false);
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

  // The three strings below are the LLM's recovery instructions, not log
  // output — `resolveAgentSystemPrompt` throws typed errors and this mapper is
  // what preserves the wording the model has always seen. Byte-for-byte.
  describe('minionPromptErrorText', () => {
    it('reproduces the pre-persona failure text with its three recovery options', () => {
      const err = new AgentPromptError(
        'pre_persona_read_failed',
        '/custom/global.md',
        new Error('boom')
      );
      expect(minionPromptErrorText(err)).toBe(
        "Error: Failed to read prePersonaSystemPromptFile: /custom/global.md. boom Pass a corrected path, '' to disable, or '/minions/_global.md' to restore the default. Resend to reattempt."
      );
    });

    it('reproduces the persona-not-found text', () => {
      const err = new AgentPromptError('persona_not_found', '/minions/ghost.md');
      expect(minionPromptErrorText(err)).toBe(
        'Error: Persona file /minions/ghost.md not found. Create the file or use a different persona. Resend to reattempt.'
      );
    });

    it('reproduces the prompt-file failure text', () => {
      const err = new AgentPromptError('prompt_file_read_failed', '/a.md', new Error('nope'));
      expect(minionPromptErrorText(err)).toBe(
        'Error: Failed to read system prompt file: /a.md. nope'
      );
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

    it('inject-only call (no message) passes the Phase 1 message gate', async () => {
      const result = await collectToolResult(
        minionTool.execute({ injectFiles: ['/a.ts'] }, undefined, {
          projectId: 'proj_123',
          vfsAdapter: mockAdapter,
          createVfsAdapter: mockAdapterFactory,
          signal: new AbortController().signal,
          ...mockDeps,
        })
      );
      // Later phases still fail in this bare harness (no model configured),
      // but never on the message requirement.
      expect(result.content).not.toContain('"message" is required');
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
  const asst = (id: string, uuid?: string, sessionId?: string): Message<unknown> =>
    ({
      id,
      role: 'assistant',
      ...(uuid
        ? {
            metadata: {
              claudeAgentMessageUuid: uuid,
              ...(sessionId ? { claudeAgentSessionId: sessionId } : {}),
            },
          }
        : {}),
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
      ).toEqual({ uuid: 'uuid-a', sessionId: undefined });
    });

    it('walks back past uuid-less / non-assistant messages to the prior assistant', () => {
      const messages = [asst('msg_a1', 'uuid-1'), user('msg_u'), asst('msg_a2'), user('msg_tr')];
      // savepoint is the trailing tool-result message; the scan lands on the
      // most recent assistant that carries a uuid.
      expect(findPriorAssistantClaudeAgentUuid(messages, 'msg_tr')).toEqual({
        uuid: 'uuid-1',
        sessionId: undefined,
      });
    });

    it('returns the stamped owning session alongside the uuid', () => {
      expect(
        findPriorAssistantClaudeAgentUuid([asst('msg_a', 'uuid-a', 'sess-old')], 'msg_a')
      ).toEqual({ uuid: 'uuid-a', sessionId: 'sess-old' });
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

    it('repoints the session to the anchor message stamp when present', async () => {
      const { storage, saveMinionChat } = makeStorage();
      const chat = makeChat({ savepoint: 'msg_a' });
      await applyClaudeAgentRewindOnFailure(
        storage,
        chat,
        true,
        [user('msg_u'), asst('msg_a', 'uuid-a', 'sess-old')],
        [asst('msg_failed', 'uuid-failed', 'sess-1')],
        'turn error'
      );
      expect(chat.claudeAgentResumeAt).toBe('uuid-a');
      expect(chat.claudeAgentSessionId).toBe('sess-old');
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

    it('repoints the session to the kept anchor message stamp when present', async () => {
      const { storage, saveMinionChat } = makeStorage();
      const chat = makeChat();
      const messages = [user('m0'), asst('m1', 'uuid-1', 'sess-old'), user('m2')];
      await applyClaudeAgentRewindOnRollback(storage, chat, messages, 'm2');
      expect(chat.claudeAgentResumeAt).toBe('uuid-1');
      expect(chat.claudeAgentSessionId).toBe('sess-old');
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

describe('hasInjectSpecs', () => {
  it('is true when either batch has at least one entry', () => {
    expect(hasInjectSpecs({ injectFiles: ['/a.ts'] })).toBe(true);
    expect(hasInjectSpecs({ injectFilesAfter: [{ path: '/a.ts' }] })).toBe(true);
  });

  it('is false for empty or absent batches', () => {
    expect(hasInjectSpecs({})).toBe(false);
    expect(hasInjectSpecs({ injectFiles: [], injectFilesAfter: [] })).toBe(false);
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

describe('remote (human) minions', () => {
  const REMOTE_OPTIONS: ToolOptions = {
    // Pasted with the /web/ suffix on purpose: the client trims it.
    remoteEndpoint: 'http://tg.test:3004/web/',
    remotePassword: 'pw',
  };

  function jsonResponse(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      redirected: false,
      url: '',
      text: () => Promise.resolve(JSON.stringify(body)),
    } as unknown as Response;
  }

  function holdFor(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    });
  }

  /** In-memory Touch Grass backend speaking the v2.1 contract. */
  class FakeTouchGrass {
    readonly calls: Array<{ method: string; path: string; body: any; auth: string }> = [];
    readonly sessions = new Set<string>();
    /** AI messages per session, and the request each one opened. */
    readonly messages = new Map<
      string,
      Array<{ role: 'ai'; content: string; files: unknown; awaitsReply: boolean }>
    >();
    readonly pending = new Map<string, { requestId: string; expiresAt: string | null }>();
    /** Acts like a 2.0 backend: `awaitReply: false` still opens a request. */
    ignoresAwaitReply = false;
    /** What a poll returns; undefined = hold for waitMs, then report pending. */
    answer: string | undefined = 'Ship it';
    cancelState: unknown = { status: 'expired', reason: 'cancelled' };
    createSessionStatus = 201;
    /** Commit the next message, then drop the connection before the 201 arrives. */
    dropNextMessageResponse = false;
    /** Runs at that drop, e.g. to lose the session before the read-back. */
    onDrop: ((sessionId: string) => void) | undefined;
    /** When set, cancel answers only once this settles. */
    cancelGate: Promise<void> | undefined;
    /** Cancels that fail like a down backend before one gets through. */
    cancelFailures = 0;
    /** Polls answer 404, as after the human deleted the session. */
    pollGone = false;
    private seq = 0;

    readonly fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
      const { pathname, searchParams } = new URL(url);
      const method = init.method ?? 'GET';
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      const auth = (init.headers as Record<string, string>).Authorization;
      this.calls.push({ method, path: pathname, body, auth });

      if (method === 'POST' && pathname === '/api/sessions') {
        if (this.createSessionStatus !== 201) {
          return jsonResponse(this.createSessionStatus, { error: 'Unauthorized' });
        }
        const sessionId = `sess_${++this.seq}`;
        this.sessions.add(sessionId);
        return jsonResponse(201, { sessionId });
      }
      const messageMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/message$/);
      if (messageMatch) {
        const sessionId = messageMatch[1];
        if (!this.sessions.has(sessionId)) {
          return jsonResponse(404, { error: 'Session not found' });
        }
        const isNote = body.awaitReply === false && !this.ignoresAwaitReply;
        const request = isNote
          ? null
          : {
              requestId: `req_${++this.seq}`,
              expiresAt:
                body.timeoutMs === undefined
                  ? null
                  : new Date(Date.now() + body.timeoutMs).toISOString(),
            };
        const history = this.messages.get(sessionId) ?? [];
        history.push({
          role: 'ai',
          content: body.content,
          files: body.files ?? null,
          awaitsReply: !isNote,
        });
        this.messages.set(sessionId, history);
        if (request) this.pending.set(sessionId, request);
        else this.pending.delete(sessionId);
        if (this.dropNextMessageResponse) {
          this.dropNextMessageResponse = false;
          this.onDrop?.(sessionId);
          throw new TypeError('fetch failed');
        }
        return jsonResponse(201, {
          requestId: request?.requestId ?? null,
          expiresAt: request?.expiresAt ?? null,
          messageId: 'msg',
        });
      }
      const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (method === 'GET' && sessionMatch && this.sessions.has(sessionMatch[1])) {
        return jsonResponse(200, {
          session: { id: sessionMatch[1] },
          messages: this.messages.get(sessionMatch[1]) ?? [],
          pendingRequest: this.pending.get(sessionMatch[1]) ?? null,
        });
      }
      if (pathname.endsWith('/poll')) {
        if (this.pollGone) return jsonResponse(404, { error: 'Request not found' });
        if (this.answer !== undefined) {
          return jsonResponse(200, { status: 'answered', response: { content: this.answer } });
        }
        await holdFor(Number(searchParams.get('waitMs')), init.signal);
        return jsonResponse(200, { status: 'pending', expiresAt: null });
      }
      if (pathname.endsWith('/cancel')) {
        if (this.cancelFailures > 0) {
          this.cancelFailures--;
          throw new TypeError('fetch failed');
        }
        await this.cancelGate;
        return jsonResponse(200, this.cancelState);
      }
      return jsonResponse(404, { error: 'Not found' });
    });

    callsTo(suffix: string) {
      return this.calls.filter(c => c.path.endsWith(suffix));
    }
  }

  const VFS_FILES: Record<string, string> = { '/a.txt': 'alpha\nbeta', '/b.txt': 'omega' };

  let storage: UnifiedStorage;
  let backend: FakeTouchGrass;
  let abortController: AbortController;

  beforeEach(async () => {
    storage = new UnifiedStorage(
      createMockAdapter(),
      createMockEncryptionService() as unknown as EncryptionCore
    );
    await storage.saveProject(createTestProject());
    backend = new FakeTouchGrass();
    vi.stubGlobal('fetch', backend.fetch);
    abortController = new AbortController();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function makeContext(): ToolContext {
    const adapter = {
      readFile: vi.fn(async (path: string) => {
        if (!(path in VFS_FILES)) throw new Error(`ENOENT: ${path}`);
        return VFS_FILES[path];
      }),
    } as unknown as VfsAdapter;
    return {
      projectId: 'test-project-1',
      chatId: 'parent-chat',
      vfsAdapter: adapter,
      createVfsAdapter: () => adapter,
      signal: abortController.signal,
      ...stubBackendDeps,
      storage,
      loopRegistry: new LoopRegistry(),
    };
  }

  async function run(input: Record<string, unknown>, options: ToolOptions = REMOTE_OPTIONS) {
    const gen = minionTool.execute(input, options, makeContext()) as AsyncGenerator<
      ToolStreamEvent,
      ToolResult,
      void
    >;
    const events: ToolStreamEvent[] = [];
    let step = await gen.next();
    while (!step.done) {
      events.push(step.value);
      step = await gen.next();
    }
    return { events, result: step.value };
  }

  async function seedChat(overrides: Partial<MinionChat>, messages: Message<unknown>[] = []) {
    const chat: MinionChat = {
      id: generateChecksummedId('minion'),
      parentChatId: 'parent-chat',
      projectId: 'test-project-1',
      createdAt: new Date(),
      lastModifiedAt: new Date(),
      ...overrides,
    };
    await storage.saveMinionChat(chat);
    for (const m of messages) await storage.saveMinionMessage(chat.id, m);
    return chat;
  }

  const llmTurn: Message<unknown> = {
    id: 'msg_llm_1',
    role: 'user',
    content: { type: 'text', content: 'earlier LLM task' },
    timestamp: new Date('2024-01-01T00:00:00Z'),
  };

  function minionChatIdOf(result: ToolResult): string {
    return JSON.parse(result.content).minionChatId;
  }

  it('answers a new remote chat with no minion model configured', async () => {
    const { events, result } = await run({
      message: 'Approve the deploy?',
      remote: true,
      displayName: 'Deploy gate',
      // LLM-only knobs are ignored rather than validated or persisted.
      enableWeb: true,
      temperature: 0.2,
      enabledTools: ['not-a-project-tool'],
    });

    expect(result.isError).toBeFalsy();
    const id = minionChatIdOf(result);
    expect(JSON.parse(result.content)).toEqual({
      stopReason: 'end_turn',
      hasCoT: false,
      minionChatId: id,
      text: '',
      result: 'Ship it',
      remote: true,
    });

    const [create] = backend.callsTo('/api/sessions');
    expect(create.body).toEqual({ displayName: 'Test Project · Deploy gate' });
    const binary = atob(create.auth.replace(/^Basic /, ''));
    expect(binary).toBe('gremlinofa:pw');
    const [message] = backend.callsTo('/message');
    expect(message.path).toBe('/api/sessions/sess_1/message');
    expect(message.body.content).toBe('Approve the deploy?');
    expect(message.body.files).toBeUndefined();
    expect(message.body.timeoutMs).toBeGreaterThan(590_000);
    expect(message.body.timeoutMs).toBeLessThanOrEqual(600_000);

    // One init with the waiting block; nothing re-yielded while polling.
    expect(events).toHaveLength(1);
    const delta = (events[0] as Extract<ToolStreamEvent, { type: 'groups_delta' }>).delta;
    if (delta.kind !== 'init') throw new Error('expected init');
    const waiting = delta.streamingGroups[0].blocks[0] as ToolResultRenderBlock;
    expect(waiting.icon).toBe('⏳');
    expect(waiting.content).toContain('http://tg.test:3004/web/sessions/sess_1');
    expect(waiting.content).toMatch(/Deadline: \d{4}-\d{2}-\d{2}T/);

    const [info, answer] = result.renderingGroups as RenderingBlockGroup[];
    expect((info.blocks[0] as ToolInfoRenderBlock).chatId).toBe(id);
    expect(answer.category).toBe('text');
    expect(answer.blocks).toEqual([{ type: 'text', text: 'Ship it' }]);

    const chat = await storage.getMinionChat(id);
    expect(chat).toMatchObject({ remote: true, remoteSessionId: 'sess_1' });
    expect(chat?.temperature).toBeUndefined();
    expect(chat?.enabledTools).toBeUndefined();
    expect(chat?.apiDefinitionId).toBeUndefined();
    const stored = await storage.getMinionMessages(id);
    expect(stored.map(m => [m.role, m.content.content])).toEqual([
      ['user', 'Approve the deploy?'],
      ['assistant', 'Ship it'],
    ]);
    expect(chat?.savepoint).toBe(stored[1].id);
  });

  it.each(['return-only', 'enforced', 'auto-enforced', 'no-return'])(
    "uses the answer as the return value in '%s' mode, with a remote marker",
    async returnMode => {
      const { result } = await run(
        { message: 'Approve?', remote: true },
        { ...REMOTE_OPTIONS, returnMode }
      );
      const parsed = parseSimplifiedOutput(result.content);
      expect(parsed).toMatchObject({ hasCoT: false, remote: true, body: 'Ship it' });
      expect(result.content).toBe(
        `<minionChatId>${parsed?.minionChatId}</minionChatId>\n<remote />\nShip it`
      );
      const rendered = minionTool.renderOutput!(result.content, false);
      expect(rendered).toContain('[Answered by a human]');
      expect(rendered).toContain('Ship it');
    }
  );

  it("renders 'both' mode output with the human marker and the answer", async () => {
    const { result } = await run({ message: 'Approve?', remote: true });
    const rendered = minionTool.renderOutput!(result.content, false);
    expect(rendered).toBe(
      `[Answered by a human]\n\nShip it\n\n[minionChatId: ${minionChatIdOf(result)}]`
    );
  });

  it('keeps a remote chat remote on a continuation that omits remote', async () => {
    const first = await run({ message: 'Approve?', remote: true });
    const id = minionChatIdOf(first.result);
    backend.answer = 'Yes, after 6pm';

    const second = await run({ minionChatId: id, message: 'And the DB migration?' });
    expect(second.result.isError).toBeFalsy();
    expect(JSON.parse(second.result.content).result).toBe('Yes, after 6pm');
    // Same session, no second one opened.
    expect(backend.callsTo('/api/sessions')).toHaveLength(1);
    expect(backend.callsTo('/message').map(c => c.path)).toEqual([
      '/api/sessions/sess_1/message',
      '/api/sessions/sess_1/message',
    ]);
    expect(await storage.getMinionMessages(id)).toHaveLength(4);
  });

  it('treats the string "true" like true, and the call block agrees', async () => {
    const { result } = await run({ message: 'Approve?', remote: 'true' });
    expect(JSON.parse(result.content).remote).toBe(true);

    expect(isRemoteCall({ remote: 'true' })).toBe(true);
    expect(readRemoteFlag({ remote: 'false' })).toBe(false);
    expect(readRemoteFlag({ remote: 'yes' })).toBeUndefined();
    expect(minionTool.renderInput!({ message: 'x', remote: 'true' })).toContain('Remote: human');
    expect(minionTool.renderInput!({ message: 'x', remote: 'false' })).toContain('Remote: local');
    // Not something the executor acts on, so the call block doesn't claim it either.
    expect(minionTool.renderInput!({ message: 'x', remote: 'yes' })).not.toContain('Remote:');
  });

  it('rejects remote=false on a remote chat', async () => {
    const chat = await seedChat({ remote: true, remoteSessionId: 'sess_live' });
    const { result } = await run({ minionChatId: chat.id, message: 'hi', remote: false });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('remote=false is not allowed');
    expect(backend.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['holding an LLM conversation', [llmTurn]],
    // Empty, but with a stored verifyHook a human answer would silently skip.
    ['with no messages yet', []],
  ])('rejects remote=true on an LLM chat %s', async (_label, messages) => {
    const chat = await seedChat({ apiDefinitionId: 'api', modelId: 'm', verifyHook: 'check' }, [
      ...messages,
    ]);
    const { result } = await run({ minionChatId: chat.id, message: 'hi', remote: true });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(`minion chat ${chat.id}: it is an LLM minion chat`);
    expect(result.content).not.toContain('is a remote (human) chat');
    expect(backend.fetch).not.toHaveBeenCalled();
    const stored = await storage.getMinionChat(chat.id);
    expect(stored?.remote).toBeUndefined();
    expect(stored?.remoteSessionId).toBeUndefined();
  });

  it('rejects a remote chat once the endpoint has been cleared', async () => {
    const chat = await seedChat({ remote: true, remoteSessionId: 'sess_live' });
    const { result } = await run(
      { minionChatId: chat.id, message: 'hi' },
      { remotePassword: 'pw' }
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain(`Minion chat ${chat.id} is a remote (human) chat`);
    expect(result.content).toContain('No Remote Minion Endpoint');
  });

  it('rejects verifyHook with remote before creating a chat', async () => {
    const saveSpy = vi.spyOn(storage, 'saveMinionChat');
    const { result } = await run({ message: 'hi', remote: true, verifyHook: 'check' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('verifyHook cannot be used with a remote');
    expect(saveSpy).not.toHaveBeenCalled();
    expect(backend.fetch).not.toHaveBeenCalled();
  });

  it('rejects remote=true without a configured endpoint or password', async () => {
    const noEndpoint = await run({ message: 'hi', remote: true }, {});
    expect(noEndpoint.result.content).toContain('No Remote Minion Endpoint');
    const noPassword = await run(
      { message: 'hi', remote: true },
      { remoteEndpoint: 'http://tg.test:3004' }
    );
    expect(noPassword.result.content).toContain('No Remote Minion Password');
    expect(backend.fetch).not.toHaveBeenCalled();
  });

  it('sends files as structured data and keeps the inline text locally', async () => {
    const { result } = await run({
      message: 'Review these',
      remote: true,
      injectFiles: ['/a.txt'],
      injectFilesAfter: ['/b.txt'],
    });
    expect(result.isError).toBeFalsy();

    const [message] = backend.callsTo('/message');
    expect(message.body.content).toBe('Review these');
    expect(message.body.files).toEqual([
      {
        path: '/a.txt',
        content: formatFileWithLineNumbers('alpha\nbeta'),
        placement: 'before',
        lineNumbers: true,
      },
      {
        path: '/b.txt',
        content: formatFileWithLineNumbers('omega'),
        placement: 'after',
        lineNumbers: true,
      },
    ]);

    const id = minionChatIdOf(result);
    const [userMessage] = await storage.getMinionMessages(id);
    const inline = userMessage.content.content as string;
    expect(inline.indexOf('=== /a.txt ===')).toBeLessThan(inline.indexOf('=== end of files ==='));
    expect(inline.indexOf('=== end of files ===')).toBeLessThan(inline.indexOf('Review these'));
    expect(inline.indexOf('Review these')).toBeLessThan(inline.indexOf('=== /b.txt ==='));
    const groups = userMessage.content.renderingContent as RenderingBlockGroup[];
    expect(groups.map(g => g.blocks.map(b => b.type))).toEqual([
      ['injected_file'],
      ['text'],
      ['injected_file'],
    ]);

    const info = (result.renderingGroups as RenderingBlockGroup[])[0]
      .blocks[0] as ToolInfoRenderBlock;
    expect(info.injectedFiles?.map(f => f.path)).toEqual(['/a.txt']);
    expect(info.injectedFilesAfter?.map(f => f.path)).toEqual(['/b.txt']);
  });

  it('flags no line numbers when the files carry none', async () => {
    await run({ message: 'Review', remote: true, injectFiles: ['/a.txt'], fileLineNumbers: false });
    const [message] = backend.callsTo('/message');
    expect(message.body.files).toEqual([
      { path: '/a.txt', content: 'alpha\nbeta', placement: 'before' },
    ]);
  });

  /** Start a question, press Stop once its first poll is out; resolves to the call's result. */
  async function abortWhileWaiting(
    input: Record<string, unknown>,
    options: ToolOptions = REMOTE_OPTIONS
  ): Promise<ToolResult> {
    backend.answer = undefined;
    const gen = minionTool.execute(input, options, makeContext()) as AsyncGenerator<
      ToolStreamEvent,
      ToolResult,
      void
    >;
    await gen.next();
    const finished = gen.next();
    await vi.waitFor(() => expect(backend.callsTo('/poll')).toHaveLength(1));
    abortController.abort();
    return (await finished).value as ToolResult;
  }

  function chatIdOfInfo(result: ToolResult): string {
    const [info] = result.renderingGroups as RenderingBlockGroup[];
    return (info.blocks[0] as ToolInfoRenderBlock).chatId!;
  }

  /** Post the question, press Stop while it waits for the human, return the chat id. */
  async function runAndAbortWhileWaiting(input: Record<string, unknown>): Promise<string> {
    const aborted = await abortWhileWaiting(input);
    expect(aborted.content).toBe('Minion was aborted');
    abortController = new AbortController();
    backend.answer = 'Ship it';
    return chatIdOfInfo(aborted);
  }

  it.each([
    ['action: retry', { action: 'retry' }, {}],
    ['an autoRollback continuation', {}, { autoRollback: true }],
  ])(
    'retries a remote question with %s as the message plus its files, not the inline text',
    async (_label, retryInput, retryOptions) => {
      const id = await runAndAbortWhileWaiting({
        message: 'Review these',
        remote: true,
        injectFiles: ['/a.txt'],
        injectFilesAfter: ['/b.txt'],
      });
      const [original] = await storage.getMinionMessages(id);

      const { result } = await run(
        { minionChatId: id, ...retryInput },
        { ...REMOTE_OPTIONS, ...retryOptions }
      );
      expect(result.isError).toBeFalsy();

      const [first, second] = backend.callsTo('/message');
      expect(second.body.content).toBe('Review these');
      expect(second.body.files).toEqual(first.body.files);

      // The re-saved local message matches the original: inline text, file
      // bars and stored entries.
      const [user, answer] = await storage.getMinionMessages(id);
      expect(user.content.content).toBe(original.content.content);
      expect(user.content.renderingContent).toEqual(original.content.renderingContent);
      expect(user.content.injectedFiles?.map(f => f.path)).toEqual(['/a.txt']);
      expect(user.content.injectedFilesAfter?.map(f => f.path)).toEqual(['/b.txt']);
      expect(user.content.injectionMode).toBeUndefined();
      expect(answer.content.content).toBe('Ship it');

      const info = (result.renderingGroups as RenderingBlockGroup[])[0]
        .blocks[0] as ToolInfoRenderBlock;
      expect(info.input).toBe('Review these');
      expect(info.injectedFiles?.map(f => f.path)).toEqual(['/a.txt']);
    }
  );

  it('keeps the original line-number framing on a retry', async () => {
    // An existing session: nothing saves the chat before Stop, so the call's
    // fileLineNumbers override is not persisted for the retry to read.
    backend.sessions.add('sess_live');
    const chat = await seedChat({
      remote: true,
      remoteSessionId: 'sess_live',
      savepoint: SAVEPOINT_START,
    });
    const id = await runAndAbortWhileWaiting({
      minionChatId: chat.id,
      message: 'Review',
      injectFiles: ['/a.txt'],
      fileLineNumbers: false,
    });
    const [original] = await storage.getMinionMessages(id);
    expect(original.content.content).toContain("Here's the content of /a.txt:\nalpha");

    const { result } = await run({ minionChatId: id, action: 'retry' });
    expect(result.isError).toBeFalsy();
    const [user] = await storage.getMinionMessages(id);
    expect(user.content.content).toBe(original.content.content);
    expect(user.content.renderingContent).toEqual(original.content.renderingContent);
  });

  it('retries an inject-only remote question with empty text and the same files', async () => {
    const id = await runAndAbortWhileWaiting({ remote: true, injectFiles: ['/a.txt'] });
    const { result } = await run({ minionChatId: id, action: 'retry' });
    expect(result.isError).toBeFalsy();
    const [first, second] = backend.callsTo('/message');
    expect(second.body).toMatchObject({ content: '', files: first.body.files });
  });

  it('adopts a question that landed although its response was lost', async () => {
    backend.dropNextMessageResponse = true;
    const { result } = await run({ message: 'Approve?', remote: true });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content).result).toBe('Ship it');
    // One question for the human, read back instead of posted twice.
    expect(backend.callsTo('/message')).toHaveLength(1);
    expect(backend.calls.some(c => c.method === 'GET' && c.path === '/api/sessions/sess_1')).toBe(
      true
    );
    expect(backend.callsTo('/poll')[0].path).toBe('/api/requests/req_2/poll');
  });

  describe('async notes', () => {
    it('posts the note and returns at once, without waiting or a deadline', async () => {
      const { events, result } = await run({
        message: 'Deploy started',
        remote: true,
        async: true,
        injectFiles: ['/a.txt'],
      });
      expect(result.isError).toBeFalsy();
      const id = minionChatIdOf(result);
      expect(JSON.parse(result.content)).toEqual({
        stopReason: 'end_turn',
        hasCoT: false,
        minionChatId: id,
        text: '',
        result: 'Message sent.',
      });
      expect(minionTool.renderOutput!(result.content, false)).not.toContain('Answered by a human');

      const [message] = backend.callsTo('/message');
      expect(message.body).toEqual({
        content: 'Deploy started',
        files: [expect.objectContaining({ path: '/a.txt', lineNumbers: true })],
        awaitReply: false,
      });
      expect(backend.callsTo('/poll')).toHaveLength(0);
      expect(backend.callsTo('/cancel')).toHaveLength(0);
      expect(events).toHaveLength(0);
      expect(result.renderingGroups).toHaveLength(1);

      // A finished exchange: the savepoint moves past the note.
      const stored = await storage.getMinionMessages(id);
      expect(stored.map(m => m.role)).toEqual(['user']);
      expect(stored[0].content.injectedFiles?.map(f => f.path)).toEqual(['/a.txt']);
      expect(await storage.getMinionChat(id)).toMatchObject({
        remote: true,
        remoteSessionId: 'sess_1',
        savepoint: stored[0].id,
      });
    });

    it("says only 'Message sent.' in the simplified modes", async () => {
      const { result } = await run(
        { message: 'FYI', remote: true, async: 'true' },
        { ...REMOTE_OPTIONS, returnMode: 'return-only' }
      );
      const parsed = parseSimplifiedOutput(result.content);
      expect(parsed).toMatchObject({ remote: false, body: 'Message sent.' });
      expect(result.content).toBe(
        `<minionChatId>${parsed?.minionChatId}</minionChatId>\nMessage sent.`
      );
      expect(minionTool.renderInput!({ message: 'x', async: 'true' })).toContain('Async: yes');
      expect(minionTool.renderInput!({ message: 'x', async: false })).not.toContain('Async:');
    });

    it('survives autoRollback and leaves nothing to retry', async () => {
      const first = await run({ message: 'Started', remote: true, async: true });
      const id = minionChatIdOf(first.result);

      const retry = await run({ minionChatId: id, action: 'retry' });
      expect(retry.result.isError).toBe(true);
      expect(retry.result.content).toContain('No messages after savepoint');

      const question = await run(
        { minionChatId: id, message: 'Done?' },
        { ...REMOTE_OPTIONS, autoRollback: true }
      );
      expect(JSON.parse(question.result.content).result).toBe('Ship it');
      const stored = await storage.getMinionMessages(id);
      expect(stored.map(m => [m.role, m.content.content])).toEqual([
        ['user', 'Started'],
        ['user', 'Done?'],
        ['assistant', 'Ship it'],
      ]);
      expect(backend.callsTo('/api/sessions')).toHaveLength(1);
    });

    it('rejects async without a remote chat, before anything is created', async () => {
      const llmChat = await seedChat({ apiDefinitionId: 'api', modelId: 'm' }, [llmTurn]);
      const saveSpy = vi.spyOn(storage, 'saveMinionChat');

      const fresh = await run({ message: 'hi', async: true });
      expect(fresh.result.isError).toBe(true);
      expect(fresh.result.content).toContain('async=true only works with remote (human) minions');

      const existing = await run({ minionChatId: llmChat.id, message: 'hi', async: 'true' });
      expect(existing.result.isError).toBe(true);
      expect(existing.result.content).toContain(
        `minion chat ${llmChat.id}: it is an LLM minion chat, and async only works`
      );
      expect(saveSpy).not.toHaveBeenCalled();
      expect(backend.fetch).not.toHaveBeenCalled();
    });

    it('withdraws the question a 2.0 backend opens for a note', async () => {
      backend.ignoresAwaitReply = true;
      const { result } = await run({ message: 'FYI', remote: true, async: true });
      expect(result.isError).toBeFalsy();
      expect(backend.callsTo('/message')[0].body.timeoutMs).toBeUndefined();
      expect(backend.callsTo('/cancel').map(c => c.path)).toEqual(['/api/requests/req_2/cancel']);
    });

    it('adopts a note that landed although its response was lost', async () => {
      backend.dropNextMessageResponse = true;
      const { result } = await run({ message: 'FYI', remote: true, async: true });
      expect(result.isError).toBeFalsy();
      expect(backend.callsTo('/message')).toHaveLength(1);
      expect(backend.calls.some(c => c.method === 'GET' && c.path === '/api/sessions/sess_1')).toBe(
        true
      );
    });

    it('opens a new session once when the cached one is gone, and tells the human', async () => {
      const chat = await seedChat({ remote: true, remoteSessionId: 'sess_lost' });
      const { result } = await run({ minionChatId: chat.id, message: 'FYI', async: true });
      expect(result.isError).toBeFalsy();
      const posts = backend.callsTo('/message');
      expect(posts.map(c => c.path)).toEqual([
        '/api/sessions/sess_lost/message',
        '/api/sessions/sess_1/message',
      ]);
      expect(posts[1].body.content).toMatch(/^\[The earlier messages .*\]\n\nFYI$/);
    });
  });

  it('times out, withdraws the question and says how to follow up', async () => {
    vi.useFakeTimers();
    backend.answer = undefined;
    // Below the 10s floor: clamped up, not taken literally.
    const pending = run(
      { message: 'Approve?', remote: true },
      { ...REMOTE_OPTIONS, remoteTimeoutMs: 1 }
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const { result } = await pending;

    expect(backend.callsTo('/message')[0].body.timeoutMs).toBeLessThanOrEqual(10_000);
    expect(backend.callsTo('/cancel')).toHaveLength(1);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('no human answer within 10 seconds');
    expect(result.content).toMatch(/minionChatId "minion_\w+"/);
    expect((result.renderingGroups as RenderingBlockGroup[])[0].blocks[0].type).toBe('tool_info');
  });

  it('takes the answer when the human beat the cancel', async () => {
    vi.useFakeTimers();
    backend.answer = undefined;
    backend.cancelState = { status: 'answered', response: { content: 'Just in time' } };
    const pending = run(
      { message: 'Approve?', remote: true },
      { ...REMOTE_OPTIONS, remoteTimeoutMs: 10_000 }
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const { result } = await pending;
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content).result).toBe('Just in time');
  });

  it('stops promptly on abort and cancels the question', async () => {
    backend.answer = undefined;
    const gen = minionTool.execute(
      { message: 'Approve?', remote: true },
      REMOTE_OPTIONS,
      makeContext()
    ) as AsyncGenerator<ToolStreamEvent, ToolResult, void>;
    const init = await gen.next();
    expect(init.done).toBe(false);

    const finished = gen.next();
    // Let the poll go out before pressing Stop.
    await vi.waitFor(() => expect(backend.callsTo('/poll')).toHaveLength(1));
    abortController.abort();
    const end = await finished;

    expect(end.done).toBe(true);
    expect(end.value).toMatchObject({ content: 'Minion was aborted', isError: true });
    expect((end.value as ToolResult).renderingGroups).toHaveLength(1);
    expect(backend.callsTo('/cancel')).toHaveLength(1);
  });

  it('keeps an answer that beat Stop and tells the LLM where it is', async () => {
    backend.cancelState = { status: 'answered', response: { content: 'Already did it' } };
    const result = await abortWhileWaiting({ message: 'Approve?', remote: true });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/^Minion was aborted, but the human had already answered\./);
    const id = chatIdOfInfo(result);
    expect(result.content).toContain(`minionChatId "${id}"`);
    expect(result.content).toContain('Already did it');

    const [user, answer] = await storage.getMinionMessages(id);
    expect(user.role).toBe('user');
    expect(answer).toMatchObject({
      role: 'assistant',
      content: { content: 'Already did it' },
    });
    expect((await storage.getMinionChat(id))?.savepoint).toBe(answer.id);
  });

  it('returns from Stop within a second when the cancel hangs, and writes nothing later', async () => {
    let releaseCancel!: () => void;
    backend.cancelGate = new Promise(resolve => (releaseCancel = resolve));
    backend.cancelState = { status: 'answered', response: { content: 'Too late' } };
    const chat = await seedChat({
      remote: true,
      remoteSessionId: 'sess_live',
      savepoint: SAVEPOINT_START,
    });
    backend.sessions.add('sess_live');

    const startedAt = Date.now();
    const result = await abortWhileWaiting({ minionChatId: chat.id, message: 'Approve?' });
    expect(result.content).toBe('Minion was aborted');
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    const before = await storage.getMinionMessages(chat.id);
    const savepoint = (await storage.getMinionChat(chat.id))?.savepoint;

    // The cancel was sent and is still out; let it land now.
    expect(backend.callsTo('/cancel')).toHaveLength(1);
    releaseCancel();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(await storage.getMinionMessages(chat.id)).toEqual(before);
    expect((await storage.getMinionChat(chat.id))?.savepoint).toBe(savepoint);
  });

  it('keeps cancelling after a Stop during a backend outage, without touching storage', async () => {
    vi.useFakeTimers();
    backend.cancelFailures = 2;
    backend.cancelState = { status: 'answered', response: { content: 'Too late' } };
    const result = await abortWhileWaiting({ message: 'Approve?', remote: true });
    expect(result.content).toBe('Minion was aborted');
    expect(backend.callsTo('/cancel')).toHaveLength(1);

    const saveMessage = vi.spyOn(storage, 'saveMinionMessage');
    const saveChat = vi.spyOn(storage, 'saveMinionChat');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(backend.callsTo('/cancel')).toHaveLength(2);
    // The backend is back: this one gets through, with an answer that came too late.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(backend.callsTo('/cancel')).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(backend.callsTo('/cancel')).toHaveLength(3);
    expect(saveMessage).not.toHaveBeenCalled();
    expect(saveChat).not.toHaveBeenCalled();
  });

  it('stops cancelling at the deadline when the backend stays down after a Stop', async () => {
    vi.useFakeTimers();
    backend.cancelFailures = Infinity;
    const result = await abortWhileWaiting(
      { message: 'Approve?', remote: true },
      { ...REMOTE_OPTIONS, remoteTimeoutMs: 10_000 }
    );
    expect(result.content).toBe('Minion was aborted');
    // Attempts at Stop, +1s, +3s and +8s; the next would land past the 10s deadline.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(backend.callsTo('/cancel')).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(backend.callsTo('/cancel')).toHaveLength(4);
  });

  it('says the question is gone when its poll gets a 404, and a follow-up opens a new session', async () => {
    backend.pollGone = true;
    const { result } = await run({ message: 'Approve?', remote: true });
    const id = chatIdOfInfo(result);
    expect(result).toMatchObject({
      isError: true,
      content: `Remote minion: the question is gone from the backend — the human deleted this conversation, or the backend lost its data. A follow-up with minionChatId "${id}" starts a new session.`,
    });
    expect(result.renderingGroups).toHaveLength(1);
    expect(backend.callsTo('/cancel')).toHaveLength(0);

    // The human deleted the session, which took its request with it.
    backend.sessions.delete('sess_1');
    backend.pollGone = false;
    const followUp = await run({ minionChatId: id, message: 'Still there?' });
    expect(followUp.result.isError).toBeFalsy();
    expect(backend.callsTo('/api/sessions')).toHaveLength(2);
    expect((await storage.getMinionChat(id))?.remoteSessionId).not.toBe('sess_1');
  });

  it('opens a new session when the read-back after a lost response finds it gone', async () => {
    vi.useFakeTimers();
    backend.sessions.add('sess_live');
    backend.dropNextMessageResponse = true;
    backend.onDrop = sessionId => backend.sessions.delete(sessionId);
    const chat = await seedChat({
      remote: true,
      remoteSessionId: 'sess_live',
      savepoint: SAVEPOINT_START,
    });

    const pending = run({ minionChatId: chat.id, message: 'Still there?' });
    await vi.advanceTimersByTimeAsync(1_000);
    const { result } = await pending;

    expect(result.isError).toBeFalsy();
    expect(
      backend.calls.filter(c => c.method === 'GET' && c.path === '/api/sessions/sess_live')
    ).toHaveLength(1);
    // The dropped post used up req_1, so the new session is sess_2.
    const posts = backend.callsTo('/message');
    expect(posts.map(c => c.path)).toEqual([
      '/api/sessions/sess_live/message',
      '/api/sessions/sess_2/message',
    ]);
    expect(posts[1].body.content).toMatch(/^\[The earlier messages .*\]\n\nStill there\?$/);
    expect((await storage.getMinionChat(chat.id))?.remoteSessionId).toBe('sess_2');
  });

  it('opens a new session once when the cached one is gone, and tells the human', async () => {
    // A chat from before the `remote` flag: the session id alone marks it remote.
    const chat = await seedChat({ remoteSessionId: 'sess_gone', savepoint: 'msg_x' });
    const { result } = await run({ minionChatId: chat.id, message: 'Still there?' });
    expect(result.isError).toBeFalsy();

    const posts = backend.callsTo('/message');
    expect(posts.map(c => c.path)).toEqual([
      '/api/sessions/sess_gone/message',
      '/api/sessions/sess_1/message',
    ]);
    expect(posts[1].body.content).toMatch(/^\[The earlier messages .*\]\n\nStill there\?$/);
    expect(await storage.getMinionChat(chat.id)).toMatchObject({
      remote: true,
      remoteSessionId: 'sess_1',
    });
  });

  it('reports a setup failure with its hint and the chat id to retry with', async () => {
    backend.createSessionStatus = 401;
    const { result } = await run({ message: 'Approve?', remote: true });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('HTTP 401');
    expect(result.content).toContain('Remote Minion Password');
    expect(result.content).toMatch(/minionChatId "minion_\w+"/);
  });

  it('describes the remote contract only when an endpoint is set', () => {
    const describeTool = minionTool.description as (o: ToolOptions) => string;
    expect(describeTool({})).not.toContain('remote=true');
    const desc = describeTool({ ...REMOTE_OPTIONS, remoteTimeoutMs: 300_000 });
    expect(desc).toContain('An LLM minion runs independently');
    expect(desc).toContain('self-contained');
    expect(desc).toContain('up to 5 minutes');
    expect(desc).toContain('remote=false on it is an error');
    expect(desc).toContain('same minionChatId');

    const schema = minionTool.inputSchema as (o: ToolOptions) => {
      properties: Record<string, { description?: string }>;
    };
    expect(desc).toContain('async=true');
    expect(schema({}).properties).not.toHaveProperty('remote');
    expect(schema({}).properties).not.toHaveProperty('async');
    expect(schema(REMOTE_OPTIONS).properties.remote.description).toContain('stays remote');
    expect(schema(REMOTE_OPTIONS).properties.async.description).toContain('Message sent.');
  });

  it('clamps remoteTimeoutMs into the supported range', () => {
    expect(resolveRemoteTimeoutMs({})).toBe(600_000);
    expect(resolveRemoteTimeoutMs({ remoteTimeoutMs: 1 })).toBe(10_000);
    expect(resolveRemoteTimeoutMs({ remoteTimeoutMs: 1e12 })).toBe(604_800_000);
  });

  it('throttles remote calls in their own group', async () => {
    const group = await minionTool.getParallelThrottleGroup!(
      { message: 'x', remote: true },
      REMOTE_OPTIONS,
      makeContext()
    );
    expect(group).toBe('minion:__remote__');
  });
});

describe('formatMinionResult', () => {
  const base = {
    minionChatId: 'minion_abc',
    stopReason: 'end_turn',
    hasCoT: false,
    text: 'prose',
    returnValue: undefined,
  };

  it("emits JSON in 'both' mode, with result only when returned", () => {
    expect(JSON.parse(formatMinionResult({ ...base, returnMode: 'both' }))).toEqual({
      stopReason: 'end_turn',
      hasCoT: false,
      minionChatId: 'minion_abc',
      text: 'prose',
    });
    expect(
      JSON.parse(formatMinionResult({ ...base, returnMode: 'both', returnValue: 'R' })).result
    ).toBe('R');
  });

  it('warns in enforced modes when nothing was returned, else falls back to the prose', () => {
    expect(formatMinionResult({ ...base, returnMode: 'enforced' })).toBe(
      '<minionChatId>minion_abc</minionChatId>\nWarning: Return tool was not called'
    );
    expect(formatMinionResult({ ...base, returnMode: 'return-only', hasCoT: true })).toBe(
      '<minionChatId>minion_abc</minionChatId>\n<hasCoT />\nprose'
    );
  });
});
