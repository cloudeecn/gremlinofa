import { describe, it, expect } from 'vitest';
import { prepareMessageForWire } from '../messageWire';
import type { Message } from '../../protocol/types';

function makeMessage(overrides: Partial<Message<unknown>> = {}): Message<unknown> {
  return {
    id: 'msg-1',
    role: 'assistant',
    content: { type: 'text', content: 'Hello world' },
    timestamp: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('prepareMessageForWire', () => {
  describe('renderingContent backfill (legacy messages)', () => {
    it('backfills a text group for an assistant message without renderingContent', () => {
      const legacy = makeMessage();
      const wire = prepareMessageForWire(legacy);

      expect(wire.content.renderingContent).toEqual([
        { category: 'text', blocks: [{ type: 'text', text: 'Hello world' }] },
      ]);
      // Shallow copy — the original (persisted) message is untouched
      expect(wire).not.toBe(legacy);
      expect(legacy.content.renderingContent).toBeUndefined();
    });

    it('backfills system messages (routed to AssistantMessageBubble too)', () => {
      const wire = prepareMessageForWire(makeMessage({ role: 'system' }));
      expect(wire.content.renderingContent).toEqual([
        { category: 'text', blocks: [{ type: 'text', text: 'Hello world' }] },
      ]);
    });

    it('does not backfill user messages (UserMessageBubble has its own stripMetadata fallback)', () => {
      const userMessage = makeMessage({ role: 'user' });
      expect(prepareMessageForWire(userMessage)).toBe(userMessage);
    });

    it('leaves existing renderingContent unchanged (idempotent)', () => {
      const groups = [
        { category: 'backstage' as const, blocks: [{ type: 'thinking' as const, thinking: 'hm' }] },
      ];
      const modern = makeMessage({
        content: { type: 'text', content: 'Hello world', renderingContent: groups },
      });
      const wire = prepareMessageForWire(modern);
      expect(wire).toBe(modern);
      expect(wire.content.renderingContent).toBe(groups);
    });

    it('skips backfill when content text is empty', () => {
      const toolOnly = makeMessage({ content: { type: 'text', content: '' } });
      expect(prepareMessageForWire(toolOnly)).toBe(toolOnly);
    });
  });

  describe('toolUseBlocks extraction', () => {
    const anthropicToolUse = [
      { type: 'tool_use', id: 'tu-1', name: 'minion', input: { task: 'dig' } },
    ];

    it('extracts toolUseBlocks from provider fullContent', () => {
      const wire = prepareMessageForWire(
        makeMessage({
          content: {
            type: 'text',
            content: '',
            modelFamily: 'anthropic',
            fullContent: anthropicToolUse,
          },
        })
      );
      expect(wire.content.toolUseBlocks).toEqual([
        { type: 'tool_use', id: 'tu-1', name: 'minion', input: { task: 'dig' } },
      ]);
    });

    it('returns the same reference when toolUseBlocks is already populated', () => {
      const prepared = makeMessage({
        content: {
          type: 'text',
          content: '',
          modelFamily: 'anthropic',
          fullContent: anthropicToolUse,
          toolUseBlocks: [{ type: 'tool_use', id: 'tu-1', name: 'minion', input: {} }],
          renderingContent: [],
        },
      });
      expect(prepareMessageForWire(prepared)).toBe(prepared);
    });

    it('returns the same reference when fullContent has no tool blocks and no backfill applies', () => {
      const plain = makeMessage({
        content: {
          type: 'text',
          content: '',
          modelFamily: 'anthropic',
          fullContent: [{ type: 'text', text: 'hi' }],
        },
      });
      expect(prepareMessageForWire(plain)).toBe(plain);
    });

    it('applies toolUseBlocks and renderingContent backfill in one copy', () => {
      const legacy = makeMessage({
        content: {
          type: 'text',
          content: 'Calling a tool',
          modelFamily: 'anthropic',
          fullContent: anthropicToolUse,
        },
      });
      const wire = prepareMessageForWire(legacy);

      expect(wire.content.toolUseBlocks).toHaveLength(1);
      expect(wire.content.renderingContent).toEqual([
        { category: 'text', blocks: [{ type: 'text', text: 'Calling a tool' }] },
      ]);
      expect(legacy.content.toolUseBlocks).toBeUndefined();
      expect(legacy.content.renderingContent).toBeUndefined();
    });

    it('survives a fullContent shape that fails to parse', () => {
      const malformed = makeMessage({
        content: {
          type: 'text',
          content: 'text survives',
          modelFamily: 'anthropic',
          // Not an array — extractAnthropicToolBlocks returns [] rather than
          // throwing, but any future throw must not break the wire path.
          fullContent: { totally: 'wrong' },
        },
      });
      const wire = prepareMessageForWire(malformed);
      expect(wire.content.toolUseBlocks).toBeUndefined();
      expect(wire.content.renderingContent).toEqual([
        { category: 'text', blocks: [{ type: 'text', text: 'text survives' }] },
      ]);
    });
  });

  describe('legacy persisted shape (JSON round-trip)', () => {
    it('handles a message exactly as unifiedStorage.getMessages produces it', () => {
      // Storage does JSON.parse of the persisted blob and revives timestamp
      // only — this mirrors an assistant row written before renderingContent
      // existed.
      const persisted = JSON.parse(
        JSON.stringify({
          id: 'legacy-1',
          role: 'assistant',
          content: {
            type: 'text',
            content: 'Old answer from 2025',
            modelFamily: 'anthropic',
            fullContent: [{ type: 'text', text: 'Old answer from 2025' }],
          },
          timestamp: '2025-03-01T12:00:00Z',
          metadata: { inputTokens: 10, outputTokens: 20 },
        })
      );
      const wire = prepareMessageForWire({
        ...persisted,
        timestamp: new Date(persisted.timestamp),
      });

      expect(wire.content.renderingContent).toEqual([
        { category: 'text', blocks: [{ type: 'text', text: 'Old answer from 2025' }] },
      ]);
    });
  });
});
