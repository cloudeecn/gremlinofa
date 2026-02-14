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
} from '../../types';
import type { ToolInfoRenderBlock, ToolResultRenderBlock } from '../../types/content';
import { isModelReference, isModelReferenceArray } from '../../types';
import { generateUniqueId } from '../../utils/idGenerator';
import { storage } from '../storage';
import {
  runAgenticLoop,
  createToolResultRenderBlock,
  type AgenticLoopOptions,
  type AgenticLoopEvent,
} from '../agentic/agenticLoopGenerator';
import { createTokenTotals, addTokens } from '../../utils/tokenTotals';
import { toolRegistry } from './clientSideTools';
import { apiService } from '../api/apiService';
import * as vfs from '../vfs/vfsService';

// Tool names that minions cannot use
const MINION_EXCLUDED_TOOLS = ['minion'];

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

/** Stashed fullContent from a rolled-back message for re-use during retry */
interface StashedRetryContent {
  modelFamily?: string;
  fullContent: unknown;
  renderingContent?: RenderingBlockGroup[];
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

// Sentinel checkpoint value meaning "before any messages" (enables first-run retry)
export const CHECKPOINT_START = '_start';

/** Input parameters for minion tool */
interface MinionInput {
  /** Action: 'message' (default) sends a new message, 'retry' rolls back to checkpoint and re-executes */
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
  modelId?: string
): RenderingBlockGroup {
  const infoBlock: ToolInfoRenderBlock = {
    type: 'tool_info',
    input: taskMessage,
    chatId,
    persona,
    displayName,
    apiDefinitionId,
    modelId,
  };
  return { category: 'backstage', blocks: [infoBlock] };
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

  // ── Phase 1: Validate inputs + load/create chat + checkpoint ──
  // Errors here indicate no state change; caller can resend to reattempt.

  if (action === 'message' && !minionInput.message) {
    return {
      content:
        'Error: "message" is required when action is "message" (or omitted). Resend to reattempt.',
      isError: true,
    };
  }
  if (action === 'retry' && !minionInput.minionChatId) {
    return {
      content: 'Error: "minionChatId" is required when action is "retry". Resend to reattempt.',
      isError: true,
    };
  }

  if (!context?.projectId) {
    return {
      content: 'Error: projectId is required in context. Resend to reattempt.',
      isError: true,
    };
  }

  // Load or create minion chat + handle retry rollback + save checkpoint
  let minionChat: MinionChat;
  let existingMessages: Message<unknown>[] = [];

  if (minionInput.minionChatId) {
    const existing = await storage.getMinionChat(minionInput.minionChatId);
    if (!existing) {
      return {
        content: `Error: Minion chat not found: ${minionInput.minionChatId}. Resend to reattempt.`,
        isError: true,
      };
    }
    minionChat = existing;
    existingMessages = await storage.getMinionMessages(minionInput.minionChatId);

    // Merge caller-provided settings into existing chat
    if (minionInput.displayName !== undefined) minionChat.displayName = minionInput.displayName;
    if (minionInput.persona !== undefined) minionChat.persona = minionInput.persona;

    if (action === 'retry') {
      // Retry: roll back to checkpoint before proceeding
      if (minionChat.checkpoint === undefined) {
        return {
          content: 'Error: Cannot retry — no checkpoint on this minion chat. Resend to reattempt.',
          isError: true,
        };
      }

      let rolledBack: Message<unknown>[];

      if (minionChat.checkpoint === CHECKPOINT_START) {
        // First-run retry: roll back all messages
        rolledBack = existingMessages;
      } else {
        const checkpointIdx = existingMessages.findIndex(m => m.id === minionChat.checkpoint);
        if (checkpointIdx === -1) {
          return {
            content: `Error: Checkpoint message ${minionChat.checkpoint} not found in chat history. Resend to reattempt.`,
            isError: true,
          };
        }
        rolledBack = existingMessages.slice(checkpointIdx + 1);
      }

      if (rolledBack.length === 0) {
        return {
          content: 'Error: No messages after checkpoint to retry. Resend to reattempt.',
          isError: true,
        };
      }

      // Stash fullContent from the first rolled-back message for potential re-use in Phase 3.
      // Tool_result messages (from buildToolResultMessage) have content.content = '' and the
      // actual payload in fullContent — stashing lets us re-use it when API types match.
      if (rolledBack[0].content.fullContent) {
        stashedRetryContent = {
          modelFamily: rolledBack[0].content.modelFamily as string | undefined,
          fullContent: rolledBack[0].content.fullContent,
          renderingContent: rolledBack[0].content.renderingContent as
            | RenderingBlockGroup[]
            | undefined,
        };
      }

      // Recover original message when caller didn't provide one
      if (!minionInput.message) {
        const firstAfter = rolledBack[0];
        const textContent = firstAfter.content.content as string;
        if (textContent) {
          minionInput.message = textContent;
        } else {
          // Tool_result messages have empty content.content — extract from fullContent
          minionInput.message = extractToolResultText(firstAfter.content.fullContent) ?? '';
        }
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

      // Delete rolled-back messages
      if (minionChat.checkpoint === CHECKPOINT_START) {
        await storage.deleteMessageAndAfter(minionChat.id, rolledBack[0].id);
      } else {
        await storage.deleteMessagesAfter(minionChat.id, minionChat.checkpoint!);
      }
      existingMessages = await storage.getMinionMessages(minionChat.id);

      // Checkpoint stays unchanged — it already points to the right position
      await storage.saveMinionChat(minionChat);
    } else {
      // Normal continuation: advance checkpoint to last message before this run
      minionChat.checkpoint =
        existingMessages.length > 0
          ? existingMessages[existingMessages.length - 1].id
          : CHECKPOINT_START;
      await storage.saveMinionChat(minionChat);
    }
  } else {
    // Create new minion chat with initial checkpoint
    const parentChatId = context.chatId ?? 'standalone';
    minionChat = {
      id: generateUniqueId('minion'),
      parentChatId,
      projectId: context.projectId,
      checkpoint: CHECKPOINT_START,
      displayName: minionInput.displayName,
      persona: minionInput.persona,
      createdAt: new Date(),
      lastModifiedAt: new Date(),
    };
    await storage.saveMinionChat(minionChat);
  }

  // ── Phase 2: Validation + setup ──
  // Checkpoint is saved. Errors here mean caller should resend with the message.

  const allowWebSearch = toolOptions?.allowWebSearch === true;
  if (minionInput.enableWeb && !allowWebSearch) {
    return {
      content:
        'Error: Web search is not allowed for minions. Enable "Allow Web Search" in minion tool options. Resend with the message to reattempt.',
      isError: true,
    };
  }

  const minionToolOptions = toolOptions ?? {};

  // Resolve effective model: input.model (from LLM) > toolOptions.model (default)
  let effectiveModelRef: ModelReference | undefined;

  if (minionInput.model) {
    // LLM specified a model — validate against configured models list
    const modelsList = minionToolOptions.models;
    if (!isModelReferenceArray(modelsList) || modelsList.length === 0) {
      return {
        content:
          'Error: model parameter provided but no models list configured. Resend with the message to reattempt.',
        isError: true,
      };
    }

    const parsed = parseModelString(minionInput.model);
    if (!parsed) {
      return {
        content: `Error: Invalid model format: "${minionInput.model}". Expected "apiDefinitionId:modelId". Resend with the message to reattempt.`,
        isError: true,
      };
    }

    const isInList = modelsList.some(
      ref => ref.apiDefinitionId === parsed.apiDefinitionId && ref.modelId === parsed.modelId
    );
    if (!isInList) {
      const available = modelsList.map(formatModelString).join(', ');
      return {
        content: `Error: Model "${minionInput.model}" is not in the configured models list. Available: ${available}. Resend with the message to reattempt.`,
        isError: true,
      };
    }

    effectiveModelRef = parsed;
  } else {
    // Fall back to default model option
    const defaultRef = minionToolOptions.model;
    if (defaultRef && isModelReference(defaultRef)) {
      effectiveModelRef = defaultRef;
    }
  }

  // Fall back to model stored from previous minion run
  if (!effectiveModelRef && minionChat.apiDefinitionId && minionChat.modelId) {
    effectiveModelRef = {
      apiDefinitionId: minionChat.apiDefinitionId,
      modelId: minionChat.modelId,
    };
  }

  if (!effectiveModelRef) {
    return {
      content:
        'Error: Minion model not configured. Please configure a model in project settings. Resend with the message to reattempt.',
      isError: true,
    };
  }

  const project = await storage.getProject(context.projectId);
  if (!project) {
    return {
      content: `Error: Project not found: ${context.projectId}. Resend with the message to reattempt.`,
      isError: true,
    };
  }

  const apiDef = await storage.getAPIDefinition(effectiveModelRef.apiDefinitionId);
  if (!apiDef) {
    return {
      content: `Error: API definition not found: ${effectiveModelRef.apiDefinitionId}. Resend with the message to reattempt.`,
      isError: true,
    };
  }

  const model = await storage.getModel(
    effectiveModelRef.apiDefinitionId,
    effectiveModelRef.modelId
  );
  if (!model) {
    return {
      content: `Error: Model not found: ${effectiveModelRef.modelId}. Resend with the message to reattempt.`,
      isError: true,
    };
  }

  const projectTools = project.enabledTools ?? [];

  if (minionInput.enabledTools && minionInput.enabledTools.length > 0) {
    const projectToolSet = new Set(projectTools);
    const invalidTools = minionInput.enabledTools.filter(
      t => t !== 'return' && !projectToolSet.has(t)
    );
    if (invalidTools.length > 0) {
      return {
        content: `Error: Tools not available in project: ${invalidTools.join(', ')}. Available tools: ${projectTools.join(', ') || '(none)'}. Resend with the message to reattempt.`,
        isError: true,
      };
    }
  }

  const includeReturn = minionToolOptions.noReturnTool !== true;
  const disableReasoning = minionToolOptions.disableReasoning === true;
  const minionTools = buildMinionTools(minionInput.enabledTools, projectTools, includeReturn);

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

  // Build info group for streaming display (include persona name for non-default personas)
  const personaLabel =
    minionInput.displayName ??
    (minionToolOptions.namespacedMinion === true &&
    minionInput.persona &&
    minionInput.persona !== 'default'
      ? minionInput.persona
      : undefined);
  const infoGroup = buildInfoGroup(
    minionInput.message,
    minionChat.id,
    personaLabel,
    minionInput.displayName,
    effectiveModelRef.apiDefinitionId,
    effectiveModelRef.modelId
  );

  // Persist resolved model into minionChat for future continuation
  minionChat.apiDefinitionId = effectiveModelRef.apiDefinitionId;
  minionChat.modelId = effectiveModelRef.modelId;

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
        content: errContent,
        is_error: true,
      });
      toolResultRenderBlocks.push(
        createToolResultRenderBlock(skipped.id, skipped.name, errContent, true)
      );
    }

    // Return tool result: user's continuation message
    toolResultBlocks.push({
      type: 'tool_result',
      tool_use_id: pendingReturnToolUse.id,
      content: minionInput.message,
    });
    toolResultRenderBlocks.push(
      createToolResultRenderBlock(
        pendingReturnToolUse.id,
        pendingReturnToolUse.name,
        minionInput.message,
        false
      )
    );

    const toolResultMessage = apiService.buildToolResultMessage(apiDef.apiType, toolResultBlocks);
    toolResultMessage.content.renderingContent = [
      { category: 'backstage' as const, blocks: toolResultRenderBlocks },
    ];

    await storage.saveMinionMessage(minionChat.id, toolResultMessage);

    minionContext = [...existingMessages, toolResultMessage];
  } else {
    // Normal case: build user message for minion
    const userMessage: Message<string> = {
      id: generateUniqueId('msg_user'),
      role: 'user',
      content: {
        type: 'text',
        content: minionInput.message,
        renderingContent: [
          { category: 'text', blocks: [{ type: 'text', text: minionInput.message }] },
        ],
      },
      timestamp: new Date(),
    };

    // Save user message to minion chat
    await storage.saveMinionMessage(minionChat.id, userMessage);

    minionContext = [...existingMessages, userMessage];
  }

  // Resolve persona and namespace when namespacedMinion is enabled
  const namespacedMinion = minionToolOptions.namespacedMinion === true;
  let minionNamespace: string | undefined;
  let minionSystemPrompt: string;

  if (namespacedMinion) {
    const persona = minionInput.persona ?? minionChat.persona ?? 'default';
    minionNamespace = `/minions/${persona}`;

    // Read global prompt shared across all personas
    let globalPrompt = '';
    try {
      globalPrompt = await vfs.readFile(context.projectId, '/minions/_global.md');
    } catch {
      // No global prompt — that's fine
    }

    if (persona !== 'default') {
      // Read persona prompt from /minions/<persona>.md (root VFS, no namespace)
      try {
        const personaPrompt = await vfs.readFile(context.projectId, `/minions/${persona}.md`);
        minionSystemPrompt = [globalPrompt, personaPrompt].filter(Boolean).join('\n\n');
      } catch {
        return {
          content: `Error: Persona file /minions/${persona}.md not found. Create the file or use a different persona. Resend with the message to reattempt.`,
          isError: true,
        };
      }
    } else {
      // Default persona uses configured system prompt
      const configuredPrompt =
        typeof minionToolOptions.systemPrompt === 'string' ? minionToolOptions.systemPrompt : '';
      minionSystemPrompt = [globalPrompt, configuredPrompt].filter(Boolean).join('\n\n');
    }
  } else {
    minionSystemPrompt =
      typeof minionToolOptions.systemPrompt === 'string' ? minionToolOptions.systemPrompt : '';
  }

  // Build system prompts from enabled tools
  const systemPromptContext = {
    projectId: context.projectId,
    chatId: minionChat.id,
    apiDefinitionId: apiDef.id,
    modelId: model.id,
    apiType: apiDef.apiType,
    namespace: minionNamespace,
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

  // Build agentic loop options for minion
  const loopOptions: AgenticLoopOptions = {
    apiDef,
    model,
    projectId: context.projectId,
    chatId: minionChat.id,
    temperature: project.temperature ?? undefined,
    maxTokens: project.maxOutputTokens,
    systemPrompt: combinedSystemPrompt || undefined,
    preFillResponse: undefined, // Minions don't use prefill
    webSearchEnabled: allowWebSearch && (minionInput.enableWeb ?? false),
    enabledTools: minionTools,
    toolOptions: project.toolOptions ?? {},
    disableStream: project.disableStream ?? false,
    namespace: minionNamespace,
    // Reasoning settings from project
    enableReasoning: disableReasoning ? false : project.enableReasoning,
    reasoningBudgetTokens: project.reasoningBudgetTokens,
    thinkingKeepTurns: project.thinkingKeepTurns,
    reasoningEffort: project.reasoningEffort,
    reasoningSummary: project.reasoningSummary,
  };

  // Run agentic loop with streaming
  const totals = createTokenTotals();
  // Accumulated finalized blocks from all minion messages (marked as tool-generated)
  const accumulatedGroups: RenderingBlockGroup[] = [];
  // Text content from all assistant messages in this turn
  const accumulatedText: string[] = [];
  let usedReturnTool = false;
  let returnValue: string | undefined;

  try {
    const gen = runAgenticLoop(loopOptions, minionContext);

    // Consume generator, handling events
    let iterResult: IteratorResult<
      AgenticLoopEvent,
      Awaited<ReturnType<typeof runAgenticLoop>> extends AsyncGenerator<infer _E, infer R, infer _N>
        ? R
        : never
    >;

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
            break;
        }
      }
    } while (!iterResult.done);

    // Handle final result
    const finalResult = iterResult.value;

    // Update minion chat with totals
    const updatedMinionChat: MinionChat = {
      ...minionChat,
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

    // Determine response based on final status
    if (finalResult.status === 'complete' && finalResult.returnValue !== undefined) {
      usedReturnTool = true;
      returnValue = finalResult.returnValue;
    } else if (finalResult.status === 'error') {
      return {
        content: `Minion error: ${finalResult.error.message}`,
        isError: true,
        renderingGroups: [infoGroup, ...accumulatedGroups],
        tokenTotals: totals,
      };
    } else if (finalResult.status === 'max_iterations') {
      return {
        content: `Minion reached maximum iterations (${MAX_ITERATIONS})`,
        isError: true,
        renderingGroups: [infoGroup, ...accumulatedGroups],
        tokenTotals: totals,
      };
    }

    // Determine stop reason from last assistant message
    let stopReason = 'end_turn';
    if (finalResult.messages.length > 0) {
      const lastMsg = finalResult.messages[finalResult.messages.length - 1];
      if (lastMsg.role === 'assistant') {
        stopReason = (lastMsg.content.stopReason as string) ?? 'end_turn';
      }
    }
    // Map tool_use → end_turn when return tool triggered completion
    if (usedReturnTool && stopReason === 'tool_use') {
      stopReason = 'end_turn';
    }

    // Build result JSON: `result` only present when return tool was used
    const joinedText = accumulatedText.join('\n\n');
    const returnOnly = minionToolOptions.returnOnly === true;
    const suppressText = returnOnly && usedReturnTool && returnValue !== undefined && joinedText;

    const resultJson: Record<string, unknown> = {
      text: suppressText ? '' : joinedText,
      stopReason,
      minionChatId: minionChat.id,
    };
    if (usedReturnTool && returnValue !== undefined) {
      resultJson.result = returnValue;
    }

    return {
      content: JSON.stringify(resultJson),
      renderingGroups: [infoGroup, ...accumulatedGroups],
      tokenTotals: totals,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: `Minion execution failed: ${message}`,
      isError: true,
      renderingGroups: [infoGroup, ...accumulatedGroups],
      tokenTotals: totals,
    };
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

  if (minionInput.message) {
    lines.push('');
    lines.push(minionInput.message);
  }

  return lines.join('\n');
}

/**
 * Render minion tool output for display
 */
function renderMinionOutput(output: string, isError?: boolean): string {
  if (isError) {
    return output;
  }

  try {
    const parsed = JSON.parse(output);
    const lines: string[] = [];

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
  if (opts.namespacedMinion !== true) return '';

  try {
    const dirExists = await vfs.isDirectory(context.projectId, '/minions');
    if (!dirExists) return '';

    const entries = await vfs.readDir(context.projectId, '/minions');
    const personaFiles = entries
      .filter(e => e.type === 'file' && e.name.endsWith('.md'))
      .sort((a, b) => a.name.localeCompare(b.name));

    if (personaFiles.length === 0) return '';

    const lines = ['## Available Minion Personas', ''];
    for (const file of personaFiles) {
      const name = file.name.replace(/\.md$/, '');
      try {
        const content = await vfs.readFile(context.projectId, `/minions/${file.name}`);
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

/** Build minion tool description, conditionally including web search bullet. */
function getMinionDescription(opts: ToolOptions): string {
  const lines = [
    'Delegate a task to a minion sub-agent. The minion runs independently with its own agentic loop and can use a subset of available tools. Use this to parallelize work or delegate specific tasks.',
    '',
    'The minion will execute the task and return the result. You can optionally:',
    '- Continue a previous minion conversation by providing minionChatId',
    '- Retry the last run by setting action to "retry" with the same minionChatId. Omit message to re-send the original, or provide a new message to replace it.',
  ];

  if (opts.allowWebSearch === true) {
    lines.push('- Enable web search for the minion via enableWeb');
  }

  lines.push(
    '- Specify which tools the minion can use via enabledTools (must be a subset of project tools; defaults to none)',
    '- Provide a displayName to label this minion in the UI'
  );

  if (opts.namespacedMinion === true) {
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

  if (opts.noReturnTool !== true) {
    lines.push(
      '',
      "The minion always has access to a 'return' tool to explicitly signal completion with a result."
    );
  }

  return lines.join('\n');
}

/** Build minion input schema, conditionally including enableWeb property. */
function getMinionInputSchema(opts: ToolOptions): ToolInputSchema {
  const properties: Record<string, unknown> = {
    action: {
      type: 'string',
      enum: ['message', 'retry'],
      description:
        'Action to perform. "message" (default) sends a new message. "retry" rolls back the minion chat to the last checkpoint and re-executes.',
    },
    minionChatId: {
      type: 'string',
      description: 'Optional: ID of an existing minion chat to continue the conversation',
    },
    message: {
      type: 'string',
      description:
        'The task or message to send to the minion. Required for "message" action. For "retry": omit to re-send the original, or provide a new message to replace it.',
    },
    enabledTools: {
      type: 'array',
      items: { type: 'string' },
      description:
        "Tools to enable for the minion (must be subset of project tools, 'minion' excluded). Defaults to none — specify tools explicitly.",
    },
    displayName: {
      type: 'string',
      description:
        'Display name shown in the UI for this minion call. If omitted, persona name is used.',
    },
  };

  if (opts.allowWebSearch === true) {
    properties.enableWeb = {
      type: 'boolean',
      description: 'Enable web search for the minion (default: false)',
    };
  }

  if (opts.namespacedMinion === true) {
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
      id: 'allowWebSearch',
      label: 'Allow Web Search',
      subtitle: 'Let minions use web search when requested',
      default: false,
    },
    {
      type: 'boolean',
      id: 'returnOnly',
      label: 'Return Only',
      subtitle: 'Suppress accumulated text when return tool provides a result',
      default: false,
    },
    {
      type: 'boolean',
      id: 'noReturnTool',
      label: 'No Return Tool',
      subtitle: 'Remove the return tool from minion toolset',
      default: false,
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
      id: 'namespacedMinion',
      label: 'Namespaced Minion',
      subtitle: 'Isolate each persona into its own VFS namespace',
      default: false,
    },
  ],

  execute: executeMinion,
  renderInput: renderMinionInput,
  renderOutput: renderMinionOutput,
};
