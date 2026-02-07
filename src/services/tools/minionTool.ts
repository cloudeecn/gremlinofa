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
  RenderingBlockGroup,
  ToolContext,
  ToolInputSchema,
  ToolOptions,
  ToolResult,
  ToolResultBlock,
  ToolStreamEvent,
} from '../../types';
import type { ToolInfoRenderBlock, ToolResultRenderBlock } from '../../types/content';
import { isModelReference } from '../../types';
import { generateUniqueId } from '../../utils/idGenerator';
import { storage } from '../storage';
import {
  runAgenticLoop,
  createTokenTotals,
  addTokens,
  createToolResultRenderBlock,
  type AgenticLoopOptions,
  type AgenticLoopEvent,
} from '../agentic/agenticLoopGenerator';
import { toolRegistry } from './clientSideTools';
import { apiService } from '../api/apiService';

// Tool names that minions cannot use
const MINION_EXCLUDED_TOOLS = ['minion'];

// Maximum iterations for minion agentic loop (same as main loop)
const MAX_ITERATIONS = 50;

/** Input parameters for minion tool */
interface MinionInput {
  /** Optional: existing minion chat ID to continue a conversation */
  minionChatId?: string;
  /** Task/message to send to the minion */
  message: string;
  /** Enable web search for the minion */
  enableWeb?: boolean;
  /** Scoped tools for the minion (intersected with project tools) */
  enabledTools?: string[];
}

/**
 * Build effective tool list for minion.
 * Formula: (requestedTools ∩ projectTools) - minion + return
 *
 * @param requestedTools - Tools requested by the caller
 * @param projectTools - Tools enabled for the project
 * @returns Final list of tools available to the minion
 */
function buildMinionTools(requestedTools: string[] | undefined, projectTools: string[]): string[] {
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

  // Add return tool (always available to minions)
  if (!tools.includes('return')) {
    tools.push('return');
  }

  return tools;
}

/**
 * Build the ToolInfoRenderBlock group for a minion execution.
 * Placed at the start of renderingGroups to show task description and chat reference.
 */
function buildInfoGroup(taskMessage: string, chatId: string): RenderingBlockGroup {
  const infoBlock: ToolInfoRenderBlock = {
    type: 'tool_info',
    input: taskMessage,
    chatId,
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

  // Validate context
  if (!context?.projectId) {
    return {
      content: 'Error: projectId is required in context',
      isError: true,
    };
  }

  // Check web search permission
  const allowWebSearch = toolOptions?.allowWebSearch === true;
  if (minionInput.enableWeb && !allowWebSearch) {
    return {
      content:
        'Error: Web search is not allowed for minions. Enable "Allow Web Search" in minion tool options.',
      isError: true,
    };
  }

  // Get minion model configuration from toolOptions
  const minionToolOptions = toolOptions ?? {};
  const modelRef = minionToolOptions.model;

  if (!modelRef || !isModelReference(modelRef)) {
    return {
      content: 'Error: Minion model not configured. Please configure a model in project settings.',
      isError: true,
    };
  }

  // Load project for tool configuration
  const project = await storage.getProject(context.projectId);
  if (!project) {
    return {
      content: `Error: Project not found: ${context.projectId}`,
      isError: true,
    };
  }

  // Load API definition
  const apiDef = await storage.getAPIDefinition(modelRef.apiDefinitionId);
  if (!apiDef) {
    return {
      content: `Error: API definition not found: ${modelRef.apiDefinitionId}`,
      isError: true,
    };
  }

  // Load model
  const model = await storage.getModel(modelRef.apiDefinitionId, modelRef.modelId);
  if (!model) {
    return {
      content: `Error: Model not found: ${modelRef.modelId}`,
      isError: true,
    };
  }

  // Build minion tools (scoped from project tools)
  const projectTools = project.enabledTools ?? [];

  // Validate requested tools exist in project
  if (minionInput.enabledTools && minionInput.enabledTools.length > 0) {
    const projectToolSet = new Set(projectTools);
    const invalidTools = minionInput.enabledTools.filter(
      t => t !== 'return' && !projectToolSet.has(t)
    );
    if (invalidTools.length > 0) {
      return {
        content: `Error: Tools not available in project: ${invalidTools.join(', ')}. Available tools: ${projectTools.join(', ') || '(none)'}`,
        isError: true,
      };
    }
  }

  const minionTools = buildMinionTools(minionInput.enabledTools, projectTools);

  // Create or load minion chat
  let minionChat: MinionChat;
  let existingMessages: Message<unknown>[] = [];
  let pendingReturnToolUse: { id: string; name: string } | undefined;

  if (minionInput.minionChatId) {
    // Continue existing minion chat
    const existing = await storage.getMinionChat(minionInput.minionChatId);
    if (!existing) {
      return {
        content: `Error: Minion chat not found: ${minionInput.minionChatId}`,
        isError: true,
      };
    }
    minionChat = existing;
    existingMessages = await storage.getMinionMessages(minionInput.minionChatId);

    // Check if last message is assistant with pending return tool
    if (existingMessages.length > 0) {
      const lastMsg = existingMessages[existingMessages.length - 1];
      if (lastMsg.role === 'assistant' && lastMsg.content.fullContent) {
        const toolUseBlocks = apiService.extractToolUseBlocks(
          apiDef.apiType,
          lastMsg.content.fullContent
        );
        const returnToolUse = toolUseBlocks.find(t => t.name === 'return');
        if (returnToolUse) {
          pendingReturnToolUse = { id: returnToolUse.id, name: returnToolUse.name };
        }
      }
    }

    // Set checkpoint to last message ID before this minion run
    minionChat.checkpoint =
      existingMessages.length > 0 ? existingMessages[existingMessages.length - 1].id : undefined;
    await storage.saveMinionChat(minionChat);
  } else {
    // Create new minion chat (no checkpoint - first run)
    const parentChatId = context.chatId ?? 'standalone';
    minionChat = {
      id: generateUniqueId('minion'),
      parentChatId,
      projectId: context.projectId,
      createdAt: new Date(),
      lastModifiedAt: new Date(),
    };
    await storage.saveMinionChat(minionChat);
  }

  // Build info group for streaming display
  const infoGroup = buildInfoGroup(minionInput.message, minionChat.id);

  // Build context for minion based on whether we're resuming after a return tool
  let minionContext: Message<unknown>[];

  if (pendingReturnToolUse) {
    // Resume after return tool: send tool_result instead of user message
    const toolResultBlock: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: pendingReturnToolUse.id,
      content: minionInput.message,
    };

    const toolResultRenderBlock: ToolResultRenderBlock = createToolResultRenderBlock(
      pendingReturnToolUse.id,
      pendingReturnToolUse.name,
      minionInput.message,
      false
    );

    const toolResultMessage = apiService.buildToolResultMessage(apiDef.apiType, [toolResultBlock]);
    toolResultMessage.content.renderingContent = [
      { category: 'backstage' as const, blocks: [toolResultRenderBlock] },
    ];

    // Save tool result message to minion chat
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

  // Get minion system prompt from toolOptions
  const minionSystemPrompt =
    typeof minionToolOptions.systemPrompt === 'string' ? minionToolOptions.systemPrompt : '';

  // Build system prompts from enabled tools
  const systemPromptContext = {
    projectId: context.projectId,
    chatId: minionChat.id,
    apiDefinitionId: apiDef.id,
    modelId: model.id,
    apiType: apiDef.apiType,
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
    // Reasoning settings from project
    enableReasoning: project.enableReasoning,
    reasoningBudgetTokens: project.reasoningBudgetTokens,
    thinkingKeepTurns: project.thinkingKeepTurns,
    reasoningEffort: project.reasoningEffort,
    reasoningSummary: project.reasoningSummary,
  };

  // Run agentic loop with streaming
  const totals = createTokenTotals();
  // Accumulated finalized blocks from all minion messages (marked as tool-generated)
  const accumulatedGroups: RenderingBlockGroup[] = [];
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
      };
    } else if (finalResult.status === 'max_iterations') {
      return {
        content: `Minion reached maximum iterations (${MAX_ITERATIONS})`,
        isError: true,
        renderingGroups: [infoGroup, ...accumulatedGroups],
      };
    }

    // Extract text response from last assistant message
    let textResponse = '';
    if (finalResult.messages.length > 0) {
      const lastMsg = finalResult.messages[finalResult.messages.length - 1];
      if (lastMsg.role === 'assistant') {
        textResponse = lastMsg.content.content ?? '';
      }
    }

    // Build final response
    const finalResponse = usedReturnTool && returnValue !== undefined ? returnValue : textResponse;

    // Return result with renderingGroups for nested display
    return {
      content: JSON.stringify({
        result: finalResponse,
        minionChatId: minionChat.id,
      }),
      renderingGroups: [infoGroup, ...accumulatedGroups],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: `Minion execution failed: ${message}`,
      isError: true,
      renderingGroups: [infoGroup, ...accumulatedGroups],
    };
  }
}

/**
 * Render minion tool input for display
 */
function renderMinionInput(input: Record<string, unknown>): string {
  const minionInput = input as unknown as MinionInput;
  const lines: string[] = [];

  if (minionInput.minionChatId) {
    lines.push(`Continue: ${minionInput.minionChatId}`);
  }

  if (minionInput.enabledTools?.length) {
    lines.push(`Tools: ${minionInput.enabledTools.join(', ')}`);
  }

  if (minionInput.enableWeb) {
    lines.push('Web: enabled');
  }

  lines.push('');
  lines.push(minionInput.message);

  return lines.join('\n');
}

/**
 * Render minion tool output for display
 */
function renderMinionOutput(output: string, isError?: boolean): string {
  if (isError) {
    return output;
  }

  // Output is JSON with { result, minionChatId }
  try {
    const parsed = JSON.parse(output);
    const result = parsed.result ?? output;
    const chatId = parsed.minionChatId;

    // Format for display
    let display = result;
    if (display.length > 500) {
      display = display.slice(0, 500) + '...';
    }
    if (chatId) {
      display += `\n\n[minionChatId: ${chatId}]`;
    }
    return display;
  } catch {
    // Fallback for non-JSON output (backward compat)
    if (output.length > 500) {
      return output.slice(0, 500) + '...';
    }
    return output;
  }
}

/** Build minion tool description, conditionally including web search bullet. */
function getMinionDescription(opts: ToolOptions): string {
  const lines = [
    'Delegate a task to a minion sub-agent. The minion runs independently with its own agentic loop and can use a subset of available tools. Use this to parallelize work or delegate specific tasks.',
    '',
    'The minion will execute the task and return the result. You can optionally:',
    '- Continue a previous minion conversation by providing minionChatId',
  ];

  if (opts.allowWebSearch === true) {
    lines.push('- Enable web search for the minion via enableWeb');
  }

  lines.push(
    '- Specify which tools the minion can use via enabledTools (must be a subset of project tools; defaults to none)',
    '',
    "The minion always has access to a 'return' tool to explicitly signal completion with a result."
  );

  return lines.join('\n');
}

/** Build minion input schema, conditionally including enableWeb property. */
function getMinionInputSchema(opts: ToolOptions): ToolInputSchema {
  const properties: Record<string, unknown> = {
    minionChatId: {
      type: 'string',
      description: 'Optional: ID of an existing minion chat to continue the conversation',
    },
    message: {
      type: 'string',
      description: 'The task or message to send to the minion',
    },
    enabledTools: {
      type: 'array',
      items: { type: 'string' },
      description:
        "Tools to enable for the minion (must be subset of project tools, 'minion' excluded). Defaults to none — specify tools explicitly.",
    },
  };

  if (opts.allowWebSearch === true) {
    properties.enableWeb = {
      type: 'boolean',
      description: 'Enable web search for the minion (default: false)',
    };
  }

  return {
    type: 'object',
    properties,
    required: ['message'],
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
      type: 'boolean',
      id: 'allowWebSearch',
      label: 'Allow Web Search',
      subtitle: 'Let minions use web search when requested',
      default: false,
    },
  ],

  execute: executeMinion,
  renderInput: renderMinionInput,
  renderOutput: renderMinionOutput,
};
