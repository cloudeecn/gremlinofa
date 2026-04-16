/**
 * Minion Tool
 *
 * Allows the primary chat LLM to delegate tasks to a sub-agent LLM.
 * Each minion runs its own agentic loop with scoped-down tools and
 * returns results to the caller.
 *
 * Key features:
 * - Real-time streaming via generator yields (groups_update events)
 * - Scoped tool access (minion can't spawn other minions)
 * - Separate minion chat storage for debugging/visibility
 * - Return tool support for explicit result signaling
 * - Builds renderingGroups with ToolInfoRenderBlock for nested display
 */

import type {
  ClientSideTool,
  Message,
  MinionChat,
  ModelReference,
  RenderingBlockGroup,
  SystemPromptContext,
  ToolContext,
  ToolInputSchema,
  ToolOptions,
  ToolResult,
  ToolResultBlock,
  ToolStreamEvent,
} from '../../protocol/types';
import type { ToolInfoRenderBlock, ToolResultRenderBlock } from '../../protocol/types/content';
import type { ActiveLoop, LoopId } from '../../protocol/protocol';
import { isModelReference, isModelReferenceArray } from '../../protocol/types';
import {
  generateChecksummedId,
  generateUniqueId,
  validateIdChecksum,
} from '../../protocol/idGenerator';
import type { UnifiedStorage } from '../storage/unifiedStorage';
import {
  runAgenticLoop,
  createToolResultRenderBlock,
  type AgenticLoopOptions,
  type AgenticLoopEvent,
} from '../agentic/agenticLoopGenerator';
import { createTokenTotals, addTokens } from '../../engine/lib/tokenTotals';
import { formatFileWithLineNumbers } from '../../engine/lib/formatFileContent';
import { JsVMContext } from './jsvm/JsVMContext';
import type { HookInputMessage } from '../agentic/dummyHookRuntime';

// Tool names that minions cannot use
const MINION_EXCLUDED_TOOLS = ['minion'];

/** Truncate error messages to avoid wasting parent LLM context tokens */
export function truncateError(message: string, limit = 200): string {
  if (message.length <= limit) return message;
  return message.slice(0, limit) + '...';
}

/** Format a ModelReference as "apiDefinitionId:modelId" for schema enum values */
export function formatModelString(ref: ModelReference): string {
  return `${ref.apiDefinitionId}:${ref.modelId}`;
}

/** Parse "apiDefinitionId:modelId" back to a ModelReference. First colon only — modelId can contain colons (Bedrock ARNs). */
export function parseModelString(str: string): ModelReference | undefined {
  const idx = str.indexOf(':');
  if (idx === -1) return undefined;
  return { apiDefinitionId: str.substring(0, idx), modelId: str.substring(idx + 1) };
}

/** Strip a namespace prefix from a path for minion-facing display */
export function stripNsPrefix(path: string, prefix?: string): string {
  if (!prefix) return path;
  if (path === prefix) return '/';
  if (path.startsWith(prefix + '/')) return path.slice(prefix.length);
  return path;
}

/** Stashed content from a rolled-back message for re-use during retry */
interface StashedRetryContent {
  modelFamily?: string;
  fullContent?: unknown;
  renderingContent?: RenderingBlockGroup[];
  injectedFiles?: Array<{ path: string; content: string }>;
  injectionMode?: string;
}

/**
 * Extract text from a tool_result message's fullContent.
 * buildToolResultMessage sets content.content = '' — the actual payload is in fullContent.
 */
function extractToolResultText(fullContent: unknown): string | undefined {
  if (!Array.isArray(fullContent) || fullContent.length === 0) return undefined;

  const first = fullContent[0];
  if (!first || typeof first !== 'object') return undefined;

  // Anthropic: { type: 'tool_result', content: string }
  if ('type' in first && first.type === 'tool_result' && 'content' in first) {
    return typeof first.content === 'string' ? first.content : undefined;
  }

  // Responses API: { type: 'function_call_output', output: string }
  if ('type' in first && first.type === 'function_call_output' && 'output' in first) {
    return typeof first.output === 'string' ? first.output : undefined;
  }

  // OpenAI Chat Completions: { type: 'tool_result', tool_call_id, content }
  // (same shape as Anthropic above — already handled)

  // Bedrock: { toolResult: { content: [{ text: string }] } }
  if ('toolResult' in first && first.toolResult && typeof first.toolResult === 'object') {
    const tr = first.toolResult as { content?: Array<{ text?: string }> };
    if (
      Array.isArray(tr.content) &&
      tr.content.length > 0 &&
      typeof tr.content[0].text === 'string'
    ) {
      return tr.content[0].text;
    }
  }

  return undefined;
}

// Maximum iterations for minion agentic loop (same as main loop)
const MAX_ITERATIONS = 50;

// Maximum auto-enforce retries when minion doesn't call the return tool
const AUTO_ENFORCE_MAX_RETRIES = 2;

// Sentinel savepoint value meaning "before any messages" (enables first-run retry)
export const SAVEPOINT_START = '_start';

/** Input parameters for minion tool */
interface MinionInput {
  /** Action: 'message' (default) sends a new message, 'retry' rolls back to savepoint and re-executes */
  action?: 'message' | 'retry';
  /** Optional: existing minion chat ID to continue a conversation */
  minionChatId?: string;
  /** Task/message to send to the minion. Required for 'message' action, optional for 'retry'. */
  message: string;
  /** Enable web search for the minion */
  enableWeb?: boolean;
  /** Scoped tools for the minion (intersected with project tools) */
  enabledTools?: string[];
  /** Persona name (matches /minions/<name>.md). Only used when namespacedMinion is enabled. */
  persona?: string;
  /** Model to use (formatted as "apiDefinitionId:modelId"). Only when namespacedMinion + models configured. */
  model?: string;
  /** Display name shown in the UI for this minion call. If omitted, persona name is used. */
  displayName?: string;
  /** VFS file paths to inject as context. Contents are prepended to the message. */
  injectFiles?: string[];
  /** Delegate to a remote human operator instead of an LLM sub-agent */
  remote?: boolean;
  /** Hook file name (without .js) in /hooks/ to verify minion output before savepoint advances */
  verifyHook?: string;
}

/** Result of rolling back messages to a savepoint */
interface RollbackResult {
  stashedRetryContent: StashedRetryContent | undefined;
  recoveredMessage: string | undefined;
}

/**
 * Roll back a minion chat to its savepoint.
 *
 * Slices messages after the savepoint, stashes content from the first
 * rolled-back message for re-use, recovers the original message text,
 * subtracts rolled-back token metadata, and deletes the messages from storage.
 *
 * Returns `{ undefined, undefined }` when nothing to roll back.
 */
async function rollbackToSavepoint(
  storage: UnifiedStorage,
  minionChat: MinionChat,
  existingMessages: Message<unknown>[],
  savepoint: string
): Promise<RollbackResult> {
  let rolledBack: Message<unknown>[];

  if (savepoint === SAVEPOINT_START) {
    rolledBack = existingMessages;
  } else {
    const savepointIdx = existingMessages.findIndex(m => m.id === savepoint);
    if (savepointIdx === -1) {
      return { stashedRetryContent: undefined, recoveredMessage: undefined };
    }
    rolledBack = existingMessages.slice(savepointIdx + 1);
  }

  if (rolledBack.length === 0) {
    return { stashedRetryContent: undefined, recoveredMessage: undefined };
  }

  // Stash content from the first rolled-back message for potential re-use in Phase 3.
  // Tool_result messages have fullContent (the API payload) — user messages have renderingContent
  // (injected file bars, text groups). Both paths preserve rendering fidelity on retry.
  let stashedRetryContent: StashedRetryContent | undefined;
  const stashedFirst = rolledBack[0].content;
  if (stashedFirst.fullContent) {
    stashedRetryContent = {
      modelFamily: stashedFirst.modelFamily as string | undefined,
      fullContent: stashedFirst.fullContent,
      renderingContent: stashedFirst.renderingContent as RenderingBlockGroup[] | undefined,
      injectedFiles: stashedFirst.injectedFiles,
      injectionMode: stashedFirst.injectionMode,
    };
  } else if (stashedFirst.renderingContent) {
    stashedRetryContent = {
      modelFamily: undefined,
      fullContent: undefined,
      renderingContent: stashedFirst.renderingContent as RenderingBlockGroup[],
      injectedFiles: stashedFirst.injectedFiles,
      injectionMode: stashedFirst.injectionMode,
    };
  }

  // Recover original message text from the first rolled-back message
  let recoveredMessage: string | undefined;
  const firstAfter = rolledBack[0];
  const textContent = firstAfter.content.content as string;
  if (textContent) {
    recoveredMessage = textContent;
  } else {
    recoveredMessage = extractToolResultText(firstAfter.content.fullContent) ?? undefined;
  }

  // Subtract rolled-back token metadata from chat totals
  for (const msg of rolledBack) {
    const meta = msg.metadata;
    if (meta) {
      minionChat.totalInputTokens = Math.max(
        0,
        (minionChat.totalInputTokens ?? 0) - (meta.inputTokens ?? 0)
      );
      minionChat.totalOutputTokens = Math.max(
        0,
        (minionChat.totalOutputTokens ?? 0) - (meta.outputTokens ?? 0)
      );
      minionChat.totalReasoningTokens = Math.max(
        0,
        (minionChat.totalReasoningTokens ?? 0) - (meta.reasoningTokens ?? 0)
      );
      minionChat.totalCacheCreationTokens = Math.max(
        0,
        (minionChat.totalCacheCreationTokens ?? 0) - (meta.cacheCreationTokens ?? 0)
      );
      minionChat.totalCacheReadTokens = Math.max(
        0,
        (minionChat.totalCacheReadTokens ?? 0) - (meta.cacheReadTokens ?? 0)
      );
      minionChat.totalCost = Math.max(0, (minionChat.totalCost ?? 0) - (meta.messageCost ?? 0));
    }
  }

  // Delete rolled-back messages from storage
  if (savepoint === SAVEPOINT_START) {
    await storage.deleteMessageAndAfter(minionChat.id, rolledBack[0].id);
  } else {
    await storage.deleteMessagesAfter(minionChat.id, savepoint);
  }

  return { stashedRetryContent, recoveredMessage };
}

/**
 * Resolve the effective return mode from tool options, with backward
 * compat for legacy `noReturnTool` / `returnOnly` booleans.
 */
function resolveReturnMode(opts: ToolOptions): string {
  if (typeof opts.returnMode === 'string') return opts.returnMode;
  if (opts.noReturnTool === true) return 'no-return';
  if (opts.returnOnly === true) return 'return-only';
  return 'both';
}

/**
 * Build effective tool list for minion.
 * Formula: (requestedTools ∩ projectTools) - minion + return
 *
 * @param requestedTools - Tools requested by the caller
 * @param projectTools - Tools enabled for the project
 * @returns Final list of tools available to the minion
 */
function buildMinionTools(
  requestedTools: string[] | undefined,
  projectTools: string[],
  includeReturn: boolean
): string[] {
  // Start with intersection
  let tools: string[];
  if (requestedTools && requestedTools.length > 0) {
    // Intersect requested with project tools
    const projectToolSet = new Set(projectTools);
    tools = requestedTools.filter(t => projectToolSet.has(t));
  } else {
    // No tools by default — caller must explicitly specify
    tools = [];
  }

  // Remove excluded tools (minion can't spawn minions)
  tools = tools.filter(t => !MINION_EXCLUDED_TOOLS.includes(t));

  if (includeReturn && !tools.includes('return')) {
    tools.push('return');
  }

  return tools;
}

/**
 * Build the ToolInfoRenderBlock group for a minion execution.
 * Placed at the start of renderingGroups to show task description and chat reference.
 */
function buildInfoGroup(
  taskMessage: string,
  chatId: string,
  persona?: string,
  displayName?: string,
  apiDefinitionId?: string,
  modelId?: string,
  injectedFiles?: Array<{ path: string; content: string; error?: boolean }>
): RenderingBlockGroup {
  const infoBlock: ToolInfoRenderBlock = {
    type: 'tool_info',
    input: taskMessage,
    chatId,
    persona,
    displayName,
    apiDefinitionId,
    modelId,
    injectedFiles,
  };
  return { category: 'backstage', blocks: [infoBlock] };
}

/** Default total remote timeout (10 minutes) */
const REMOTE_DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Execute a remote human minion call.
 *
 * Creates or reuses a session on the Touch Grass backend, sends the message,
 * and long-polls until the human responds or the total timeout is exceeded.
 */
async function* executeRemoteMinion(
  storage: UnifiedStorage,
  minionInput: MinionInput,
  minionChat: MinionChat,
  toolOptions: ToolOptions,
  endpoint: string,
  injectedFileEntries: Array<{ path: string; content: string; error?: boolean }>,
  injectedFilesPrefix: string
): AsyncGenerator<ToolStreamEvent, ToolResult, void> {
  const password = typeof toolOptions.remotePassword === 'string' ? toolOptions.remotePassword : '';
  const callerId = 'gremlinofa';
  const authHeader = 'Basic ' + btoa(`${callerId}:${password}`);
  const totalTimeoutMs =
    typeof toolOptions.remoteTimeoutMs === 'number'
      ? toolOptions.remoteTimeoutMs
      : REMOTE_DEFAULT_TIMEOUT_MS;

  // Create or reuse remote session
  let sessionId = minionChat.remoteSessionId;
  if (!sessionId) {
    try {
      const createRes = await fetch(`${endpoint}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: authHeader },
        body: JSON.stringify({ displayName: minionChat.displayName ?? minionInput.displayName }),
      });
      if (!createRes.ok) {
        const errText = await createRes.text();
        return {
          content: truncateError(`Error creating remote session: ${createRes.status} ${errText}`),
          isError: true,
        };
      }
      const createBody = (await createRes.json()) as { sessionId: string };
      sessionId = createBody.sessionId;
      minionChat.remoteSessionId = sessionId;
      await storage.saveMinionChat(minionChat);
    } catch (err) {
      return {
        content: truncateError(
          `Error connecting to remote backend: ${err instanceof Error ? err.message : String(err)}`
        ),
        isError: true,
      };
    }
  }

  // Send message + files to the remote session
  const fullMessage = injectedFilesPrefix + minionInput.message;
  const files = injectedFileEntries
    .filter(f => !f.error)
    .map(f => ({ path: f.path, content: f.content }));

  let requestId: string;
  try {
    const msgRes = await fetch(`${endpoint}/api/sessions/${sessionId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authHeader },
      body: JSON.stringify({ content: fullMessage, files: files.length > 0 ? files : undefined }),
    });
    if (!msgRes.ok) {
      const errText = await msgRes.text();
      return {
        content: truncateError(`Error sending remote message: ${msgRes.status} ${errText}`),
        isError: true,
      };
    }
    const msgBody = (await msgRes.json()) as { requestId: string };
    requestId = msgBody.requestId;
  } catch (err) {
    return {
      content: truncateError(
        `Error sending to remote backend: ${err instanceof Error ? err.message : String(err)}`
      ),
      isError: true,
    };
  }

  // Save the AI message to local minion chat storage
  const aiMessage: Message<unknown> = {
    id: generateUniqueId('msg_user'),
    role: 'user',
    content: { type: 'text', content: fullMessage },
    timestamp: new Date(),
  };
  await storage.saveMinionMessage(minionChat.id, aiMessage);

  // Build info group for display
  const personaLabel = minionChat.displayName ?? minionInput.displayName;
  const infoBlock: ToolInfoRenderBlock = {
    type: 'tool_info',
    input: minionInput.message,
    chatId: minionChat.id,
    persona: personaLabel,
    displayName: minionChat.displayName ?? minionInput.displayName,
  };
  const infoGroup: RenderingBlockGroup = { category: 'backstage', blocks: [infoBlock] };

  // Long-poll loop
  const startTime = Date.now();
  let humanResponse: string | undefined;

  while (Date.now() - startTime < totalTimeoutMs) {
    // Yield status update
    const waitingGroup: RenderingBlockGroup = {
      category: 'backstage',
      blocks: [
        {
          type: 'tool_result',
          name: 'minion',
          tool_use_id: '',
          content: 'Waiting for human response...',
          status: 'running',
        } as ToolResultRenderBlock,
      ],
    };
    yield { type: 'groups_update' as const, groups: [infoGroup, waitingGroup] };

    try {
      const pollRes = await fetch(`${endpoint}/api/requests/${requestId}/poll`, {
        headers: { Authorization: authHeader },
      });
      if (!pollRes.ok) {
        return {
          content: truncateError(`Error polling remote: ${pollRes.status}`),
          isError: true,
        };
      }
      const pollBody = (await pollRes.json()) as {
        status: 'pending' | 'answered' | 'expired';
        response?: { content: string };
      };

      if (pollBody.status === 'answered' && pollBody.response) {
        humanResponse = pollBody.response.content;
        break;
      }
      if (pollBody.status === 'expired') {
        return {
          content: truncateError('Remote request expired before human responded.'),
          isError: true,
          renderingGroups: [infoGroup],
        };
      }
      // status === 'pending': loop again
    } catch (err) {
      return {
        content: truncateError(
          `Error polling remote: ${err instanceof Error ? err.message : String(err)}`
        ),
        isError: true,
        renderingGroups: [infoGroup],
      };
    }
  }

  if (humanResponse === undefined) {
    return {
      content: truncateError(
        `Remote minion timed out after ${Math.round(totalTimeoutMs / 1000)}s without a human response.`
      ),
      isError: true,
      renderingGroups: [infoGroup],
    };
  }

  // Save human response to local minion chat storage
  const humanMessage: Message<unknown> = {
    id: generateUniqueId('msg_asst'),
    role: 'assistant',
    content: { type: 'text', content: humanResponse },
    timestamp: new Date(),
  };
  await storage.saveMinionMessage(minionChat.id, humanMessage);

  // Update savepoint
  minionChat.savepoint = humanMessage.id;
  minionChat.lastModifiedAt = new Date();
  await storage.saveMinionChat(minionChat);

  // Build result rendering
  const resultBlock: ToolResultRenderBlock = {
    type: 'tool_result',
    name: 'minion',
    tool_use_id: '',
    content: humanResponse,
    status: 'complete',
  };
  const resultGroup: RenderingBlockGroup = { category: 'text', blocks: [resultBlock] };

  return {
    content: `[Remote human response]\n\nminionChatId: ${minionChat.id}\n\n${humanResponse}`,
    renderingGroups: [infoGroup, resultGroup],
  };
}

/**
 * Execute the minion tool as an async generator.
 *
 * Creates or continues a minion chat, runs an agentic loop with scoped tools,
 * yields groups_update events for real-time streaming, and returns the final
 * result with renderingGroups for nested display.
 */
async function* executeMinion(
  input: Record<string, unknown>,
  toolOptions?: ToolOptions,
  context?: ToolContext
): AsyncGenerator<ToolStreamEvent, ToolResult, void> {
  const minionInput = input as unknown as MinionInput;
  const action = minionInput.action ?? 'message';

  // Stashed fullContent from a rolled-back tool_result message for re-use during retry.
  // When the stashed modelFamily matches the current apiDef.apiType, we can re-use the
  // original fullContent directly instead of reconstructing from extracted text.
  let stashedRetryContent: StashedRetryContent | undefined;

  // ── Phase 1: Validate inputs + load/create chat ──
  // Errors here indicate no state change; caller can resend to reattempt.

  const autoRollbackEnabled = toolOptions?.autoRollback === true;
  if (action === 'message' && !minionInput.message && !autoRollbackEnabled) {
    return {
      content: truncateError(
        'Error: "message" is required when action is "message" (or omitted). Resend to reattempt.'
      ),
      isError: true,
    };
  }
  if (action === 'retry' && !minionInput.minionChatId) {
    return {
      content: truncateError(
        'Error: "minionChatId" is required when action is "retry". Resend to reattempt.'
      ),
      isError: true,
    };
  }

  if (!context?.projectId) {
    return {
      content: truncateError('Error: projectId is required in context. Resend to reattempt.'),
      isError: true,
    };
  }

  // Bind injected backend deps locally so the helper functions and the main
  // body can read storage / api / tool registry without reaching for module
  // singletons. The agentic loop's `ToolContext` construction site always
  // populates these from `options.deps`.
  const storage = context.storage;
  const apiService = context.apiService;
  const toolRegistry = context.toolRegistry;

  // Load or create minion chat + handle retry rollback
  let minionChat: MinionChat;
  let existingMessages: Message<unknown>[] = [];

  if (minionInput.minionChatId) {
    if (validateIdChecksum(minionInput.minionChatId) === 'invalid') {
      return {
        content: truncateError(
          'Error: Invalid minionChatId (checksum mismatch) — the ID may have been copied incorrectly. Check the minionChatId from the previous minion result and resend.'
        ),
        isError: true,
      };
    }
    const existing = await storage.getMinionChat(minionInput.minionChatId);
    if (!existing) {
      return {
        content: truncateError(
          `Error: Minion chat not found: ${minionInput.minionChatId}. Resend to reattempt.`
        ),
        isError: true,
      };
    }
    minionChat = existing;
    existingMessages = await storage.getMinionMessages(minionInput.minionChatId);

    // Merge caller-provided settings into existing chat
    if (minionInput.displayName !== undefined) minionChat.displayName = minionInput.displayName;
    if (minionInput.persona !== undefined) minionChat.persona = minionInput.persona;
    if (minionInput.enabledTools !== undefined) minionChat.enabledTools = minionInput.enabledTools;
    if (minionInput.verifyHook !== undefined) minionChat.verifyHook = minionInput.verifyHook;

    if (action === 'retry') {
      // Retry: roll back to savepoint before proceeding
      if (minionChat.savepoint === undefined) {
        return {
          content: truncateError(
            'Error: Cannot retry — no savepoint on this minion chat. Resend to reattempt.'
          ),
          isError: true,
        };
      }

      const rollback = await rollbackToSavepoint(
        storage,
        minionChat,
        existingMessages,
        minionChat.savepoint
      );

      if (!rollback.stashedRetryContent && !rollback.recoveredMessage) {
        return {
          content: truncateError(
            'Error: No messages after savepoint to retry. Resend to reattempt.'
          ),
          isError: true,
        };
      }

      if (rollback.stashedRetryContent) stashedRetryContent = rollback.stashedRetryContent;
      if (!minionInput.message && rollback.recoveredMessage) {
        minionInput.message = rollback.recoveredMessage;
      } else if (!minionInput.message) {
        return {
          content: truncateError(
            'Error: message required — original could not be recovered. Resend to reattempt.'
          ),
          isError: true,
        };
      }

      existingMessages = await storage.getMinionMessages(minionChat.id);
      await storage.saveMinionChat(minionChat);
    } else {
      // Normal continuation: handle autoRollback if enabled, otherwise just proceed
      if (autoRollbackEnabled && minionChat.savepoint !== undefined) {
        const rollback = await rollbackToSavepoint(
          storage,
          minionChat,
          existingMessages,
          minionChat.savepoint
        );
        if (rollback.stashedRetryContent) stashedRetryContent = rollback.stashedRetryContent;
        if (!minionInput.message && rollback.recoveredMessage) {
          minionInput.message = rollback.recoveredMessage;
        }
        existingMessages = await storage.getMinionMessages(minionChat.id);
        await storage.saveMinionChat(minionChat);
      }
    }
  } else {
    // Create new minion chat with initial savepoint
    const parentChatId = context.chatId ?? 'standalone';
    minionChat = {
      id: generateChecksummedId('minion'),
      parentChatId,
      projectId: context.projectId,
      savepoint: SAVEPOINT_START,
      displayName: minionInput.displayName,
      persona: minionInput.persona,
      enabledTools: minionInput.enabledTools,
      verifyHook: minionInput.verifyHook,
      createdAt: new Date(),
      lastModifiedAt: new Date(),
    };
    await storage.saveMinionChat(minionChat);
  }

  // After autoRollback may have recovered a message, validate it's available
  if (!minionInput.message) {
    return {
      content: truncateError('Error: "message" is required. Resend to reattempt.'),
      isError: true,
    };
  }

  // ── Phase 2: Validation + setup ──
  // No state change yet. Errors here mean caller should resend.

  const allowWebSearch = toolOptions?.allowWebSearch === true;
  if (minionInput.enableWeb && !allowWebSearch) {
    return {
      content: truncateError(
        'Error: Web search is not allowed for minions. Enable "Allow Web Search" in minion tool options. Resend to reattempt.'
      ),
      isError: true,
    };
  }

  const minionToolOptions = toolOptions ?? {};
  const fileInjectionMode =
    (minionToolOptions.fileInjectionMode as 'inline' | 'separate-block' | 'as-file') ?? 'inline';

  // Resolve effective model: input.model (from LLM) > minionChat stored model > toolOptions.model (default)
  let effectiveModelRef: ModelReference | undefined;

  if (minionInput.model) {
    // LLM specified a model — validate against configured models list
    const modelsList = minionToolOptions.models;
    if (!isModelReferenceArray(modelsList) || modelsList.length === 0) {
      return {
        content: truncateError(
          'Error: model parameter provided but no models list configured. Resend to reattempt.'
        ),
        isError: true,
      };
    }

    const parsed = parseModelString(minionInput.model);
    if (!parsed) {
      return {
        content: truncateError(
          `Error: Invalid model format: "${minionInput.model}". Expected "apiDefinitionId:modelId". Resend to reattempt.`
        ),
        isError: true,
      };
    }

    const isInList = modelsList.some(
      ref => ref.apiDefinitionId === parsed.apiDefinitionId && ref.modelId === parsed.modelId
    );
    if (!isInList) {
      const available = modelsList.map(formatModelString).join(', ');
      return {
        content: truncateError(
          `Error: Model "${minionInput.model}" is not in the configured models list. Available: ${available}. Resend to reattempt.`
        ),
        isError: true,
      };
    }

    effectiveModelRef = parsed;
  } else if (minionChat.apiDefinitionId && minionChat.modelId) {
    // Continuation: use model stored from previous minion run
    effectiveModelRef = {
      apiDefinitionId: minionChat.apiDefinitionId,
      modelId: minionChat.modelId,
    };
  } else {
    // Fall back to default model option
    const defaultRef = minionToolOptions.model;
    if (defaultRef && isModelReference(defaultRef)) {
      effectiveModelRef = defaultRef;
    }
  }

  if (!effectiveModelRef) {
    return {
      content: truncateError(
        'Error: Minion model not configured. Please configure a model in project settings. Resend to reattempt.'
      ),
      isError: true,
    };
  }

  const project = await storage.getProject(context.projectId);
  if (!project) {
    return {
      content: truncateError(
        `Error: Project not found: ${context.projectId}. Resend to reattempt.`
      ),
      isError: true,
    };
  }

  const apiDef = await storage.getAPIDefinition(effectiveModelRef.apiDefinitionId);
  if (!apiDef) {
    return {
      content: truncateError(
        `Error: API definition not found: ${effectiveModelRef.apiDefinitionId}. Resend to reattempt.`
      ),
      isError: true,
    };
  }

  const model = await storage.getModel(
    effectiveModelRef.apiDefinitionId,
    effectiveModelRef.modelId
  );
  if (!model) {
    return {
      content: truncateError(
        `Error: Model not found: ${effectiveModelRef.modelId}. Resend to reattempt.`
      ),
      isError: true,
    };
  }

  const projectTools = project.enabledTools ?? [];
  const effectiveEnabledTools = minionInput.enabledTools ?? minionChat.enabledTools;

  if (effectiveEnabledTools && effectiveEnabledTools.length > 0) {
    const projectToolSet = new Set(projectTools);
    const invalidTools = effectiveEnabledTools.filter(
      t => t !== 'return' && !projectToolSet.has(t)
    );
    if (invalidTools.length > 0) {
      return {
        content: truncateError(
          `Error: Tools not available in project: ${invalidTools.join(', ')}. Available tools: ${projectTools.join(', ') || '(none)'}. Resend to reattempt.`
        ),
        isError: true,
      };
    }
  }

  const returnMode = resolveReturnMode(minionToolOptions);
  const includeReturn = returnMode !== 'no-return';
  const disableReasoning = minionToolOptions.disableReasoning === true;
  const minionTools = buildMinionTools(effectiveEnabledTools, projectTools, includeReturn);

  // ── Phase 3: Message + execution ──
  // User message will be saved. Errors here can be retried via action: 'retry'.

  // Check if last message is assistant with unresolved tool_use blocks (needs apiDef.apiType).
  // This happens when the return tool was called (possibly in parallel with other tools),
  // breaking the agentic loop before a tool_result message could be saved.
  let pendingReturnToolUse: { id: string; name: string } | undefined;
  let unresolvedNonReturnTools: { id: string; name: string }[] = [];
  if (existingMessages.length > 0) {
    const lastMsg = existingMessages[existingMessages.length - 1];
    if (lastMsg.role === 'assistant' && lastMsg.content.fullContent) {
      const toolUseBlocks = apiService.extractToolUseBlocks(
        apiDef.apiType,
        lastMsg.content.fullContent
      );
      if (toolUseBlocks.length > 0) {
        const returnToolUse = toolUseBlocks.find(t => t.name === 'return');
        if (returnToolUse) {
          pendingReturnToolUse = { id: returnToolUse.id, name: returnToolUse.name };
          unresolvedNonReturnTools = toolUseBlocks
            .filter(t => t.name !== 'return')
            .map(t => ({ id: t.id, name: t.name }));
        }
      }
    }
  }

  // Read injected files from VFS
  const injectedFileEntries: Array<{ path: string; content: string; error?: boolean }> = [];
  let injectedFilesPrefix = '';
  if (minionInput.injectFiles?.length) {
    // Compute namespace prefix so display paths can be relative to the minion's root
    const _nsMode = minionToolOptions.namespacedMinion ?? 'off';
    const _persona = minionInput.persona ?? minionChat.persona ?? 'default';
    const _shouldNs = _nsMode !== 'off' && (_nsMode === 'all' || _persona !== 'default');
    const injectNsPrefix = _shouldNs ? `/minions/${_persona}` : undefined;

    const rootAdapter = context.createVfsAdapter();
    const sections: string[] = [];
    for (const filePath of minionInput.injectFiles) {
      const displayPath = stripNsPrefix(filePath, injectNsPrefix);
      try {
        const fileContent = await rootAdapter.readFile(filePath);
        const formatted = project.noLineNumbers
          ? fileContent
          : formatFileWithLineNumbers(fileContent);
        const label = project.noLineNumbers ? '' : ' with line numbers';
        sections.push(
          `=== ${displayPath} ===\nHere's the content of ${displayPath}${label}:\n${formatted}`
        );
        injectedFileEntries.push({ path: displayPath, content: formatted });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        injectedFileEntries.push({ path: filePath, content: errMsg, error: true });
      }
    }
    // If any file failed to read, return error to the caller instead of launching minion
    const failedFiles = injectedFileEntries.filter(f => f.error);
    if (failedFiles.length > 0) {
      const paths = failedFiles.map(f => `${f.path}: ${f.content}`).join('\n');
      return {
        content: truncateError(
          `Error: Failed to read injected file(s):\n${paths}\nFix the paths and resend.`
        ),
        isError: true,
      };
    }
    injectedFilesPrefix = sections.join('\n\n') + '\n\n';
  }

  // ── Remote human minion branch ──
  if (minionInput.remote === true) {
    const remoteEndpoint =
      typeof minionToolOptions.remoteEndpoint === 'string'
        ? minionToolOptions.remoteEndpoint.replace(/\/+$/, '')
        : '';
    if (!remoteEndpoint) {
      return {
        content: truncateError(
          'Error: remote=true but no remoteEndpoint configured in minion tool options.'
        ),
        isError: true,
      };
    }
    return yield* executeRemoteMinion(
      storage,
      minionInput,
      minionChat,
      minionToolOptions,
      remoteEndpoint,
      injectedFileEntries,
      injectedFilesPrefix
    );
  }

  // Build info group for streaming display (include persona name for non-default personas)
  const personaLabel =
    minionChat.displayName ??
    (minionToolOptions.namespacedMinion !== 'off' &&
    minionChat.persona &&
    minionChat.persona !== 'default'
      ? minionChat.persona
      : undefined);
  const infoGroup = buildInfoGroup(
    minionInput.message,
    minionChat.id,
    personaLabel,
    minionChat.displayName,
    effectiveModelRef.apiDefinitionId,
    effectiveModelRef.modelId,
    injectedFileEntries.length > 0 ? injectedFileEntries : undefined
  );

  // Persist resolved model and tools into minionChat for future continuation
  minionChat.apiDefinitionId = effectiveModelRef.apiDefinitionId;
  minionChat.modelId = effectiveModelRef.modelId;
  minionChat.enabledTools = effectiveEnabledTools;

  // Build context for minion based on retry re-use, return tool resumption, or normal message
  let minionContext: Message<unknown>[];

  if (stashedRetryContent && stashedRetryContent.modelFamily === apiDef.apiType) {
    // Re-use original message with its fullContent (compatible API type).
    // This preserves the exact tool_result payload without lossy text extraction + reconstruction.
    const reusedMessage: Message<unknown> = {
      id: generateUniqueId('msg_user'),
      role: 'user',
      content: {
        type: 'text',
        content: minionInput.message,
        modelFamily: stashedRetryContent.modelFamily,
        fullContent: stashedRetryContent.fullContent,
        renderingContent: stashedRetryContent.renderingContent,
      },
      timestamp: new Date(),
    };
    await storage.saveMinionMessage(minionChat.id, reusedMessage);
    minionContext = [...existingMessages, reusedMessage];
  } else if (pendingReturnToolUse) {
    // Resume after return tool: build tool_result for the return tool + error results
    // for any other tools that were called in parallel and skipped.
    const toolResultBlocks: ToolResultBlock[] = [];
    const toolResultRenderBlocks: ToolResultRenderBlock[] = [];

    // Error results for tools that were skipped due to parallel return call
    for (const skipped of unresolvedNonReturnTools) {
      const errContent =
        'Tool call skipped: the return tool was called in parallel, which breaks the agentic loop. Other parallel tool calls cannot be executed.';
      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: skipped.id,
        name: skipped.name,
        content: errContent,
        is_error: true,
      });
      toolResultRenderBlocks.push(
        createToolResultRenderBlock(
          skipped.id,
          skipped.name,
          errContent,
          true,
          undefined,
          undefined,
          toolRegistry
        )
      );
    }

    // Return tool result: user's continuation message
    toolResultBlocks.push({
      type: 'tool_result',
      tool_use_id: pendingReturnToolUse.id,
      name: pendingReturnToolUse.name,
      content: minionInput.message,
    });
    toolResultRenderBlocks.push(
      createToolResultRenderBlock(
        pendingReturnToolUse.id,
        pendingReturnToolUse.name,
        minionInput.message,
        false,
        undefined,
        undefined,
        toolRegistry
      )
    );

    const toolResultMessage: Message<unknown> = {
      id: generateUniqueId('msg_user'),
      role: 'user',
      content: {
        type: 'text',
        content: '',
        modelFamily: apiDef.apiType,
      },
      timestamp: new Date(),
    };
    toolResultMessage.content.toolResults = toolResultBlocks;
    toolResultMessage.content.renderingContent = [
      { category: 'backstage' as const, blocks: toolResultRenderBlocks },
    ];

    await storage.saveMinionMessage(minionChat.id, toolResultMessage);

    minionContext = [...existingMessages, toolResultMessage];
  } else {
    // Normal case: build user message for minion
    // Use stashed renderingContent from retry if available and no new files were injected,
    // preserving file bar UI instead of rendering file content as plain text.
    let renderingGroups: RenderingBlockGroup[];
    if (stashedRetryContent?.renderingContent && injectedFileEntries.length === 0) {
      renderingGroups = stashedRetryContent.renderingContent;
    } else {
      renderingGroups = [];
      if (injectedFileEntries.length > 0) {
        renderingGroups.push({
          category: 'backstage',
          blocks: injectedFileEntries.map(f => ({
            type: 'injected_file' as const,
            path: f.path,
            content: f.content,
            error: f.error,
          })),
        });
      }
      renderingGroups.push({
        category: 'text',
        blocks: [{ type: 'text', text: minionInput.message }],
      });
    }

    // Determine effective injection mode, restoring from stash on retry
    const successFiles = injectedFileEntries.filter(f => !f.error);
    const effectiveMode =
      injectedFileEntries.length === 0 && stashedRetryContent?.injectedFiles
        ? ((stashedRetryContent.injectionMode as typeof fileInjectionMode) ?? 'inline')
        : fileInjectionMode;
    const effectiveFiles =
      successFiles.length > 0 ? successFiles : (stashedRetryContent?.injectedFiles ?? []);
    const useStructuredInjection = effectiveMode !== 'inline' && effectiveFiles.length > 0;

    // For inline mode: prepend file text into content string (original behavior).
    // For separate-block / as-file: keep content clean, store files on the message
    // so the API client can build native blocks.
    const llmContent = useStructuredInjection
      ? minionInput.message
      : injectedFilesPrefix
        ? injectedFilesPrefix + '=== end of files ===\n\n' + minionInput.message
        : minionInput.message;

    const userMessage: Message<string> = {
      id: generateUniqueId('msg_user'),
      role: 'user',
      content: {
        type: 'text',
        content: llmContent,
        renderingContent: renderingGroups,
        ...(useStructuredInjection && {
          injectedFiles: effectiveFiles.map(f => ({ path: f.path, content: f.content })),
          injectionMode: effectiveMode,
          modelFamily: apiDef.apiType,
        }),
      },
      timestamp: new Date(),
    };

    // Save user message to minion chat
    await storage.saveMinionMessage(minionChat.id, userMessage);

    minionContext = [...existingMessages, userMessage];
  }

  // Resolve persona and namespace based on namespacedMinion mode
  const nsMode = minionToolOptions.namespacedMinion ?? 'off';
  let minionNamespace: string | undefined;
  let minionSystemPrompt: string;

  if (nsMode === 'off') {
    // No namespace, no persona lookup
    minionSystemPrompt =
      typeof minionToolOptions.systemPrompt === 'string' ? minionToolOptions.systemPrompt : '';
  } else {
    const persona = minionInput.persona ?? minionChat.persona ?? 'default';

    // 'persona' mode: only non-default personas get namespaced
    // 'all' mode: everyone gets namespaced including default
    const shouldNamespace = nsMode === 'all' || persona !== 'default';

    if (shouldNamespace) {
      minionNamespace = `/minions/${persona}`;

      // Read persona files from root VFS (no namespace)
      const personaAdapter = context.createVfsAdapter();
      let globalPrompt = '';
      try {
        globalPrompt = await personaAdapter.readFile('/minions/_global.md');
      } catch {
        // No global prompt — that's fine
      }

      if (persona !== 'default') {
        // Read persona prompt from /minions/<persona>.md (root VFS, no namespace)
        try {
          const personaPrompt = await personaAdapter.readFile(`/minions/${persona}.md`);
          minionSystemPrompt = [globalPrompt, personaPrompt].filter(Boolean).join('\n\n');
        } catch {
          return {
            content: truncateError(
              `Error: Persona file /minions/${persona}.md not found. Create the file or use a different persona. Resend to reattempt.`
            ),
            isError: true,
          };
        }
      } else {
        // Default persona in 'all' mode uses configured system prompt + global
        const configuredPrompt =
          typeof minionToolOptions.systemPrompt === 'string' ? minionToolOptions.systemPrompt : '';
        minionSystemPrompt = [globalPrompt, configuredPrompt].filter(Boolean).join('\n\n');
      }
    } else {
      // 'persona' mode with default/no persona — behave like 'off'
      minionSystemPrompt =
        typeof minionToolOptions.systemPrompt === 'string' ? minionToolOptions.systemPrompt : '';
    }
  }

  // Build system prompts from enabled tools
  const systemPromptContext = {
    projectId: context.projectId,
    chatId: minionChat.id,
    apiDefinitionId: apiDef.id,
    modelId: model.id,
    apiType: apiDef.apiType,
    namespace: minionNamespace,
    createVfsAdapter: context.createVfsAdapter,
  };

  const toolSystemPrompts = await toolRegistry.getSystemPrompts(
    apiDef.apiType,
    minionTools,
    systemPromptContext,
    project.toolOptions ?? {}
  );

  // Combine system prompts: minion-specific + tool prompts
  const combinedSystemPrompt = [minionSystemPrompt, ...toolSystemPrompts]
    .filter(Boolean)
    .join('\n\n');

  // Build effective tool options — inject returnMode and deferReturn into return tool's options
  // so its description function reflects the current mode
  const deferReturnMode =
    typeof minionToolOptions.deferReturn === 'string'
      ? (minionToolOptions.deferReturn as 'no' | 'auto-ack' | 'free-run')
      : minionToolOptions.deferReturn === true
        ? 'free-run'
        : undefined;
  const effectiveToolOptions = { ...(project.toolOptions ?? {}) };
  effectiveToolOptions.return = {
    ...effectiveToolOptions.return,
    returnMode,
    ...(deferReturnMode && deferReturnMode !== 'no' ? { deferReturn: deferReturnMode } : {}),
  };

  // ── Child loop registration with LoopRegistry ──
  // The minion tool spawns its own agentic loop directly (it doesn't go
  // through ChatRunner), so the registry never sees it unless we register
  // here. Without this the sidebar Running Loops UI cannot show parallel
  // minion calls or hard-abort one without killing the parent. Skip
  // registration when the parent isn't tracked (test/standalone path) —
  // there's no meaningful parent to nest under in that case.
  const shouldRegisterChildLoop = context.loopId !== undefined;
  const childLoopId: LoopId | undefined = shouldRegisterChildLoop
    ? generateUniqueId('loop')
    : undefined;
  // Fresh AbortController per child so the sidebar can hard-abort one
  // minion without aborting siblings or the parent. Parent → child
  // cascade is wired below via a one-shot listener; child → parent
  // cascade does NOT happen.
  const childAbortController = new AbortController();
  const onParentAbort = () => childAbortController.abort();
  if (context.signal.aborted) {
    childAbortController.abort();
  } else {
    context.signal.addEventListener('abort', onParentAbort, { once: true });
  }

  if (childLoopId) {
    const childActiveLoop: ActiveLoop = {
      loopId: childLoopId,
      // Use the parent chat id so the sidebar groups the row under the
      // chat the user is actually viewing. Falls back to the minion chat
      // id only when the parent doesn't have one (defensive — production
      // always sets it via ChatRunner's context).
      chatId: context.chatId ?? minionChat.id,
      parentLoopId: context.loopId,
      startedAt: Date.now(),
      status: 'running',
      apiDefinitionId: effectiveModelRef.apiDefinitionId,
      modelId: effectiveModelRef.modelId,
      // The sidebar prefers `displayName` over the chat name; reuse the
      // same persona/displayName label the streaming info group uses so
      // the row is recognizable.
      displayName: personaLabel ?? minionInput.displayName,
    };
    context.loopRegistry.register(childActiveLoop, childAbortController);
  }

  // Build agentic loop options for minion
  const loopOptions: AgenticLoopOptions = {
    apiDef,
    model,
    projectId: context.projectId,
    chatId: minionChat.id,
    // PR 4: forward the parent loop's id so the LoopRegistry can render the
    // minion run as a child of the loop that called the minion tool. The
    // child's own `loopId` is minted by the backend in PR 7+.
    loopId: childLoopId,
    parentLoopId: context.loopId,
    temperature: project.temperature ?? undefined,
    maxTokens: project.maxOutputTokens,
    systemPrompt: combinedSystemPrompt || undefined,
    preFillResponse: undefined, // Minions don't use prefill
    webSearchEnabled: allowWebSearch && (minionInput.enableWeb ?? false),
    enabledTools: minionTools,
    toolOptions: effectiveToolOptions,
    disableStream: project.disableStream ?? false,
    extendedContext: project.extendedContext ?? false,
    namespace: minionNamespace,
    createVfsAdapter: context.createVfsAdapter,
    deferReturn: deferReturnMode && deferReturnMode !== 'no' ? deferReturnMode : undefined,
    fallbackToolExtraction: true,
    deferredSoftStopRounds:
      typeof minionToolOptions.deferredSoftStopRounds === 'number'
        ? minionToolOptions.deferredSoftStopRounds
        : undefined,
    deferredForceStopRounds:
      typeof minionToolOptions.deferredForceStopRounds === 'number'
        ? minionToolOptions.deferredForceStopRounds
        : undefined,
    returnAckMessage:
      typeof minionToolOptions.returnAckMessage === 'string' && minionToolOptions.returnAckMessage
        ? minionToolOptions.returnAckMessage
        : undefined,
    returnDuplicateMessage:
      typeof minionToolOptions.returnDuplicateMessage === 'string' &&
      minionToolOptions.returnDuplicateMessage
        ? minionToolOptions.returnDuplicateMessage
        : undefined,
    autoAckMessage:
      typeof minionToolOptions.autoAckMessage === 'string' && minionToolOptions.autoAckMessage
        ? minionToolOptions.autoAckMessage
        : undefined,
    // Reasoning settings from project
    enableReasoning: disableReasoning ? false : project.enableReasoning,
    reasoningBudgetTokens: project.reasoningBudgetTokens,
    thinkingKeepTurns: project.thinkingKeepTurns,
    reasoningEffort: project.reasoningEffort,
    reasoningSummary: project.reasoningSummary,
    // The child loop runs against its OWN AbortController so the sidebar
    // can hard-abort one minion without aborting siblings. The parent's
    // signal still propagates via the one-shot listener wired above —
    // aborting the parent fires every child's controller too.
    signal: childAbortController.signal,
    // Forward the parent loop's injected backend bundle so the minion's
    // child loop runs against the same storage / encryption / api / tool
    // registry instances the parent received. Threading the bundle this way
    // — instead of importing module-level singletons — is what makes the
    // child loop work in worker mode against remote storage.
    deps: {
      storage: context.storage,
      encryption: context.encryption,
      apiService: context.apiService,
      toolRegistry: context.toolRegistry,
      loopRegistry: context.loopRegistry,
    },
  };

  // Run agentic loop with streaming
  const totals = createTokenTotals();
  // Accumulated finalized blocks from all minion messages (marked as tool-generated)
  const accumulatedGroups: RenderingBlockGroup[] = [];
  // Text content from all assistant messages in this turn
  const accumulatedText: string[] = [];
  let assistantMessageCount = 0;
  let usedReturnTool = false;
  let returnValue: string | undefined;

  // Tracks the terminal status we'll report to the LoopRegistry in the
  // outer `finally`. Defaults to `error` so any unexpected throw or
  // early-return path before the loop produces a meaningful status still
  // closes out the registration with a sane terminal state.
  let terminalRegistryStatus: 'complete' | 'error' | 'aborted' | 'soft_stopped' | 'max_iterations' =
    'error';

  try {
    type LoopFinalResult =
      Awaited<ReturnType<typeof runAgenticLoop>> extends AsyncGenerator<infer _E, infer R, infer _N>
        ? R
        : never;

    let loopMessages = minionContext;
    let autoEnforceAttempts = 0;
    let lastFinalResult: LoopFinalResult | undefined;

    // Main execution loop (re-runs for auto-enforce retries)
    while (true) {
      const gen = runAgenticLoop(loopOptions, loopMessages);

      // Consume generator, handling events
      let iterResult: IteratorResult<AgenticLoopEvent, LoopFinalResult>;

      do {
        iterResult = await gen.next();

        if (!iterResult.done) {
          const event = iterResult.value;

          switch (event.type) {
            case 'streaming_chunk':
              // Yield accumulated + current streaming groups for real-time display
              yield {
                type: 'groups_update',
                groups: [infoGroup, ...accumulatedGroups, ...event.groups],
              };
              break;

            case 'message_created':
              // Save message to minion chat
              await storage.saveMinionMessage(minionChat.id, event.message);
              if (event.message.role === 'assistant') {
                assistantMessageCount++;
              }
              // Accumulate rendering content, mark as tool-generated
              if (event.message.content.renderingContent) {
                const markedGroups = event.message.content.renderingContent.map(g => ({
                  ...g,
                  isToolGenerated: true,
                }));
                accumulatedGroups.push(...markedGroups);
              }
              // Accumulate text from assistant messages
              if (event.message.role === 'assistant' && event.message.content.content) {
                accumulatedText.push(event.message.content.content as string);
              }
              // Yield updated finalized content
              yield {
                type: 'groups_update',
                groups: [infoGroup, ...accumulatedGroups],
              };
              break;

            case 'tokens_consumed':
              addTokens(totals, event.tokens);
              break;

            case 'streaming_start':
            case 'streaming_end':
            case 'first_chunk':
            case 'pending_tool_result':
            case 'tool_block_update':
            case 'checkpoint_set':
            case 'active_hook_changed':
            case 'chat_metadata_updated':
            case 'dummy_hook_start':
            case 'dummy_hook_end':
              break;
          }
        }
      } while (!iterResult.done);

      lastFinalResult = iterResult.value;
      // Mirror the loop's terminal status into the variable the outer
      // `finally` reports to the LoopRegistry. Status keeps the LAST
      // iteration's value across auto-enforce retries (which is what we
      // want — the registry sees the final outcome, not the intermediate
      // re-runs).
      terminalRegistryStatus = lastFinalResult.status;

      // Determine response based on final status
      if (lastFinalResult.status === 'complete' && lastFinalResult.returnValue !== undefined) {
        usedReturnTool = true;
        returnValue = lastFinalResult.returnValue;
      } else if (lastFinalResult.status === 'error') {
        return {
          content: truncateError(`Minion error: ${lastFinalResult.error.message}`),
          isError: true,
          renderingGroups: [infoGroup, ...accumulatedGroups],
          tokenTotals: totals,
        };
      } else if (lastFinalResult.status === 'aborted') {
        // Sidebar STOP on this minion row (or parent abort cascading
        // through the wired listener). Return an error tool result so the
        // parent agentic loop continues with its other parallel branches
        // intact instead of inheriting the abort.
        return {
          content: truncateError('Minion was aborted'),
          isError: true,
          renderingGroups: [infoGroup, ...accumulatedGroups],
          tokenTotals: totals,
        };
      } else if (lastFinalResult.status === 'max_iterations') {
        // If a deferred return was stored before hitting max iterations, use it
        if (lastFinalResult.returnValue !== undefined) {
          usedReturnTool = true;
          returnValue = lastFinalResult.returnValue;
        } else {
          return {
            content: truncateError(`Minion reached maximum iterations (${MAX_ITERATIONS})`),
            isError: true,
            renderingGroups: [infoGroup, ...accumulatedGroups],
            tokenTotals: totals,
          };
        }
      } else if (lastFinalResult.status === 'soft_stopped') {
        return {
          content: truncateError('Minion was stopped before completion'),
          isError: true,
          renderingGroups: [infoGroup, ...accumulatedGroups],
          tokenTotals: totals,
        };
      }

      // Auto-enforce retry: if return wasn't called and retries remain, send reminder and re-run
      if (
        returnMode === 'auto-enforced' &&
        !usedReturnTool &&
        autoEnforceAttempts < AUTO_ENFORCE_MAX_RETRIES
      ) {
        autoEnforceAttempts++;
        const reminderMessage: Message<string> = {
          id: generateUniqueId('msg_user'),
          role: 'user',
          content: {
            type: 'text',
            content:
              (typeof minionToolOptions.returnEnforceMessage === 'string' &&
                minionToolOptions.returnEnforceMessage) ||
              'You have not used the return tool to respond. Please put your response in the return tool call.',
          },
          timestamp: new Date(),
        };
        await storage.saveMinionMessage(minionChat.id, reminderMessage);
        // Add reminder to accumulated rendering groups
        accumulatedGroups.push({
          category: 'text',
          blocks: [{ type: 'text', text: reminderMessage.content.content }],
          isToolGenerated: true,
        });
        yield {
          type: 'groups_update',
          groups: [infoGroup, ...accumulatedGroups],
        };
        loopMessages = await storage.getMinionMessages(minionChat.id);
        continue;
      }

      break;
    }

    // Guard: no assistant message produced at all
    if (assistantMessageCount === 0) {
      return {
        content: truncateError('Minion completed but no assistant message was produced'),
        isError: true,
        renderingGroups: [infoGroup, ...accumulatedGroups],
        tokenTotals: totals,
      };
    }

    // Determine stop reason from last assistant message
    let stopReason = 'end_turn';
    if (lastFinalResult && lastFinalResult.messages.length > 0) {
      const lastMsg = lastFinalResult.messages[lastFinalResult.messages.length - 1];
      if (lastMsg.role === 'assistant') {
        stopReason = (lastMsg.content.stopReason as string) ?? 'end_turn';
      }
    }
    // Map tool_use → end_turn when return tool triggered completion
    if (usedReturnTool && stopReason === 'tool_use') {
      stopReason = 'end_turn';
    }

    // Abnormal stop reasons → error (skip savepoint so next call can roll back)
    const normalStopReasons = new Set(['end_turn', 'stop_sequence']);
    if (!normalStopReasons.has(stopReason)) {
      return {
        content: truncateError(`Minion ended unexpectedly (${stopReason})`),
        isError: true,
        renderingGroups: [infoGroup, ...accumulatedGroups],
        tokenTotals: totals,
      };
    }

    // ── Verify hook: run VFS-based JS to validate minion output before savepoint ──
    if (minionChat.verifyHook) {
      const hookPath = `/hooks/${minionChat.verifyHook}.js`;
      const hookAdapter = context.createVfsAdapter();
      let hookCode: string | null = null;
      try {
        hookCode = await hookAdapter.readFile(hookPath);
      } catch {
        // VFS error — treat as missing
      }
      if (!hookCode) {
        return {
          content: truncateError(`Verify hook file not found: ${hookPath}`),
          isError: true,
          renderingGroups: [infoGroup, ...accumulatedGroups],
          tokenTotals: totals,
        };
      }

      // Gather new messages from this run
      const allStoredMessages = await storage.getMinionMessages(minionChat.id);
      const newMessages = allStoredMessages.slice(existingMessages.length);

      // Condense to HookInputMessage format
      const condensed: HookInputMessage[] = newMessages.map(msg => {
        const entry: HookInputMessage = {
          id: msg.id,
          role: msg.role as 'user' | 'assistant' | 'system',
        };
        const textContent = msg.content.content as string | undefined;
        if (textContent?.trim()) entry.text = textContent;
        if (msg.content.toolCalls?.length) {
          entry.toolCalls = msg.content.toolCalls.map(tc => ({
            id: tc.id,
            name: tc.name,
            input: tc.input,
          }));
        }
        if (msg.content.toolResults?.length) {
          entry.toolResults = msg.content.toolResults.map(tr => ({
            tool_use_id: tr.tool_use_id,
            name: tr.name ?? 'unknown',
            content: tr.content,
            ...(tr.is_error ? { is_error: true } : {}),
          }));
        }
        return entry;
      });

      // Run hook in QuickJS sandbox
      const vm = await JsVMContext.create(hookAdapter, false, false);
      try {
        const wrappedCode = `
          (async function() {
            var __verifyFn = await (async function() {
              ${hookCode}
            })();
            if (typeof __verifyFn !== 'function') {
              throw new Error('verifyHook file must return a function');
            }
            return __verifyFn(${JSON.stringify(condensed)});
          })()
        `;

        const evalResult = await vm.evaluate(wrappedCode, 'verifyHook');

        if (evalResult.isError) {
          return {
            content: truncateError(
              `Verify hook error: ${String(evalResult.value ?? 'Unknown error')}`
            ),
            isError: true,
            renderingGroups: [infoGroup, ...accumulatedGroups],
            tokenTotals: totals,
          };
        }

        // Nullish → pass; string → rejection
        if (evalResult.value !== null && evalResult.value !== undefined) {
          const errorMsg =
            typeof evalResult.value === 'string'
              ? evalResult.value
              : JSON.stringify(evalResult.value);
          return {
            content: truncateError(`Verify hook rejected: ${errorMsg}`),
            isError: true,
            renderingGroups: [infoGroup, ...accumulatedGroups],
            tokenTotals: totals,
          };
        }
      } finally {
        vm.dispose();
      }
    }

    // Advance savepoint to the last message after successful execution
    const allMessages = [...existingMessages, ...(lastFinalResult?.messages ?? [])];
    const finalSavepoint =
      allMessages.length > 0 ? allMessages[allMessages.length - 1].id : SAVEPOINT_START;

    // Update minion chat with totals and new savepoint (after all retries)
    const updatedMinionChat: MinionChat = {
      ...minionChat,
      savepoint: finalSavepoint,
      totalInputTokens: (minionChat.totalInputTokens ?? 0) + totals.inputTokens,
      totalOutputTokens: (minionChat.totalOutputTokens ?? 0) + totals.outputTokens,
      totalReasoningTokens: (minionChat.totalReasoningTokens ?? 0) + totals.reasoningTokens,
      totalCacheCreationTokens:
        (minionChat.totalCacheCreationTokens ?? 0) + totals.cacheCreationTokens,
      totalCacheReadTokens: (minionChat.totalCacheReadTokens ?? 0) + totals.cacheReadTokens,
      totalCost: (minionChat.totalCost ?? 0) + totals.cost,
      costUnreliable: totals.costUnreliable || minionChat.costUnreliable || undefined,
      lastModifiedAt: new Date(),
    };
    await storage.saveMinionChat(updatedMinionChat);

    // Build result content
    const joinedText = accumulatedText.join('\n\n');
    const minionTag = `<minionChatId>${minionChat.id}</minionChatId>`;
    const hasCoT = !!lastFinalResult?.hasCoT;
    let resultContent: string;

    if (returnMode === 'both') {
      // JSON format for 'both' mode (can have text + result)
      const resultJson: Record<string, unknown> = {
        stopReason,
        hasCoT,
        minionChatId: minionChat.id,
        text: joinedText,
      };
      if (usedReturnTool && returnValue !== undefined) {
        resultJson.result = returnValue;
      }
      resultContent = JSON.stringify(resultJson);
    } else {
      // Simplified tag format for all other modes
      let body: string;
      if (usedReturnTool && returnValue !== undefined) {
        body = returnValue;
      } else if (returnMode === 'enforced' || returnMode === 'auto-enforced') {
        body = 'Warning: Return tool was not called';
      } else {
        // no-return mode, or return-only fallback when return wasn't called
        body = joinedText;
      }
      const hasCoTTag = hasCoT ? '<hasCoT />\n' : '';
      resultContent = minionTag + '\n' + hasCoTTag + body;
    }

    // Reaching here means the loop ended with `complete` (with or without
    // a return value) or `max_iterations` with a deferred return captured
    // before the limit hit. Both are accurate terminal states for the
    // registry — `terminalRegistryStatus` was set inside the do/while loop
    // from `lastFinalResult.status`, so no override needed.
    return {
      content: resultContent,
      renderingGroups: [infoGroup, ...accumulatedGroups],
      tokenTotals: totals,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    terminalRegistryStatus = 'error';
    return {
      content: truncateError(`Minion execution failed: ${message}`),
      isError: true,
      renderingGroups: [infoGroup, ...accumulatedGroups],
      tokenTotals: totals,
    };
  } finally {
    // Tear down the parent → child cascade listener (if it ever fired,
    // it removed itself thanks to `{ once: true }`; this catches the
    // common case where the parent stayed alive). Then unregister the
    // child loop with the registry's terminal status. The order matters:
    // remove the listener first so a parent abort racing with `end()`
    // doesn't fire a no-op on an already-aborted controller.
    context.signal.removeEventListener('abort', onParentAbort);
    if (childLoopId) {
      context.loopRegistry.end(childLoopId, terminalRegistryStatus);
    }
  }
}

/**
 * Render minion tool input for display
 */
function renderMinionInput(input: Record<string, unknown>): string {
  const minionInput = input as unknown as MinionInput;
  const lines: string[] = [];

  if (minionInput.action === 'retry') {
    lines.push('Action: retry');
  }

  if (minionInput.minionChatId) {
    lines.push(`Continue: ${minionInput.minionChatId}`);
  }

  if (minionInput.enabledTools?.length) {
    lines.push(`Tools: ${minionInput.enabledTools.join(', ')}`);
  }

  if (minionInput.enableWeb) {
    lines.push('Web: enabled');
  }

  if (minionInput.model) {
    lines.push(`Model: ${minionInput.model}`);
  }

  if (minionInput.displayName) {
    lines.push(`Display: ${minionInput.displayName}`);
  }

  if (minionInput.remote) {
    lines.push('Remote: human');
  }

  if (minionInput.verifyHook) {
    lines.push(`VerifyHook: ${minionInput.verifyHook}`);
  }

  if (minionInput.injectFiles?.length) {
    lines.push(`Files: ${minionInput.injectFiles.join(', ')}`);
  }

  if (minionInput.message) {
    lines.push('');
    lines.push(minionInput.message);
  }

  return lines.join('\n');
}

/** Extract minionChatId, hasCoT, and body from simplified tag format */
export function parseSimplifiedOutput(
  output: string
): { minionChatId: string; hasCoT: boolean; body: string } | undefined {
  const match = output.match(
    /^<minionChatId>([^<]+)<\/minionChatId>\n?(?:<hasCoT \/>\n?)?([\s\S]*)$/
  );
  if (!match) return undefined;
  return { minionChatId: match[1], hasCoT: output.includes('<hasCoT />'), body: match[2] };
}

/**
 * Render minion tool output for display
 */
function renderMinionOutput(output: string, isError?: boolean): string {
  if (isError) {
    return output;
  }

  // Simplified tag format (non-both modes)
  const simplified = parseSimplifiedOutput(output);
  if (simplified) {
    const lines: string[] = [];
    if (simplified.hasCoT) {
      lines.push('[CoT: yes]');
    }
    if (simplified.body) {
      lines.push(simplified.body);
    }
    lines.push(`[minionChatId: ${simplified.minionChatId}]`);
    return lines.join('\n\n');
  }

  // JSON format (both mode, legacy)
  try {
    const parsed = JSON.parse(output);
    const lines: string[] = [];

    if (parsed.hasCoT) {
      lines.push('[CoT: yes]');
    }
    if (parsed.warning) {
      lines.push(`⚠ ${parsed.warning}`);
    }
    if (parsed.text) {
      lines.push('Text output captured.');
    }
    if (parsed.result !== undefined) {
      lines.push(parsed.result);
    }
    if (parsed.minionChatId) {
      lines.push(`[minionChatId: ${parsed.minionChatId}]`);
    }

    return lines.join('\n\n');
  } catch {
    return output;
  }
}

/**
 * System prompt for persona discovery.
 * Lists available persona files from /minions/ when namespacedMinion is enabled.
 */
async function getMinionSystemPromptInjection(
  context: SystemPromptContext,
  opts: ToolOptions
): Promise<string> {
  if (opts.namespacedMinion === 'off' || !opts.namespacedMinion) return '';

  // VFS access lives only in the worker. `createVfsAdapter` is always
  // populated by `buildLoopOptions`, which is the single production
  // constructor of `SystemPromptContext`. Anything reaching this code
  // path without one is an upstream bug — fail loudly instead of
  // silently returning an empty prompt.
  if (!context.createVfsAdapter) {
    throw new Error(
      'minionTool.getMinionSystemPromptInjection: SystemPromptContext.createVfsAdapter is required. ' +
        'VFS access is only available inside the worker — direct service-layer calls are unsupported.'
    );
  }
  const adapter = context.createVfsAdapter();

  try {
    const dirExists = await adapter.isDirectory('/minions');
    if (!dirExists) return '';

    const entries = await adapter.readDir('/minions');
    const personaFiles = entries
      .filter(e => e.type === 'file' && e.name.endsWith('.md'))
      .sort((a, b) => a.name.localeCompare(b.name));

    if (personaFiles.length === 0) return '';

    const lines = ['## Available Minion Personas', ''];
    for (const file of personaFiles) {
      const name = file.name.replace(/\.md$/, '');
      try {
        const content = await adapter.readFile(`/minions/${file.name}`);
        const firstLine = content
          .split('\n')[0]
          .replace(/^#+\s*/, '')
          .trim();
        lines.push(`- **${name}**: ${firstLine}`);
      } catch {
        lines.push(`- **${name}**`);
      }
    }
    lines.push(
      '',
      'Use the `persona` parameter when calling the minion tool to select one.',
      'Omit persona for the default minion (uses configured system prompt).'
    );
    return lines.join('\n');
  } catch {
    return '';
  }
}

/** Build minion tool description, conditionally including web search and retry bullets. */
function getMinionDescription(opts: ToolOptions): string {
  const lines = [
    'Delegate a task to a minion sub-agent. The minion runs independently with its own agentic loop and can use a subset of available tools. Use this to parallelize work or delegate specific tasks.',
    '',
    'The minion will execute the task and return the result. You can optionally:',
    '- Continue a previous minion conversation by providing minionChatId',
  ];

  if (opts.autoRollback === true) {
    lines.push(
      '- If a previous run failed, the minion automatically recovers on next continuation.'
    );
  } else {
    lines.push(
      '- Retry the last run by setting action to "retry" with the same minionChatId. Omit message to re-send the original, or provide a new message to replace it.'
    );
  }

  if (opts.allowWebSearch === true) {
    lines.push('- Enable web search for the minion via enableWeb');
  }

  lines.push(
    '- Specify which tools the minion can use via enabledTools (must be a subset of project tools; defaults to none)',
    '- Provide a displayName to label this minion in the UI',
    '- Inject file context via injectFiles (array of VFS paths). Contents are prepended to the message.',
    '- Provide a verifyHook (name of a /hooks/<name>.js file) to validate minion output before savepoint advances. The hook returns null to approve or a string to reject.'
  );

  if (opts.namespacedMinion && opts.namespacedMinion !== 'off') {
    lines.push(
      '- Select a persona via the persona parameter. Each persona gets its own isolated VFS namespace and system prompt from /minions/<name>.md'
    );

    // Check if models list is configured
    const modelsList = opts.models;
    if (isModelReferenceArray(modelsList) && modelsList.length > 0) {
      lines.push(
        '- Select a model via the model parameter. Available models are listed in the schema enum.'
      );
    }
  }

  if (typeof opts.remoteEndpoint === 'string' && opts.remoteEndpoint) {
    lines.push('- Set remote=true to delegate to a human operator via the remote minion backend');
  }

  if (resolveReturnMode(opts) !== 'no-return') {
    lines.push(
      '',
      "The minion always has access to a 'return' tool to explicitly signal completion with a result."
    );
  }

  return lines.join('\n');
}

/** Build minion input schema, conditionally including enableWeb and action properties. */
function getMinionInputSchema(opts: ToolOptions): ToolInputSchema {
  const properties: Record<string, unknown> = {};

  // Omit action when autoRollback is on — caller doesn't see the retry option
  if (opts.autoRollback !== true) {
    properties.action = {
      type: 'string',
      enum: ['message', 'retry'],
      description:
        'Action to perform. "message" (default) sends a new message. "retry" rolls back the minion chat to the last savepoint and re-executes.',
    };
  }

  properties.minionChatId = {
    type: 'string',
    description: 'Optional: ID of an existing minion chat to continue the conversation',
  };
  properties.message = {
    type: 'string',
    description:
      'The task or message to send to the minion. Required for "message" action. For "retry": omit to re-send the original, or provide a new message to replace it.',
  };
  properties.enabledTools = {
    type: 'array',
    items: { type: 'string' },
    description:
      "Tools to enable for the minion (must be subset of project tools, 'minion' excluded). Defaults to none — specify tools explicitly.",
  };
  properties.displayName = {
    type: 'string',
    description:
      'Display name shown in the UI for this minion call. If omitted, persona name is used.',
  };
  properties.injectFiles = {
    type: 'array',
    items: { type: 'string' },
    description: 'VFS file paths to inject as context. Contents are prepended to the message.',
  };
  properties.verifyHook = {
    type: 'string',
    description:
      'Name of a hook file in /hooks/ (without .js) that verifies minion output before savepoint advances. The hook must return a function(messages). Return null to approve, or a string error message to reject.',
  };

  if (opts.allowWebSearch === true) {
    properties.enableWeb = {
      type: 'boolean',
      description: 'Enable web search for the minion (default: false)',
    };
  }

  if (opts.namespacedMinion && opts.namespacedMinion !== 'off') {
    properties.persona = {
      type: 'string',
      description:
        'Persona name for the minion (matches a file in /minions/). Omit for default persona.',
    };

    // Add model enum when models list is configured
    const modelsList = opts.models;
    if (isModelReferenceArray(modelsList) && modelsList.length > 0) {
      const modelStrings = modelsList.map(formatModelString);
      properties.model = {
        type: 'string',
        enum: modelStrings,
        description: 'Model to use for this minion call. Omit to use the default minion model.',
      };
    }
  }

  if (typeof opts.remoteEndpoint === 'string' && opts.remoteEndpoint) {
    properties.remote = {
      type: 'boolean',
      description: 'Delegate to a remote human operator instead of an LLM sub-agent.',
    };
  }

  return {
    type: 'object',
    properties,
    required: [],
  };
}

/**
 * Minion tool definition.
 *
 * Allows the primary chat LLM to delegate tasks to a sub-agent that runs
 * its own agentic loop with scoped tools.
 */
export const minionTool: ClientSideTool = {
  name: 'minion',
  displayName: 'Minion',
  displaySubtitle: 'Delegate tasks to a sub-agent',
  complex: true,
  parallelThrottleMs: 2000,
  description: getMinionDescription,
  inputSchema: getMinionInputSchema,
  systemPrompt: getMinionSystemPromptInjection,

  iconInput: '🤖',
  iconOutput: '🤖',

  optionDefinitions: [
    {
      type: 'longtext',
      id: 'systemPrompt',
      label: 'Minion System Prompt',
      subtitle: 'Instructions for minion sub-agents',
      default: '',
      placeholder: 'Instructions for minion agents...',
    },
    {
      type: 'model',
      id: 'model',
      label: 'Minion Model',
      subtitle: 'Model for delegated tasks (can use cheaper model)',
    },
    {
      type: 'modellist',
      id: 'models',
      label: 'Available Models',
      subtitle: 'Models the LLM can choose from when calling minions (namespaced mode)',
    },
    {
      type: 'boolean',
      id: 'disableReasoning',
      label: 'Disable Reasoning',
      subtitle: 'Turn off reasoning/thinking for minion calls regardless of project settings',
      default: false,
    },
    {
      type: 'boolean',
      id: 'allowWebSearch',
      label: 'Allow Web Search',
      subtitle: 'Let minions use web search when requested',
      default: false,
    },
    {
      type: 'boolean',
      id: 'autoRollback',
      label: 'Auto Rollback',
      subtitle: 'Automatically roll back previously failed interactions on next continuation',
      default: false,
    },
    {
      type: 'select',
      id: 'namespacedMinion',
      label: 'Namespace',
      subtitle: 'Isolate minion personas into VFS namespaces',
      default: 'off',
      choices: [
        { value: 'off', label: 'Off' },
        { value: 'persona', label: 'Persona' },
        { value: 'all', label: 'All' },
      ],
      migrateFrom: [{ optionId: 'namespacedMinion', whenTrue: 'all' }],
    },
    {
      type: 'select',
      id: 'returnMode',
      label: 'Return Mode',
      subtitle: 'How minion output is captured',
      default: 'both',
      choices: [
        { value: 'no-return', label: 'No Return' },
        { value: 'both', label: 'Both' },
        { value: 'return-only', label: 'Return Only' },
        { value: 'enforced', label: 'Enforced' },
        { value: 'auto-enforced', label: 'Auto Enforced' },
      ],
      migrateFrom: [
        { optionId: 'noReturnTool', whenTrue: 'no-return' },
        { optionId: 'returnOnly', whenTrue: 'return-only' },
      ],
    },
    {
      type: 'text',
      id: 'returnEnforceMessage',
      label: 'Auto-Enforce Reminder',
      subtitle: 'Message sent when auto-enforced mode retries because return was not called',
      default: '',
      placeholder:
        'You have not used the return tool to respond. Please put your response in the return tool call.',
      visibleWhen: { optionId: 'returnMode', value: 'auto-enforced' },
    },
    {
      type: 'select',
      id: 'deferReturn',
      label: 'Deferred Return',
      subtitle: 'How the return tool interacts with the agentic loop',
      default: 'no',
      choices: [
        { value: 'no', label: 'No' },
        { value: 'auto-ack', label: 'Auto Ack' },
        { value: 'free-run', label: 'Free Run' },
      ],
      migrateFrom: [{ optionId: 'deferReturn', whenTrue: 'free-run' }],
      visibleWhen: {
        optionId: 'returnMode',
        value: ['both', 'return-only', 'enforced', 'auto-enforced'],
      },
    },
    {
      type: 'number',
      id: 'deferredSoftStopRounds',
      label: 'Soft Stop Rounds',
      subtitle: 'Rounds after deferred return before injecting stop messages',
      default: 5,
      min: 0,
      visibleWhen: { optionId: 'deferReturn', value: 'free-run' },
    },
    {
      type: 'number',
      id: 'deferredForceStopRounds',
      label: 'Force Stop Rounds',
      subtitle: 'Rounds after deferred return before force-stopping the loop',
      default: 10,
      min: 0,
      visibleWhen: { optionId: 'deferReturn', value: 'free-run' },
    },
    {
      type: 'text',
      id: 'returnAckMessage',
      label: 'Return Accepted',
      subtitle: 'Tool result message sent when return stores a result',
      default: '',
      placeholder: 'Recorded. Stop and user will call you back.',
      visibleWhen: { optionId: 'deferReturn', value: ['auto-ack', 'free-run'] },
    },
    {
      type: 'text',
      id: 'autoAckMessage',
      label: 'Acknowledge Message',
      subtitle: 'Assistant text appended after return to create a clean conversation boundary',
      default: '',
      placeholder: 'Will do.',
      visibleWhen: { optionId: 'deferReturn', value: 'auto-ack' },
    },
    {
      type: 'text',
      id: 'returnDuplicateMessage',
      label: 'Return Already Stored',
      subtitle: 'Error sent when return is called again after a result is stored',
      default: '',
      placeholder:
        'The previous return has been recorded already. Please stop and user will call back.',
      visibleWhen: { optionId: 'deferReturn', value: 'free-run' },
    },
    {
      type: 'select',
      id: 'fileInjectionMode',
      label: 'File Injection Mode',
      subtitle: 'How injected files are sent to the minion LLM',
      default: 'inline',
      choices: [
        { value: 'inline', label: 'Inline' },
        { value: 'separate-block', label: 'Separate Blocks' },
        { value: 'as-file', label: 'Document Blocks' },
      ],
    },
    {
      type: 'text',
      id: 'remoteEndpoint',
      label: 'Remote Minion Endpoint',
      subtitle: 'URL of the Touch Grass backend for human delegation',
      default: '',
      placeholder: 'http://localhost:3004',
    },
    {
      type: 'text',
      id: 'remotePassword',
      label: 'Remote Minion Password',
      subtitle: 'API password for the remote backend',
      default: '',
      placeholder: 'shared-secret',
    },
    {
      type: 'number',
      id: 'remoteTimeoutMs',
      label: 'Remote Timeout (ms)',
      subtitle: 'Total time to wait for a human response before giving up',
      default: 600000,
      min: 10000,
    },
  ],

  execute: executeMinion,
  renderInput: renderMinionInput,
  renderOutput: renderMinionOutput,
};
