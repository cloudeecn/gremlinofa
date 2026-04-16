/**
 * Server-side helpers for building agentic loop options.
 *
 * Extracted from `useChat.ts` so the backend's `ChatRunner` can construct
 * options without depending on React state. PR 9 introduces this module
 * with the option-builder + chat-context loader; PR 10 will switch
 * `useChat.ts` to import from here, deleting the duplicate.
 *
 * The shape of `AgenticLoopOptions` and the construction logic match what
 * the React hook does today. The only differences:
 *
 *   - The signal is a real `AbortSignal` (the React hook used a never-firing
 *     placeholder).
 *   - `loopId` and `parentLoopId` are mandatory inputs — the backend mints
 *     them on every run, and `minionTool` forwards its parent's id.
 */

import type { AgenticLoopOptions } from '../services/agentic/agenticLoopGenerator';
import type { UnifiedStorage } from '../services/storage/unifiedStorage';
import type { APIDefinition, Chat, Model, Project } from '../protocol/types';
import type { BackendDeps } from './backendDeps';
import { ProtocolError } from './GremlinServer';

/**
 * Bundle of records loaded from storage that the agentic loop needs to
 * run. The dispatcher loads these in one shot so `ChatRunner` doesn't
 * touch storage during the loop iteration itself.
 */
export interface ChatLoopContext {
  chat: Chat;
  project: Project;
  apiDef: APIDefinition;
  model: Model;
  modelId: string;
}

/**
 * Resolve a chat into the full set of records needed to run an agentic
 * loop. Throws `ProtocolError` with a stable code on any missing reference
 * so the dispatcher can surface a typed error to the client.
 */
export async function loadChatLoopContext(
  storage: UnifiedStorage,
  chatId: string
): Promise<ChatLoopContext> {
  const chat = await storage.getChat(chatId);
  if (!chat) {
    throw new ProtocolError('CHAT_NOT_FOUND', `chat ${chatId} not found`);
  }

  const project = await storage.getProject(chat.projectId);
  if (!project) {
    throw new ProtocolError(
      'INTERNAL_ERROR',
      `project ${chat.projectId} not found for chat ${chatId}`
    );
  }

  const effectiveApiDefId = chat.apiDefinitionId ?? project.apiDefinitionId;
  if (!effectiveApiDefId) {
    throw new ProtocolError('INVALID_PARAMS', `chat ${chatId} has no apiDefinitionId configured`);
  }
  const apiDef = await storage.getAPIDefinition(effectiveApiDefId);
  if (!apiDef) {
    throw new ProtocolError('INVALID_PARAMS', `API definition ${effectiveApiDefId} not found`);
  }

  const effectiveModelId = chat.modelId ?? project.modelId;
  if (!effectiveModelId) {
    throw new ProtocolError('INVALID_PARAMS', `chat ${chatId} has no modelId configured`);
  }
  const model = await storage.getModel(apiDef.id, effectiveModelId);
  if (!model) {
    throw new ProtocolError(
      'INVALID_PARAMS',
      `model ${effectiveModelId} not found in API definition ${apiDef.id}`
    );
  }

  return { chat, project, apiDef, model, modelId: effectiveModelId };
}

/**
 * Build the `AgenticLoopOptions` for a given chat context. Mirrors
 * `buildAgenticLoopOptions` in `useChat.ts` — kept in sync for one PR
 * cycle until PR 10 deletes the React copy.
 *
 * `deps` is the bundle constructed by `GremlinServer.init()`. Phase 1 of
 * the singleton-encapsulation refactor threads it through here so the
 * userId derivation and tool-prompt resolution use the injected encryption
 * service / tool registry instead of module-level singletons. The returned
 * options carry the same bundle so it reaches `ToolContext` inside the
 * agentic loop.
 */
export async function buildAgenticLoopOptionsForContext(
  deps: BackendDeps,
  ctx: ChatLoopContext,
  signal: AbortSignal,
  loopId: string,
  parentLoopId?: string
): Promise<AgenticLoopOptions> {
  const { chat, project, apiDef, model, modelId } = ctx;
  const enabledTools = project.enabledTools ?? [];
  const toolOptions = project.toolOptions ?? {};

  // Build VFS adapter factory first — needed by system prompt generation.
  // The factory is injected into `deps` by the worker entry; if it's
  // missing, the dispatcher hasn't been bootstrapped correctly.
  if (!deps.createVfsAdapter) {
    throw new ProtocolError(
      'INTERNAL_ERROR',
      'buildAgenticLoopOptionsForContext: createVfsAdapter factory not injected — worker entry must call setBootstrapAdapterFactories'
    );
  }
  const vfsAdapterFactory = deps.createVfsAdapter;
  let userId = '';
  if (project.remoteVfsUrl) {
    userId = await deps.encryption.deriveUserId();
  }
  const createVfsAdapter = (ns?: string) => vfsAdapterFactory(deps, project, userId, ns);

  // Build system prompt context with apiType + factory for tool prompt generation
  const systemPromptContext = {
    projectId: project.id,
    chatId: chat.id,
    apiDefinitionId: apiDef.id,
    modelId,
    apiType: apiDef.apiType,
    createVfsAdapter,
  };

  const toolSystemPrompts = await deps.toolRegistry.getSystemPrompts(
    apiDef.apiType,
    enabledTools,
    systemPromptContext,
    toolOptions
  );
  const combinedSystemPrompt = [project.systemPrompt, ...toolSystemPrompts]
    .filter(Boolean)
    .join('\n\n');

  return {
    apiDef,
    model,
    projectId: project.id,
    chatId: chat.id,
    temperature: project.temperature ?? undefined,
    maxTokens: project.maxOutputTokens,
    systemPrompt: combinedSystemPrompt || undefined,
    preFillResponse: project.preFillResponse,
    webSearchEnabled: project.webSearchEnabled,
    enabledTools,
    toolOptions,
    disableStream: project.disableStream ?? false,
    extendedContext: project.extendedContext ?? false,
    noLineNumbers: project.noLineNumbers,
    createVfsAdapter,
    enableReasoning: project.enableReasoning,
    reasoningBudgetTokens: project.reasoningBudgetTokens,
    thinkingKeepTurns: project.thinkingKeepTurns,
    reasoningEffort: project.reasoningEffort,
    reasoningSummary: project.reasoningSummary,
    checkpointMessageIds: enabledTools.includes('checkpoint')
      ? (chat.checkpointMessageIds ??
        (chat.checkpointMessageId ? [chat.checkpointMessageId] : undefined))
      : undefined,
    activeHook: chat.activeHook,
    signal,
    loopId,
    parentLoopId,
    deps,
  };
}
