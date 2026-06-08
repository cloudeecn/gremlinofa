import type { APIDefinition, Message, Model, ToolUseBlock } from '../../protocol/types';
import type { APIClient, StreamChunk, StreamResult } from './baseClient';

const ERR = 'claude-agent provider requires server mode (worker mode unsupported)';

/**
 * Worker-mode stub for the claude-agent provider. The real client at
 * `claudeAgentClient.ts` spawns the host `claude` CLI subprocess and is
 * Node-only. In a browser worker we surface a clear error instead of
 * exploding deep in `import('@anthropic-ai/claude-agent-sdk')`.
 */
export class ClaudeAgentStubClient implements APIClient {
  async discoverModels(_apiDefinition: APIDefinition): Promise<Model[]> {
    throw new Error(ERR);
  }

  shouldPrependPrefill(_apiDefinition: APIDefinition): boolean {
    return false;
  }

  // eslint-disable-next-line require-yield
  async *sendMessageStream(
    _messages: Message<unknown>[],
    _modelId: string,
    _apiDefinition: APIDefinition,
    _options: unknown
  ): AsyncGenerator<StreamChunk, StreamResult<unknown>, unknown> {
    throw new Error(ERR);
  }

  extractToolUseBlocks(_fullContent: unknown): ToolUseBlock[] {
    return [];
  }
}
