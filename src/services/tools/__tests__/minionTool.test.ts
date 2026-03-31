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
  truncateError,
  parseSimplifiedOutput,
  stripNsPrefix,
} from '../minionTool';
import type { ToolResult, ToolExecuteReturn, ModelReference } from '../../../types';
import { LocalVfsAdapter } from '../../vfs/localVfsAdapter';

const mockAdapter = new LocalVfsAdapter('proj_123');
const mockAdapterFactory = (ns?: string) => new LocalVfsAdapter('proj_123', ns);

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
      expect(schema.properties).toHaveProperty('displayName');
      expect(schema.properties).toHaveProperty('injectFiles');
    });

    it('schema injectFiles property is an array of strings', () => {
      const schema =
        typeof minionTool.inputSchema === 'function'
          ? minionTool.inputSchema({})
          : minionTool.inputSchema;
      const prop = schema.properties!.injectFiles as { type: string; items: { type: string } };
      expect(prop.type).toBe('array');
      expect(prop.items.type).toBe('string');
    });

    it('description mentions injectFiles', () => {
      const descFn = minionTool.description;
      if (typeof descFn !== 'function') throw new Error('Expected description to be a function');
      const desc = descFn({});
      expect(desc).toContain('injectFiles');
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

    it('has option definitions for model, models, system prompt, allowWebSearch, autoRollback, returnMode, disableReasoning, deferReturn, deferred/return messages, autoAckMessage, namespacedMinion, and fileInjectionMode', () => {
      expect(minionTool.optionDefinitions).toBeDefined();
      expect(minionTool.optionDefinitions).toHaveLength(16);

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

      const namespacedOpt = minionTool.optionDefinitions?.find(o => o.id === 'namespacedMinion');
      expect(namespacedOpt).toBeDefined();
      expect(namespacedOpt?.type).toBe('select');
      if (namespacedOpt?.type === 'select') {
        expect(namespacedOpt.default).toBe('off');
        expect(namespacedOpt.choices).toHaveLength(3);
        expect(namespacedOpt.choices.map(c => c.value)).toEqual(['off', 'persona', 'all']);
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

    it('returns checksum mismatch error for garbled minionChatId', async () => {
      // 34-char random part with wrong checksum → LLM copy error
      const garbledId = 'minion_' + 'a'.repeat(34);
      const result = await collectToolResult(
        minionTool.execute({ message: 'test', minionChatId: garbledId }, undefined, {
          projectId: 'proj_123',
          vfsAdapter: mockAdapter,
          createVfsAdapter: mockAdapterFactory,
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
          { projectId: 'proj_123', vfsAdapter: mockAdapter, createVfsAdapter: mockAdapterFactory }
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
          { projectId: 'proj_123', vfsAdapter: mockAdapter, createVfsAdapter: mockAdapterFactory }
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
          { projectId: 'proj_123', vfsAdapter: mockAdapter, createVfsAdapter: mockAdapterFactory }
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
          { projectId: 'proj_123', vfsAdapter: mockAdapter, createVfsAdapter: mockAdapterFactory }
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
});
