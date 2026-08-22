import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UnifiedStorage } from '../../services/storage/unifiedStorage';
import type { EncryptionCore } from '../../services/encryption/encryptionCore';
import type { Message, MinionChat, Project, ToolUseBlock } from '../../protocol/types';
import {
  createMockAdapter,
  createMockEncryptionService,
  createTestProject,
} from '../../services/storage/__tests__/testUtils';
import { cloneMinionChatToChat, deriveChatAgentConfigFromMinion } from '../cloneMinionChat';
import { ProtocolError } from '../GremlinServer';

function minionChat(overrides: Partial<MinionChat> = {}): MinionChat {
  return {
    id: 'minion-chat-1',
    parentChatId: 'test-chat-1',
    projectId: 'test-project-1',
    createdAt: new Date('2024-01-01T00:00:00Z'),
    lastModifiedAt: new Date('2024-01-01T00:00:00Z'),
    apiDefinitionId: 'test-api-def-1',
    modelId: 'test-model',
    ...overrides,
  };
}

function project(overrides: Partial<Project> = {}): Project {
  return createTestProject({
    enabledTools: ['memory', 'filesystem', 'javascript', 'minion'],
    ...overrides,
  });
}

let msgSeq = 0;
function userMsg(text: string, at = '2024-01-01T00:00:00Z'): Message<unknown> {
  return {
    id: `msg-${++msgSeq}`,
    role: 'user',
    content: { type: 'text', content: text },
    timestamp: new Date(at),
  };
}

function assistantMsg(
  text: string,
  opts: {
    at?: string;
    toolCalls?: ToolUseBlock[];
    uuid?: string;
    sessionId?: string;
    contextWindowUsage?: number;
    incomplete?: boolean;
  } = {}
): Message<unknown> {
  return {
    id: `msg-${++msgSeq}`,
    role: 'assistant',
    content: { type: 'text', content: text, toolCalls: opts.toolCalls },
    timestamp: new Date(opts.at ?? '2024-01-01T00:01:00Z'),
    ...(opts.incomplete ? { incomplete: true } : {}),
    metadata: {
      ...(opts.uuid ? { claudeAgentMessageUuid: opts.uuid } : {}),
      ...(opts.sessionId ? { claudeAgentSessionId: opts.sessionId } : {}),
      ...(opts.contextWindowUsage !== undefined
        ? { contextWindowUsage: opts.contextWindowUsage }
        : {}),
    },
  };
}

const returnCall: ToolUseBlock = { type: 'tool_use', id: 'tu_ret', name: 'return', input: {} };

describe('deriveChatAgentConfigFromMinion', () => {
  it("nsMode 'off': no persona, no namespace, pre-persona explicitly disabled", () => {
    const p = project({ toolOptions: { minion: { systemPrompt: 'CONFIGURED' } } });
    const cfg = deriveChatAgentConfigFromMinion(minionChat({ persona: 'researcher' }), p);

    expect(cfg.systemPromptMode).toBe('replace');
    expect(cfg.persona).toBeUndefined();
    expect(cfg.namespace).toBeUndefined();
    // '' not undefined: undefined would newly pull in /minions/_global.md for a
    // minion that never read it.
    expect(cfg.prePersonaSystemPromptFile).toBe('');
    expect(cfg.systemPrompt).toBe('CONFIGURED');
  });

  it("nsMode 'persona' with the default persona behaves like 'off'", () => {
    const p = project({
      toolOptions: { minion: { namespacedMinion: 'persona', systemPrompt: 'CONFIGURED' } },
    });
    const cfg = deriveChatAgentConfigFromMinion(minionChat({ persona: 'default' }), p);

    expect(cfg.persona).toBeUndefined();
    expect(cfg.namespace).toBeUndefined();
    expect(cfg.prePersonaSystemPromptFile).toBe('');
    expect(cfg.systemPrompt).toBe('CONFIGURED');
  });

  it("nsMode 'persona' with a named persona carries the persona and namespace", () => {
    const p = project({
      toolOptions: { minion: { namespacedMinion: 'persona', systemPrompt: 'CONFIGURED' } },
    });
    const cfg = deriveChatAgentConfigFromMinion(
      minionChat({ persona: 'researcher', prePersonaSystemPromptFile: '/custom.md' }),
      p
    );

    expect(cfg.persona).toBe('researcher');
    expect(cfg.namespace).toBe('/minions/researcher');
    expect(cfg.prePersonaSystemPromptFile).toBe('/custom.md');
    // A persona file replaces the tool-level configured prompt, as in the tool.
    expect(cfg.systemPrompt).toBeUndefined();
  });

  it("nsMode 'all' with the default persona namespaces but keeps the configured prompt", () => {
    const p = project({
      toolOptions: { minion: { namespacedMinion: 'all', systemPrompt: 'CONFIGURED' } },
    });
    const cfg = deriveChatAgentConfigFromMinion(minionChat({ persona: 'default' }), p);

    expect(cfg.persona).toBeUndefined();
    expect(cfg.namespace).toBe('/minions/default');
    expect(cfg.prePersonaSystemPromptFile).toBeUndefined();
    expect(cfg.systemPrompt).toBe('CONFIGURED');
  });

  it("joins the configured prompt with the minion's own inline prompt", () => {
    const p = project({ toolOptions: { minion: { systemPrompt: 'CONFIGURED' } } });
    const cfg = deriveChatAgentConfigFromMinion(minionChat({ systemPrompt: 'EXTRA' }), p);
    expect(cfg.systemPrompt).toBe('CONFIGURED\n\nEXTRA');
  });

  it('drops `return` and `minion` from the derived tool set', () => {
    const cfg = deriveChatAgentConfigFromMinion(
      minionChat({ enabledTools: ['memory', 'minion', 'javascript'] }),
      project()
    );
    expect(cfg.enabledTools).toEqual(['memory', 'javascript']);
    expect(cfg.enabledTools).not.toContain('return');
  });

  it('never carries webSearchEnabled — minion web access is per-call, not persisted', () => {
    expect(deriveChatAgentConfigFromMinion(minionChat(), project())).not.toHaveProperty(
      'webSearchEnabled'
    );
  });

  it('copies the reasoning and output knobs verbatim', () => {
    const cfg = deriveChatAgentConfigFromMinion(
      minionChat({
        temperature: 0.2,
        maxOutputTokens: 555,
        enableReasoning: true,
        reasoningBudgetTokens: 1024,
        reasoningEffort: 'high',
        verbosity: 'low',
        fileLineNumbers: true,
        nudgeThinking: '',
        thinkingKeepTurns: 2,
        pruneThinkingBeforeApiCall: true,
        systemPromptFile: ['/a.md', '/b.md'],
      }),
      project()
    );

    expect(cfg).toMatchObject({
      temperature: 0.2,
      maxOutputTokens: 555,
      enableReasoning: true,
      reasoningBudgetTokens: 1024,
      reasoningEffort: 'high',
      verbosity: 'low',
      fileLineNumbers: true,
      nudgeThinking: '',
      thinkingKeepTurns: 2,
      pruneThinkingBeforeApiCall: true,
      systemPromptFile: ['/a.md', '/b.md'],
    });
  });
});

describe('cloneMinionChatToChat', () => {
  let storage: UnifiedStorage;

  beforeEach(async () => {
    vi.clearAllMocks();
    msgSeq = 0;
    storage = new UnifiedStorage(
      createMockAdapter(),
      createMockEncryptionService() as unknown as EncryptionCore
    );
    await storage.saveProject(project());
  });

  const seed = async (chat: MinionChat, messages: Message<unknown>[]) => {
    await storage.saveMinionChat(chat);
    for (const m of messages) await storage.saveMinionMessage(chat.id, m);
  };

  it('throws MINION_CHAT_NOT_FOUND for an unknown source', async () => {
    await expect(cloneMinionChatToChat(storage, 'nope')).rejects.toMatchObject({
      code: 'MINION_CHAT_NOT_FOUND',
    });
  });

  it('throws PROJECT_NOT_FOUND when the target project is gone', async () => {
    await seed(minionChat({ projectId: 'ghost' }), [userMsg('hi')]);
    await expect(cloneMinionChatToChat(storage, 'minion-chat-1')).rejects.toBeInstanceOf(
      ProtocolError
    );
  });

  it('copies messages with fresh ids, original timestamps and order', async () => {
    const messages = [
      userMsg('one', '2024-01-01T00:00:00Z'),
      assistantMsg('two', { at: '2024-01-01T00:05:00Z' }),
      userMsg('three', '2024-01-01T00:10:00Z'),
    ];
    await seed(minionChat(), messages);

    const { chat } = await cloneMinionChatToChat(storage, 'minion-chat-1');
    const copied = await storage.getMessages(chat.id);

    expect(copied.map(m => m.content.content)).toEqual(['one', 'two', 'three']);
    expect(copied.map(m => m.timestamp.toISOString())).toEqual(
      messages.map(m => m.timestamp.toISOString())
    );
    expect(copied.every((m, i) => m.id !== messages[i].id)).toBe(true);
  });

  it('records provenance and derives the name from the display name', async () => {
    await seed(minionChat({ displayName: 'Deep Research' }), [userMsg('hi')]);
    const { chat } = await cloneMinionChatToChat(storage, 'minion-chat-1');

    expect(chat.name).toBe('Deep Research');
    expect(chat.clonedFromMinionChatId).toBe('minion-chat-1');
    expect(chat.clonedFromChatId).toBe('test-chat-1');
    expect(chat.isForked).toBeUndefined();
  });

  it('falls back to "<persona> (minion)" then to the id suffix', async () => {
    await seed(minionChat({ persona: 'researcher' }), [userMsg('hi')]);
    expect((await cloneMinionChatToChat(storage, 'minion-chat-1')).chat.name).toBe(
      'researcher (minion)'
    );

    await seed(minionChat({ id: 'minion-chat-2' }), [userMsg('hi')]);
    expect((await cloneMinionChatToChat(storage, 'minion-chat-2')).chat.name).toBe('Minion chat-2');
  });

  it('trims an explicit name to 50 characters', async () => {
    await seed(minionChat(), [userMsg('hi')]);
    const { chat } = await cloneMinionChatToChat(storage, 'minion-chat-1', {
      name: 'x'.repeat(80),
    });
    expect(chat.name).toHaveLength(50);
  });

  it('carries totals and recomputes the context window from the last assistant', async () => {
    await seed(
      minionChat({
        totalInputTokens: 10,
        totalOutputTokens: 20,
        totalCost: 1.5,
        costUnreliable: true,
      }),
      [
        assistantMsg('a', { at: '2024-01-01T00:01:00Z', contextWindowUsage: 900 }),
        assistantMsg('b', { at: '2024-01-01T00:02:00Z', contextWindowUsage: 1234 }),
        userMsg('c', '2024-01-01T00:03:00Z'),
      ]
    );

    const { chat } = await cloneMinionChatToChat(storage, 'minion-chat-1');
    expect(chat).toMatchObject({
      totalInputTokens: 10,
      totalOutputTokens: 20,
      totalCost: 1.5,
      costUnreliable: true,
      contextWindowUsage: 1234,
      messageCount: 3,
    });
  });

  it('drops the minion-only fields that have no meaning in a chat', async () => {
    await seed(
      minionChat({
        savepoint: 'msg-1',
        verifyHook: 'check',
        remoteSessionId: 'remote-1',
        pendingVerifyFeedback: 'try again',
        allowNesting: true,
        availablePersonas: ['a', 'b'],
      }),
      [userMsg('hi')]
    );

    const { chat } = await cloneMinionChatToChat(storage, 'minion-chat-1');
    for (const key of [
      'savepoint',
      'verifyHook',
      'remoteSessionId',
      'pendingVerifyFeedback',
      'allowNesting',
      'availablePersonas',
    ]) {
      expect(chat).not.toHaveProperty(key);
    }
  });
});

describe('cloneMinionChatToChat — tail closure', () => {
  let storage: UnifiedStorage;

  beforeEach(async () => {
    msgSeq = 0;
    storage = new UnifiedStorage(
      createMockAdapter(),
      createMockEncryptionService() as unknown as EncryptionCore
    );
    await storage.saveProject(project());
  });

  const seed = async (chat: MinionChat, messages: Message<unknown>[]) => {
    await storage.saveMinionChat(chat);
    for (const m of messages) await storage.saveMinionMessage(chat.id, m);
  };

  it('closes a trailing `return` with a matching tool_result', async () => {
    const tail = assistantMsg('done', { at: '2024-01-01T00:05:00Z', toolCalls: [returnCall] });
    await seed(minionChat(), [userMsg('go'), tail]);

    const { chat, notes } = await cloneMinionChatToChat(storage, 'minion-chat-1');
    const copied = await storage.getMessages(chat.id);
    const closure = copied[copied.length - 1];

    expect(closure.role).toBe('user');
    expect(closure.content.content).toBe('');
    expect(closure.content.toolResults).toHaveLength(1);
    expect(closure.content.toolResults?.[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tu_ret',
      name: 'return',
    });
    expect(closure.content.toolResults?.[0].is_error).toBeUndefined();
    // Tail + 1ms, not wall clock — rows are ordered by timestamp.
    expect(closure.timestamp.getTime()).toBe(tail.timestamp.getTime() + 1);
    expect(chat.messageCount).toBe(3);
    expect(notes.join(' ')).toContain('return');
  });

  it('closes `return`’s parallel siblings as errors', async () => {
    const siblings: ToolUseBlock[] = [
      returnCall,
      { type: 'tool_use', id: 'tu_a', name: 'memory', input: {} },
      { type: 'tool_use', id: 'tu_b', name: 'filesystem', input: {} },
    ];
    await seed(minionChat(), [
      userMsg('go'),
      assistantMsg('done', { at: '2024-01-01T00:05:00Z', toolCalls: siblings }),
    ]);

    const copied = await storage.getMessages(
      (await cloneMinionChatToChat(storage, 'minion-chat-1')).chat.id
    );
    const results = copied[copied.length - 1].content.toolResults ?? [];

    expect(results.map(r => r.tool_use_id)).toEqual(['tu_ret', 'tu_a', 'tu_b']);
    expect(results[0].is_error).toBeUndefined();
    expect(results[1].is_error).toBe(true);
    expect(results[2].is_error).toBe(true);
  });

  it('adds nothing when the transcript ends cleanly', async () => {
    await seed(minionChat(), [userMsg('go'), assistantMsg('done')]);
    const { chat, notes } = await cloneMinionChatToChat(storage, 'minion-chat-1');

    expect(await storage.getMessageCount(chat.id)).toBe(2);
    expect(notes).toEqual([]);
  });

  it('refuses to close an incomplete tail, so the clone is born locked', async () => {
    // The incomplete-tail lock owns an aborted tail; appending a user message
    // would silently unlock a chat the abort path deliberately locked.
    await seed(minionChat(), [
      userMsg('go'),
      assistantMsg('partial', { toolCalls: [returnCall], incomplete: true }),
    ]);

    const { chat } = await cloneMinionChatToChat(storage, 'minion-chat-1');
    const copied = await storage.getMessages(chat.id);

    expect(copied).toHaveLength(2);
    expect(copied[1].incomplete).toBe(true);
  });
});

describe('cloneMinionChatToChat — claude-agent session', () => {
  let storage: UnifiedStorage;

  beforeEach(async () => {
    msgSeq = 0;
    storage = new UnifiedStorage(
      createMockAdapter(),
      createMockEncryptionService() as unknown as EncryptionCore
    );
    await storage.saveProject(project());
  });

  const seed = async (chat: MinionChat, messages: Message<unknown>[]) => {
    await storage.saveMinionChat(chat);
    for (const m of messages) await storage.saveMinionMessage(chat.id, m);
  };

  it('inherits BOTH the session and the resume anchor', async () => {
    // A session without resumeAt is a bug, not a simplification: a plain
    // `resume` appends the clone's turns into the minion's own file.
    await seed(minionChat({ claudeAgentSessionId: 'sess-A' }), [
      userMsg('go'),
      assistantMsg('ok', { uuid: 'u1', sessionId: 'sess-A' }),
    ]);

    const { chat, notes } = await cloneMinionChatToChat(storage, 'minion-chat-1');
    expect(chat.claudeAgentSessionId).toBe('sess-A');
    expect(chat.claudeAgentResumeAt).toBe('u1');
    expect(notes.join(' ')).toContain('carried over');
  });

  it("takes the session from the last assistant's stamp, not the chat row", async () => {
    // The row can have moved on; the stamp is what the resolver is asked about.
    await seed(minionChat({ claudeAgentSessionId: 'sess-NEW' }), [
      assistantMsg('older', { uuid: 'u1', sessionId: 'sess-OLD' }),
    ]);

    const { chat } = await cloneMinionChatToChat(storage, 'minion-chat-1');
    expect(chat.claudeAgentSessionId).toBe('sess-OLD');
    expect(chat.claudeAgentResumeAt).toBe('u1');
  });

  it('walks back past an unstamped tail to the last stamped assistant', async () => {
    await seed(minionChat({ claudeAgentSessionId: 'sess-A' }), [
      assistantMsg('stamped', { at: '2024-01-01T00:01:00Z', uuid: 'u1', sessionId: 'sess-A' }),
      userMsg('next', '2024-01-01T00:02:00Z'),
    ]);

    const { chat } = await cloneMinionChatToChat(storage, 'minion-chat-1');
    expect(chat.claudeAgentResumeAt).toBe('u1');
  });

  it('falls back to the row session for an anchor that predates stamping', async () => {
    await seed(minionChat({ claudeAgentSessionId: 'sess-A' }), [
      assistantMsg('legacy', { uuid: 'u1' }),
    ]);

    const { chat } = await cloneMinionChatToChat(storage, 'minion-chat-1');
    expect(chat.claudeAgentSessionId).toBe('sess-A');
    expect(chat.claudeAgentResumeAt).toBe('u1');
  });

  it('copies the message stamps byte-identically — no remap', async () => {
    await seed(minionChat({ claudeAgentSessionId: 'sess-A' }), [
      assistantMsg('one', { at: '2024-01-01T00:01:00Z', uuid: 'u1', sessionId: 'sess-A' }),
      assistantMsg('two', { at: '2024-01-01T00:02:00Z', uuid: 'u2', sessionId: 'sess-A' }),
    ]);

    const { chat } = await cloneMinionChatToChat(storage, 'minion-chat-1');
    const copied = await storage.getMessages(chat.id);
    expect(copied.map(m => m.metadata?.claudeAgentMessageUuid)).toEqual(['u1', 'u2']);
    expect(copied.map(m => m.metadata?.claudeAgentSessionId)).toEqual(['sess-A', 'sess-A']);
  });

  it('resolves the anchor to the session that actually holds it', async () => {
    // A stamp can name a session a later fork collected; the uuid survives in
    // the fork, and that fork — not the tombstone — is what must be protected.
    await seed(minionChat({ claudeAgentSessionId: 'sess-DEAD' }), [
      assistantMsg('one', { uuid: 'u1', sessionId: 'sess-DEAD' }),
    ]);

    const { chat } = await cloneMinionChatToChat(storage, 'minion-chat-1', {
      resolveAnchorSession: async (_stated, uuid) => (uuid === 'u1' ? 'sess-FORK' : undefined),
    });

    expect(chat.claudeAgentSessionId).toBe('sess-FORK');
    expect(chat.claudeAgentResumeAt).toBe('u1');
    expect(chat.claudeAgentProtectedSessionIds).toEqual(['sess-FORK']);
    expect(chat.claudeAgentProtectedSessionIds).not.toContain('sess-DEAD');
  });

  it('keeps the message stamps verbatim even when the row is resolved elsewhere', async () => {
    // The stamps are the historical record of which session produced each turn;
    // only the resume pointer is forward-looking.
    await seed(minionChat({ claudeAgentSessionId: 'sess-DEAD' }), [
      assistantMsg('one', { uuid: 'u1', sessionId: 'sess-DEAD' }),
    ]);

    const { chat } = await cloneMinionChatToChat(storage, 'minion-chat-1', {
      resolveAnchorSession: async () => 'sess-FORK',
    });

    const copied = await storage.getMessages(chat.id);
    expect(copied[0].metadata?.claudeAgentSessionId).toBe('sess-DEAD');
  });

  it('falls back to the stamp when the resolver is unavailable (worker mode)', async () => {
    // `inspectProviderMessage` throws "requires server mode" there. The clone
    // must still be created, with today's stamp-based seeding.
    await seed(minionChat({ claudeAgentSessionId: 'sess-A' }), [
      assistantMsg('one', { uuid: 'u1', sessionId: 'sess-A' }),
    ]);

    const { chat } = await cloneMinionChatToChat(storage, 'minion-chat-1', {
      resolveAnchorSession: async () => {
        throw new Error('claude-agent: message inspection requires server mode');
      },
    });

    expect(chat.claudeAgentSessionId).toBe('sess-A');
    expect(chat.claudeAgentProtectedSessionIds).toEqual(['sess-A']);
  });

  it('falls back to the stamp when the resolver finds nothing', async () => {
    await seed(minionChat({ claudeAgentSessionId: 'sess-A' }), [
      assistantMsg('one', { uuid: 'u1', sessionId: 'sess-A' }),
    ]);

    const { chat } = await cloneMinionChatToChat(storage, 'minion-chat-1', {
      resolveAnchorSession: async () => undefined,
    });

    expect(chat.claudeAgentSessionId).toBe('sess-A');
  });

  it('seeds the protect list on BOTH the clone and the source minion chat', async () => {
    await seed(minionChat({ claudeAgentSessionId: 'sess-A' }), [
      assistantMsg('one', { uuid: 'u1', sessionId: 'sess-A' }),
    ]);

    const { chat } = await cloneMinionChatToChat(storage, 'minion-chat-1');
    expect(chat.claudeAgentProtectedSessionIds).toEqual(['sess-A']);

    const source = await storage.getMinionChat('minion-chat-1');
    expect(source?.claudeAgentProtectedSessionIds).toEqual(['sess-A']);
  });

  it("carries the source's existing protect list forward", async () => {
    // How a second clone of the same minion ends up spanning two live
    // ancestors: the first clone seeded 'sess-A' on the source, the minion has
    // since forked to 'sess-B', and both must survive.
    await seed(
      minionChat({ claudeAgentSessionId: 'sess-B', claudeAgentProtectedSessionIds: ['sess-A'] }),
      [assistantMsg('two', { uuid: 'u2', sessionId: 'sess-B' })]
    );

    const { chat } = await cloneMinionChatToChat(storage, 'minion-chat-1');
    expect(new Set(chat.claudeAgentProtectedSessionIds)).toEqual(new Set(['sess-A', 'sess-B']));
  });

  it('does NOT protect sessions that only appear in old message stamps', async () => {
    // After a fork+GC the surviving messages still name the deleted session —
    // their uuids live on in the fork, which is the baseline guarantee. Adding
    // those ids would fill the list with sessions that are already gone and
    // can never be protected, growing it without bound as history lengthens.
    await seed(minionChat({ claudeAgentSessionId: 'sess-B' }), [
      assistantMsg('old', { at: '2024-01-01T00:01:00Z', uuid: 'u1', sessionId: 'sess-DEAD' }),
      assistantMsg('new', { at: '2024-01-01T00:02:00Z', uuid: 'u2', sessionId: 'sess-B' }),
    ]);

    const { chat } = await cloneMinionChatToChat(storage, 'minion-chat-1');
    expect(chat.claudeAgentProtectedSessionIds).toEqual(['sess-B']);
  });

  it('skips tail closure for claude-agent clones', async () => {
    // The SDK owns the turn; a synthetic empty-text user message would become
    // `extractLastUserMessage`'s pick on a bare continue and throw.
    await seed(minionChat({ claudeAgentSessionId: 'sess-A' }), [
      assistantMsg('done', { uuid: 'u1', sessionId: 'sess-A', toolCalls: [returnCall] }),
    ]);

    const { chat } = await cloneMinionChatToChat(storage, 'minion-chat-1');
    const copied = await storage.getMessages(chat.id);
    expect(copied).toHaveLength(1);
    expect(copied[0].role).toBe('assistant');
  });

  it('degrades cleanly when no assistant anywhere carries a stamp', async () => {
    await seed(minionChat({ claudeAgentSessionId: 'sess-A' }), [
      userMsg('go'),
      assistantMsg('unstamped'),
    ]);

    const { chat, notes } = await cloneMinionChatToChat(storage, 'minion-chat-1');
    expect(chat.claudeAgentSessionId).toBeUndefined();
    expect(chat.claudeAgentResumeAt).toBeUndefined();
    expect(chat.claudeAgentProtectedSessionIds).toBeUndefined();
    expect(notes.join(' ')).toContain('could not be carried over');
  });

  it('strips stale stamps on the degrade path', async () => {
    // Leaving them would point a later rollback at a session this chat has no
    // claim on — and no protect list guarding it.
    await seed(minionChat({ claudeAgentSessionId: 'sess-A' }), [
      assistantMsg('unstamped-uuid', { sessionId: 'sess-A' }),
    ]);

    const copied = await storage.getMessages(
      (await cloneMinionChatToChat(storage, 'minion-chat-1')).chat.id
    );
    expect(copied[0].metadata?.claudeAgentSessionId).toBeUndefined();
  });

  it('leaves non-claude-agent clones entirely alone', async () => {
    await seed(minionChat(), [userMsg('go'), assistantMsg('done')]);
    const { chat, notes } = await cloneMinionChatToChat(storage, 'minion-chat-1');

    expect(chat.claudeAgentSessionId).toBeUndefined();
    expect(chat.claudeAgentProtectedSessionIds).toBeUndefined();
    expect(notes).toEqual([]);
  });
});
