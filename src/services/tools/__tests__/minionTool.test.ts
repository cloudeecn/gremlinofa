/**
 * Tests for minionTool
 *
 * Tests the minion tool's helper functions and configuration.
 * Full integration tests would require mocking the entire agentic loop.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { minionTool, CHECKPOINT_START, formatModelString, parseModelString } from '../minionTool';
import type { ToolResult, ToolExecuteReturn, ModelReference } from '../../../types';

// Minimal storage mock for execute tests that now reach storage (Phase 2 errors)
vi.mock('../../storage', () => ({
  storage: {
    saveMinionChat: vi.fn(() => Promise.resolve()),
  },
}));

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

    it('schema includes persona when namespacedMinion is true', () => {
      const schema =
        typeof minionTool.inputSchema === 'function'
          ? minionTool.inputSchema({ namespacedMinion: true })
          : minionTool.inputSchema;
      expect(schema.properties).toHaveProperty('persona');
    });

    it('schema excludes persona when namespacedMinion is false', () => {
      const schema =
        typeof minionTool.inputSchema === 'function'
          ? minionTool.inputSchema({ namespacedMinion: false })
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

    it('description mentions persona when namespacedMinion is true', () => {
      const descFn = minionTool.description;
      if (typeof descFn !== 'function') throw new Error('Expected description to be a function');
      const desc = descFn({ namespacedMinion: true });
      expect(desc).toContain('persona');
    });

    it('description omits persona when namespacedMinion is false', () => {
      const descFn = minionTool.description;
      if (typeof descFn !== 'function') throw new Error('Expected description to be a function');
      const desc = descFn({});
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

    it('has option definitions for model, models, system prompt, allowWebSearch, returnOnly, noReturnTool, disableReasoning, and namespacedMinion', () => {
      expect(minionTool.optionDefinitions).toBeDefined();
      expect(minionTool.optionDefinitions).toHaveLength(8);

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

      const returnOnlyOpt = minionTool.optionDefinitions?.find(o => o.id === 'returnOnly');
      expect(returnOnlyOpt).toBeDefined();
      expect(returnOnlyOpt?.type).toBe('boolean');
      if (returnOnlyOpt?.type === 'boolean') {
        expect(returnOnlyOpt.default).toBe(false);
      }

      const noReturnOpt = minionTool.optionDefinitions?.find(o => o.id === 'noReturnTool');
      expect(noReturnOpt).toBeDefined();
      expect(noReturnOpt?.type).toBe('boolean');
      if (noReturnOpt?.type === 'boolean') {
        expect(noReturnOpt.default).toBe(false);
      }

      const disableReasoningOpt = minionTool.optionDefinitions?.find(
        o => o.id === 'disableReasoning'
      );
      expect(disableReasoningOpt).toBeDefined();
      expect(disableReasoningOpt?.type).toBe('boolean');
      if (disableReasoningOpt?.type === 'boolean') {
        expect(disableReasoningOpt.default).toBe(false);
      }

      const namespacedOpt = minionTool.optionDefinitions?.find(o => o.id === 'namespacedMinion');
      expect(namespacedOpt).toBeDefined();
      expect(namespacedOpt?.type).toBe('boolean');
      if (namespacedOpt?.type === 'boolean') {
        expect(namespacedOpt.default).toBe(false);
      }

      const modelsOpt = minionTool.optionDefinitions?.find(o => o.id === 'models');
      expect(modelsOpt).toBeDefined();
      expect(modelsOpt?.type).toBe('modellist');
    });

    it('schema includes model enum when namespacedMinion + models configured', () => {
      const models: ModelReference[] = [
        { apiDefinitionId: 'api_1', modelId: 'claude-3' },
        { apiDefinitionId: 'api_2', modelId: 'us.anthropic.claude-3-5-sonnet:0' },
      ];
      const schema =
        typeof minionTool.inputSchema === 'function'
          ? minionTool.inputSchema({ namespacedMinion: true, models })
          : minionTool.inputSchema;
      expect(schema.properties).toHaveProperty('model');
      const modelProp = schema.properties!.model as { enum: string[] };
      expect(modelProp.enum).toEqual(['api_1:claude-3', 'api_2:us.anthropic.claude-3-5-sonnet:0']);
    });

    it('schema excludes model param when namespacedMinion is false', () => {
      const models: ModelReference[] = [{ apiDefinitionId: 'a', modelId: 'b' }];
      const schema =
        typeof minionTool.inputSchema === 'function'
          ? minionTool.inputSchema({ namespacedMinion: false, models })
          : minionTool.inputSchema;
      expect(schema.properties).not.toHaveProperty('model');
    });

    it('schema excludes model param when models list is empty', () => {
      const schema =
        typeof minionTool.inputSchema === 'function'
          ? minionTool.inputSchema({ namespacedMinion: true, models: [] })
          : minionTool.inputSchema;
      expect(schema.properties).not.toHaveProperty('model');
    });

    it('description mentions model selection when namespacedMinion + models configured', () => {
      const descFn = minionTool.description;
      if (typeof descFn !== 'function') throw new Error('Expected description to be a function');
      const models: ModelReference[] = [{ apiDefinitionId: 'a', modelId: 'b' }];
      const desc = descFn({ namespacedMinion: true, models });
      expect(desc).toContain('model parameter');
    });

    it('description omits model selection when no models configured', () => {
      const descFn = minionTool.description;
      if (typeof descFn !== 'function') throw new Error('Expected description to be a function');
      const desc = descFn({ namespacedMinion: true });
      expect(desc).not.toContain('model parameter');
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
  });

  describe('execute', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('returns Phase 1 error when message action has no message', async () => {
      const result = await collectToolResult(
        minionTool.execute({}, undefined, { projectId: 'proj_123' })
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('"message" is required');
      expect(result.content).toContain('Resend to reattempt.');
    });

    it('returns Phase 1 error when retry action has no minionChatId', async () => {
      const result = await collectToolResult(
        minionTool.execute({ action: 'retry' }, undefined, { projectId: 'proj_123' })
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

    it('returns Phase 2 error when model is not configured (after chat creation)', async () => {
      const result = await collectToolResult(
        minionTool.execute(
          { message: 'test' },
          {}, // No model configured
          { projectId: 'proj_123' }
        )
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('Minion model not configured');
      expect(result.content).toContain('Resend with the message to reattempt.');
    });

    it('returns Phase 2 error when input.model provided but models list not configured', async () => {
      const result = await collectToolResult(
        minionTool.execute(
          { message: 'test', model: 'api_1:claude-3' },
          { model: { apiDefinitionId: 'api_1', modelId: 'claude-3' } },
          { projectId: 'proj_123' }
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
          { projectId: 'proj_123' }
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
          { projectId: 'proj_123' }
        )
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('Invalid model format');
    });

    it('exports CHECKPOINT_START sentinel', () => {
      expect(CHECKPOINT_START).toBe('_start');
    });
  });
});
