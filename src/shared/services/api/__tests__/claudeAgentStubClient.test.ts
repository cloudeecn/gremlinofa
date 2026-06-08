import { describe, it, expect } from 'vitest';
import { ClaudeAgentStubClient } from '../claudeAgentStubClient';
import type { APIDefinition, Message } from '../../../protocol/types';

const apiDef: APIDefinition = {
  id: 'def',
  apiType: 'claude-agent',
  name: 'stub',
  baseUrl: '',
  apiKey: '',
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('ClaudeAgentStubClient (worker mode)', () => {
  it('discoverModels throws "requires server mode"', async () => {
    const client = new ClaudeAgentStubClient();
    await expect(client.discoverModels(apiDef)).rejects.toThrow(/requires server mode/);
  });

  it('sendMessageStream throws "requires server mode" on first iteration', async () => {
    const client = new ClaudeAgentStubClient();
    const ac = new AbortController();
    const gen = client.sendMessageStream(
      [
        {
          id: 'm',
          role: 'user',
          content: { type: 'text', content: 'x' },
          timestamp: new Date(),
        } as Message<unknown>,
      ],
      'claude-haiku-4-5',
      apiDef,
      { signal: ac.signal }
    );
    await expect(gen.next()).rejects.toThrow(/requires server mode/);
  });

  it('extractToolUseBlocks returns empty (no tools in MVP)', () => {
    const client = new ClaudeAgentStubClient();
    expect(client.extractToolUseBlocks({ anything: true })).toEqual([]);
  });
});
