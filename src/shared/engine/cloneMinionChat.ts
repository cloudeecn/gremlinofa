/**
 * Promote a minion transcript into a regular chat the user drives themselves.
 *
 * A minion chat carries ~20 per-chat config overrides the LLM set and the tool
 * persisted — persona, VFS namespace, prompt files, tool set, reasoning knobs.
 * Copying only its messages into a `Chat` would lose all of that and leave a
 * different agent wearing the same transcript, so the clone derives a
 * `ChatAgentConfig` from the `MinionChat` record alongside the copy.
 *
 * An engine orchestrator rather than a `UnifiedStorage` method: it needs
 * `project.toolOptions.minion` and `buildMinionTools`, and putting that in
 * `unifiedStorage.ts` would create a `storage → minionTool → storage` cycle
 * and drag the tool graph into the storage path. Same shape as
 * `exportRunner` / `importRunner`; storage stays a dumb row store.
 */

import type {
  APIType,
  Chat,
  ChatAgentConfig,
  Message,
  MessageAttachment,
  MinionChat,
  Project,
  ToolUseBlock,
} from '../protocol/types';
import { generateUniqueId } from '../protocol/idGenerator';
import type { UnifiedStorage } from '../services/storage/unifiedStorage';
import { buildMinionTools, findPriorAssistantClaudeAgentUuid } from '../services/tools/minionTool';
import { personaNamespace } from '../services/agentic/agentSystemPrompt';
import { ProtocolError } from './GremlinServer';
import {
  buildToolResultClosureMessage,
  unresolvedTailToolUses,
} from './lib/closeUnresolvedToolUses';

/**
 * Resolve which claude-agent session currently holds `uuid`.
 *
 * Injected rather than imported: the answer needs the provider's on-disk view,
 * which only exists server-side. `GremlinServer` backs it with
 * `inspectProviderMessage`; omitted or throwing (worker mode) falls back to
 * trusting the message stamp. Only pre-change lineages need it — see
 * `resolveInheritedSession`.
 */
export type AnchorSessionResolver = (
  statedSessionId: string | undefined,
  uuid: string
) => Promise<string | undefined>;

export interface CloneMinionChatOptions {
  targetProjectId?: string;
  name?: string;
  resolveAnchorSession?: AnchorSessionResolver;
}

export interface CloneMinionChatResult {
  chat: Chat;
  /** User-facing notes about what could and could not be carried over. */
  notes: string[];
}

/**
 * Derive the chat-level agent config that makes the clone behave like the
 * minion did.
 *
 * The mirror image of the minion tool's own prompt assembly — both feed
 * `resolveAgentSystemPrompt` the same four inputs, which is *why* the clone
 * reproduces the minion's prompt rather than merely resembling it.
 *
 * Exported for testing; pure.
 */
export function deriveChatAgentConfigFromMinion(
  minionChat: MinionChat,
  project: Project
): ChatAgentConfig {
  const minionOptions = project.toolOptions?.minion ?? {};
  const nsMode = (minionOptions.namespacedMinion as string | undefined) ?? 'off';
  const persona = minionChat.persona ?? 'default';
  const shouldNamespace = nsMode !== 'off' && (nsMode === 'all' || persona !== 'default');
  const usePersonaFile = shouldNamespace && persona !== 'default';
  const configuredPrompt =
    typeof minionOptions.systemPrompt === 'string' ? minionOptions.systemPrompt : '';

  // The tool-level configured prompt has no file behind it, so it is the one
  // thing that must be snapshotted. Persona, pre-persona and prompt files stay
  // *recipes* resolved from the VFS every turn, so editing them still takes
  // effect in the clone.
  const inlinePrompt = [usePersonaFile ? undefined : configuredPrompt, minionChat.systemPrompt]
    .filter(Boolean)
    .join('\n\n');

  return {
    // Mandatory: the minion never saw `project.systemPrompt`, so inheriting it
    // would put a second agent's instructions above the persona's.
    systemPromptMode: 'replace',
    persona: usePersonaFile ? persona : undefined,
    namespace: shouldNamespace ? personaNamespace(persona) : undefined,
    // `''` here is load-bearing, not a no-op: `undefined` would newly pull in
    // /minions/_global.md for a minion that never read it.
    prePersonaSystemPromptFile: shouldNamespace ? minionChat.prePersonaSystemPromptFile : '',
    systemPromptFile: minionChat.systemPromptFile,
    systemPrompt: inlinePrompt || undefined,
    // `includeMinion: false` is a decision, not an oversight. A cloned chat is
    // top-level, so `minionAvailablePersonas` would be undefined = unrestricted
    // — a privilege escalation over the minion, which ran under
    // `minionChat.availablePersonas`. The user can tick `minion` on in chat
    // settings and get ordinary top-level authority instead.
    enabledTools: buildMinionTools(
      minionChat.enabledTools,
      project.enabledTools ?? [],
      /* includeReturn */ false,
      /* includeMinion */ false
    ).filter(t => t !== 'return'),
    temperature: minionChat.temperature,
    maxOutputTokens: minionChat.maxOutputTokens,
    enableReasoning: minionChat.enableReasoning,
    reasoningBudgetTokens: minionChat.reasoningBudgetTokens,
    reasoningEffort: minionChat.reasoningEffort,
    verbosity: minionChat.verbosity,
    // `webSearchEnabled` is deliberately omitted — minion web access is
    // per-call (`enableWeb`) and never persisted, so there is nothing to carry.
    fileLineNumbers: minionChat.fileLineNumbers,
    nudgeThinking: minionChat.nudgeThinking,
    thinkingKeepTurns: minionChat.thinkingKeepTurns,
    pruneThinkingBeforeApiCall: minionChat.pruneThinkingBeforeApiCall,
  };
}

/** Name fallback chain: explicit → the minion's display name → persona → id. */
function deriveName(minionChat: MinionChat, explicit?: string): string {
  const persona = minionChat.persona ?? 'default';
  const fallback =
    minionChat.displayName ??
    (persona !== 'default' ? `${persona} (minion)` : `Minion ${minionChat.id.slice(-6)}`);
  return (explicit?.trim() || fallback).slice(0, 50);
}

export async function cloneMinionChatToChat(
  storage: UnifiedStorage,
  minionChatId: string,
  opts?: CloneMinionChatOptions
): Promise<CloneMinionChatResult> {
  const minionChat = await storage.getMinionChat(minionChatId);
  if (!minionChat) {
    throw new ProtocolError('MINION_CHAT_NOT_FOUND', `minion chat ${minionChatId} not found`);
  }

  const projectId = opts?.targetProjectId ?? minionChat.projectId;
  const project = await storage.getProject(projectId);
  if (!project) {
    throw new ProtocolError('PROJECT_NOT_FOUND', `project ${projectId} not found`);
  }

  const messages = await storage.getMinionMessages(minionChatId);
  const notes: string[] = [];
  const agentConfig = deriveChatAgentConfigFromMinion(minionChat, project);

  // Lineage, not just the row: a minion whose session was dropped after a
  // failed turn still has stamped messages, and those stamps are what a later
  // rollback would resolve through.
  const hasClaudeAgentLineage =
    !!minionChat.claudeAgentSessionId || messages.some(m => m.metadata?.claudeAgentMessageUuid);
  const session = hasClaudeAgentLineage
    ? await resolveInheritedSession(minionChat, messages, opts?.resolveAnchorSession)
    : undefined;
  if (hasClaudeAgentLineage && !session) {
    notes.push(
      'The Claude Agent SDK session could not be carried over — no message in this transcript ' +
        'records one. The next turn starts a fresh session with the transcript as its only ' +
        'context, so the agent will not remember the tool state, plan or todo list the minion had.'
    );
  } else if (session) {
    notes.push(
      'Claude Agent SDK session carried over — the clone branches off it on its first message.'
    );
  }

  // Walk backwards for the last assistant's recorded usage, same as `cloneChat`.
  let contextWindowUsage = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant' && msg.metadata?.contextWindowUsage !== undefined) {
      contextWindowUsage = msg.metadata.contextWindowUsage;
      break;
    }
  }

  // Skipped for claude-agent: the SDK owns the turn and closes its own bridged
  // tool calls, our stored tail is only a mirror, and a synthetic empty-text
  // user message would become `extractLastUserMessage`'s pick on a bare
  // continue and throw "no user content to send".
  const openToolUses = hasClaudeAgentLineage ? [] : unresolvedTailToolUses(messages);
  if (openToolUses.length > 0) {
    notes.push(
      openToolUses.some(b => b.name === 'return')
        ? 'The minion ended by calling `return`. That tool is not available in a regular chat, ' +
            'so the call has been closed off and you can reply to the agent directly.'
        : 'The transcript ended with unanswered tool calls; they have been closed off.'
    );
  }

  const now = new Date();
  const newChat: Chat = {
    id: generateUniqueId('chat'),
    projectId,
    name: deriveName(minionChat, opts?.name),
    createdAt: now,
    lastModifiedAt: now,
    apiDefinitionId: minionChat.apiDefinitionId ?? null,
    modelId: minionChat.modelId ?? null,
    agentConfig,
    clonedFromMinionChatId: minionChat.id,
    clonedFromChatId: minionChat.parentChatId,
    // Set explicitly so `listChatsWithMessageCounts` skips its N+1 backfill.
    messageCount: messages.length + (openToolUses.length > 0 ? 1 : 0),
    totalInputTokens: minionChat.totalInputTokens,
    totalOutputTokens: minionChat.totalOutputTokens,
    totalReasoningTokens: minionChat.totalReasoningTokens,
    totalCacheCreationTokens: minionChat.totalCacheCreationTokens,
    totalCacheReadTokens: minionChat.totalCacheReadTokens,
    totalCost: minionChat.totalCost,
    contextWindowUsage,
    costUnreliable: minionChat.costUnreliable,
    ...(session
      ? {
          // Both halves or neither. A session without `resumeAt` is a bug, not
          // a simplification: a plain `resume` appends the clone's turns into
          // the minion's own file, interleaving two conversations. With the
          // anchor the CLI forks and the clone owns its lineage from turn one.
          claudeAgentSessionId: session.sessionId,
          claudeAgentResumeAt: session.resumeAt,
          claudeAgentProtectedSessionIds: session.protectedIds,
        }
      : {}),
  };

  // Save the chat row first: every `saveMessage` calls `patchChat(touch)`,
  // which throws CHAT_NOT_FOUND on a missing row. `cloneChat` does the same.
  await storage.saveChat(newChat);

  let lastTimestamp = now;
  for (const msg of messages) {
    const newMsgId = generateUniqueId('msg');
    // Original timestamps are preserved — rows are ordered by timestamp, and
    // the copy has to keep the transcript's shape. Claude-agent stamps
    // (`claudeAgentMessageUuid` / `claudeAgentSessionId`) ride along verbatim:
    // the clone resumes the minion's own lineage and forks off it, so a remap
    // would break the very anchors it depends on.
    const newMsg: Message<unknown> = { ...msg, id: newMsgId };
    if (hasClaudeAgentLineage && !session) {
      // Session could not be carried; leaving stamps behind would point the
      // next rollback at a session this chat has no claim on.
      newMsg.metadata = stripClaudeAgentStamps(newMsg.metadata);
    }
    await storage.saveMessage(newChat.id, newMsg);
    lastTimestamp = msg.timestamp;

    if (msg.content.attachmentIds?.length) {
      const attachments = await storage.getAttachments(msg.id);
      for (const attachment of attachments) {
        const newAttachment: MessageAttachment = {
          ...attachment,
          id: generateUniqueId('att'),
        };
        await storage.saveAttachment(newMsgId, newAttachment);
      }
      const newAttachments = await storage.getAttachments(newMsgId);
      newMsg.content.attachmentIds = newAttachments.map(att => att.id);
      await storage.saveMessage(newChat.id, newMsg);
    }
  }

  if (openToolUses.length > 0) {
    const closure = buildToolResultClosureMessage(
      openToolUses,
      minionChat.apiDefinitionId
        ? await resolveApiType(storage, minionChat.apiDefinitionId)
        : undefined,
      lastTimestamp,
      closureResultFor
    );
    await storage.saveMessage(newChat.id, closure);
  }

  if (session) {
    // Seed the source side too, under its own keyed lock — this is the only
    // write the operation makes outside the new chat, and the reason the
    // source is patched rather than written back from the copy read above.
    const existing = minionChat.claudeAgentProtectedSessionIds ?? [];
    const merged = [...new Set([...existing, ...session.protectedIds])];
    if (merged.length !== existing.length) {
      await storage.patchMinionChat(minionChat.id, {
        claudeAgentProtectedSessionIds: merged,
      });
    }
  }

  return { chat: newChat, notes };
}

function closureResultFor(block: ToolUseBlock): { content: string; isError?: boolean } {
  if (block.name === 'return') {
    return {
      content:
        'This conversation was cloned into a regular chat; reply to the user directly from here.',
    };
  }
  return {
    content: 'Tool call skipped — this conversation was cloned into a regular chat.',
    isError: true,
  };
}

function stripClaudeAgentStamps(
  metadata: Message<unknown>['metadata']
): Message<unknown>['metadata'] {
  if (!metadata) return metadata;
  const { claudeAgentMessageUuid: _uuid, claudeAgentSessionId: _sid, ...rest } = metadata;
  return rest;
}

async function resolveApiType(
  storage: UnifiedStorage,
  apiDefinitionId: string
): Promise<APIType | undefined> {
  const apiDef = await storage.getAPIDefinition(apiDefinitionId);
  return apiDef?.apiType;
}

/**
 * Pick the `{sessionId, resumeAt}` pair the clone inherits, plus the sessions
 * both sides must stop rewinding.
 *
 * The anchor comes from the last assistant's *stamp*, not from the chat row:
 * the row can have moved on (a rollback repoints it), and the stamp is what the
 * resolver will actually be asked about. `findPriorAssistantClaudeAgentUuid`
 * walks back past unstamped legacy messages, falling back to the row's session
 * when the anchor itself predates stamping.
 *
 * **The anchor resolution heals pre-change lineages.** Current history can't
 * produce a stamp that lies: nothing is deleted, and a fork never mutates what
 * it copied, so the stamped session always still holds the uuid. Chats that
 * predate "fork on branch, not on rollback" are the exception — back then every
 * rollback forked and GC'd, leaving surviving messages naming a collected
 * session. Seeding from such a stamp would protect a tombstone while the session
 * both sides actually resume through went unprotected, so when a resolver is
 * available we ask it who holds the uuid now, and resume from (and protect) the
 * real holder. Message stamps themselves are never rewritten: they are the
 * historical record of which session produced each turn.
 */
async function resolveInheritedSession(
  minionChat: MinionChat,
  messages: Message<unknown>[],
  resolveAnchorSession: AnchorSessionResolver | undefined
): Promise<{ sessionId: string; resumeAt: string; protectedIds: string[] } | undefined> {
  const tailId = messages[messages.length - 1]?.id;
  const anchor = findPriorAssistantClaudeAgentUuid(
    messages as (Message<unknown> & { id: string })[],
    tailId
  );
  if (!anchor) return undefined;

  const statedSessionId = anchor.sessionId ?? minionChat.claudeAgentSessionId;

  let liveSessionId: string | undefined;
  if (resolveAnchorSession) {
    try {
      liveSessionId = await resolveAnchorSession(statedSessionId, anchor.uuid);
    } catch (err) {
      // Worker mode, or the provider could not read its own store. Falling back
      // to the stamp is exactly today's behaviour, so this degrades rather than
      // failing the clone.
      console.debug('[cloneMinionChat] anchor session resolution unavailable:', err);
    }
  }

  const sessionId = liveSessionId ?? statedSessionId;
  if (!sessionId) return undefined;

  const protectedIds = [
    ...new Set(
      [
        sessionId,
        // Without a resolver a live session and a tombstone are
        // indistinguishable, so keep the row's session too. Being over-broad
        // costs at most an extra fork, whereas missing the session that really
        // holds the anchor is what silently truncates the other side.
        ...(liveSessionId ? [] : [minionChat.claudeAgentSessionId]),
        // Already-vetted ancestors from an earlier clone of this minion.
        ...(minionChat.claudeAgentProtectedSessionIds ?? []),
      ].filter((id): id is string => !!id)
    ),
  ];

  return { sessionId, resumeAt: anchor.uuid, protectedIds };
}
