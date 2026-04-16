/**
 * Per-loop wrapper around `runAgenticLoop`.
 *
 * One `ChatRunner` instance is constructed per `runLoop` RPC. The runner:
 *
 *   1. Loads the chat context (chat / project / apiDef / model) via
 *      `loadChatLoopContext`.
 *   2. Verifies the chat is not locked by an incomplete tail.
 *   3. Mints a `loopId` and registers itself with `LoopRegistry`.
 *   4. Builds `AgenticLoopOptions` and runs `runAgenticLoop`.
 *   5. Adapts the loop's `AgenticLoopEvent`s into the protocol's
 *      `LoopEvent` shape, persisting messages on `message_created` and
 *      updating chat totals on `tokens_consumed`.
 *   6. On terminal status (complete / error / aborted / soft_stopped /
 *      max_iterations), removes itself from `LoopRegistry`.
 *
 * The runner does **not** own the AbortController — the dispatcher in
 * `GremlinServer` creates it, registers it with `LoopRegistry`, and passes
 * the signal in via `options.signal`. That keeps `abortLoop` working
 * uniformly: any client can call it and the registry fires the controller
 * regardless of which `ChatRunner` instance is currently iterating.
 */

import {
  addTokens,
  createTokenTotals,
  type AgenticLoopEvent,
  type AgenticLoopResult,
  runAgenticLoop,
} from '../services/agentic/agenticLoopGenerator';
import {
  assertChatNotLockedByIncompleteTail,
  isChatLockedByIncompleteTail,
} from './lib/incompleteTail';
import { generateUniqueId } from '../protocol/idGenerator';
import { generateMessageWithMetadata } from './messageMetadata';
import type { BackendDeps } from './backendDeps';
import {
  buildAgenticLoopOptionsForContext,
  loadChatLoopContext,
  type ChatLoopContext,
} from './buildLoopOptions';
import { ProtocolError } from './GremlinServer';
import { LoopRegistry } from './LoopRegistry';
import { prepareMessageForWire } from './messageWire';
import type { ActiveLoop, LoopEvent, LoopId, RunLoopParams } from '../protocol/protocol';
import type { Chat, Message, MessageAttachment, Project } from '../protocol/types';

/** Result of a successful run, returned to the dispatcher for cleanup. */
export interface ChatRunnerResult {
  loopId: LoopId;
  status: 'complete' | 'error' | 'aborted' | 'soft_stopped' | 'max_iterations';
}

export class ChatRunner {
  private readonly deps: BackendDeps;
  private readonly registry: LoopRegistry;

  constructor(deps: BackendDeps, registry: LoopRegistry) {
    this.deps = deps;
    this.registry = registry;
  }

  /** Convenience accessor — every storage call routes through here. */
  private get storage() {
    return this.deps.storage;
  }

  /**
   * Run an agentic loop and stream LoopEvents until terminal status.
   *
   * The dispatcher is responsible for creating the `AbortController` *and*
   * the `loopId` so the registry entry is reachable from `abortLoop` even
   * if this generator throws before the first yield.
   */
  async *run(
    params: RunLoopParams,
    abortController: AbortController,
    loopId: LoopId,
    parentLoopId?: LoopId
  ): AsyncGenerator<LoopEvent, ChatRunnerResult, void> {
    // 1. Load context. Failures here surface as ProtocolError before
    //    `loop_started` is yielded — the dispatcher hasn't registered with
    //    LoopRegistry yet, so nothing to clean up.
    const ctx = await loadChatLoopContext(this.storage, params.chatId);

    // 2. Concurrent loop check. The dispatcher already registered before
    //    calling us so the check happens *before* register, but we double-
    //    check here for safety.
    //    (Actually the dispatcher registers AFTER we yield loop_started,
    //    so this is the only check that runs.)
    if (this.registry.hasRunningLoopForChat(ctx.chat.id)) {
      throw new ProtocolError('CHAT_BUSY', `chat ${ctx.chat.id} already has a running loop`);
    }

    // 3. Load existing messages and check the incomplete-tail lock.
    const existingMessages = await this.storage.getMessages(ctx.chat.id);
    assertChatNotLockedByIncompleteTail(existingMessages);

    // 4. Build the active loop record + register with LoopRegistry. From
    //    this point on, abortLoop can fire on this controller.
    const activeLoop: ActiveLoop = {
      loopId,
      chatId: ctx.chat.id,
      parentLoopId,
      startedAt: Date.now(),
      status: 'running',
      apiDefinitionId: ctx.apiDef.id,
      modelId: ctx.modelId,
    };
    this.registry.register(activeLoop, abortController);

    let terminalStatus: ChatRunnerResult['status'] = 'complete';
    let thrown: unknown = null;
    let errorDetail: string | undefined;
    try {
      // Yield the loop_started event so subscribers can correlate.
      yield { type: 'loop_started', loopId, parentLoopId };

      // 5. Build context messages + (optionally) create+persist a user
      //    message for `send`/`resend` modes. Synthesized user messages get
      //    a `message_created` event so the frontend can render them
      //    immediately, before the first streaming chunk arrives.
      const built = yield* this.buildContextMessages(ctx, params, existingMessages);
      const contextMessages = built.messages;
      const trailingUserMessage = built.trailingUserMessage;

      // 6. Build options. The signal threads through to every API call,
      //    every tool, and the dummy hook VM. `deps` carries the injected
      //    storage / encryption / api / tool registry into the agentic loop
      //    so they end up in `ToolContext` for tool execution.
      const options = await buildAgenticLoopOptionsForContext(
        this.deps,
        ctx,
        abortController.signal,
        loopId,
        parentLoopId
      );

      // Wire the soft-stop closure: dispatcher flips a flag in the registry
      // when softStopLoop fires.
      options.shouldStop = () => this.registry.isSoftStopRequested(loopId);

      // Pass through pendingToolUseBlocks + trailing user message for the
      // continue-tools path of resolvePendingToolCalls.
      if (params.pendingToolUseBlocks?.length) {
        options.pendingToolUseBlocks = params.pendingToolUseBlocks;
        if (trailingUserMessage) {
          options.pendingTrailingContext = [trailingUserMessage];
        }
      }

      // 7. Drive the agentic loop and adapt its events.
      const consumeResult = yield* this.consumeLoop(options, contextMessages, ctx);
      terminalStatus = consumeResult.status;
    } catch (err) {
      terminalStatus = 'error';
      errorDetail = err instanceof Error ? err.message : String(err);
      thrown = err;
    }

    // Recompute the incomplete-tail lock state from the now-final message
    // history and broadcast it before the loop teardown event. The aborted
    // path persists a partial assistant message with `incomplete: true`,
    // which flips the lock to true; the complete path leaves it false.
    // Yielded as a normal LoopEvent so the runLoop dispatcher's
    // broadcastChatEvent fan-out delivers it to every attachChat subscriber
    // (and to the consumer of the runLoop stream itself).
    try {
      const finalMessages = await this.storage.getMessages(params.chatId);
      yield {
        type: 'lock_state_changed',
        locked: isChatLockedByIncompleteTail(finalMessages),
      };
    } catch (err) {
      console.error('[ChatRunner.run] lock state recompute failed:', err);
    }

    // Always yield a terminal `loop_ended` event so attachChat subscribers
    // can transition out of the running state. This happens before unwinding
    // the registry entry so the broadcast lands while the entry still
    // exists.
    yield { type: 'loop_ended', loopId, status: terminalStatus, detail: errorDetail };
    this.registry.end(loopId, terminalStatus);

    if (thrown) throw thrown;
    return { loopId, status: terminalStatus };
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  /**
   * Build the message context the agentic loop sees and yield a
   * `message_created` event for any user messages we synthesize so the
   * frontend can render them immediately.
   *
   * Modes:
   *   - `send`/`resend`: synthesize + persist a new user message and append.
   *   - `retry`: keep messages up to and including the anchor; delete the
   *     rest from storage so the next load reflects the truncation.
   *   - `continue`: use existing messages as-is.
   *
   * For the resolvePendingToolCalls 'continue' path, callers may also pass
   * `pendingTrailingContent` — we synthesize a user message for it but do
   * NOT append it to the context list. The agentic loop's
   * `pendingTrailingContext` option injects it after the tool results,
   * keeping API ordering correct.
   */
  private async *buildContextMessages(
    ctx: ChatLoopContext,
    params: RunLoopParams,
    existingMessages: Message<unknown>[]
  ): AsyncGenerator<
    LoopEvent,
    { messages: Message<unknown>[]; trailingUserMessage?: Message<unknown> },
    void
  > {
    if (params.mode === 'send' || params.mode === 'resend') {
      const text = (params.content ?? '').trim();
      if (!text && (!params.attachments || params.attachments.length === 0)) {
        throw new ProtocolError(
          'INVALID_PARAMS',
          'send/resend requires either content text or attachments'
        );
      }
      const userMessage = await this.createAndSaveUserMessage(
        ctx.chat.id,
        text,
        ctx.project,
        ctx.chat,
        ctx.modelId,
        existingMessages.length > 0 ? existingMessages[0].timestamp : undefined,
        params.attachments
      );
      yield { type: 'message_created', message: prepareMessageForWire(userMessage) };
      return { messages: [...existingMessages, userMessage] };
    }

    if (params.mode === 'retry' && params.fromMessageId) {
      const idx = existingMessages.findIndex(m => m.id === params.fromMessageId);
      if (idx >= 0) {
        // Keep up to and including the anchor; delete the rest.
        const kept = existingMessages.slice(0, idx + 1);
        const next = existingMessages[idx + 1];
        if (next) {
          await this.storage.deleteMessageAndAfter(ctx.chat.id, next.id);
          // Tell live subscribers to drop the deleted messages from their
          // view. Snapshot replay reads from storage and doesn't need this.
          yield { type: 'messages_truncated', afterMessageId: params.fromMessageId };
        }
        return { messages: kept };
      }
    }

    // continue / retry without anchor: synthesize a trailing user message if
    // the caller passed one (used by resolvePendingToolCalls 'continue' mode).
    let trailingUserMessage: Message<unknown> | undefined;
    if (
      (params.pendingTrailingContent && params.pendingTrailingContent.trim().length > 0) ||
      (params.pendingTrailingAttachments && params.pendingTrailingAttachments.length > 0)
    ) {
      const text = (params.pendingTrailingContent ?? '').trim();
      trailingUserMessage = await this.createAndSaveUserMessage(
        ctx.chat.id,
        text,
        ctx.project,
        ctx.chat,
        ctx.modelId,
        existingMessages.length > 0 ? existingMessages[0].timestamp : undefined,
        params.pendingTrailingAttachments
      );
      // The trailing message will be injected by the agentic loop after the
      // tool results, but we still emit `message_created` so the frontend
      // shows it immediately. The agentic loop will NOT re-emit it.
      yield { type: 'message_created', message: prepareMessageForWire(trailingUserMessage) };
    }

    return { messages: existingMessages, trailingUserMessage };
  }

  /**
   * Create + persist a user message. Mirrors `useChat.ts`'s helper of the
   * same name. PR 10 will delete the React copy and route through this one.
   */
  private async createAndSaveUserMessage(
    chatId: string,
    messageText: string,
    project: Project,
    chat: Chat,
    modelId: string,
    firstMessageTimestamp: Date | undefined,
    attachments: MessageAttachment[] | undefined
  ): Promise<Message<unknown>> {
    const messageWithMetadata = generateMessageWithMetadata(
      messageText,
      project,
      chat,
      modelId,
      firstMessageTimestamp
    );

    const attachmentIds = attachments?.map(att => att.id) ?? [];

    const userMessage: Message<unknown> = {
      id: generateUniqueId('msg_user'),
      role: 'user',
      content: {
        type: 'text',
        content: messageWithMetadata,
        renderingContent: [{ category: 'text', blocks: [{ type: 'text', text: messageText }] }],
        ...(attachmentIds.length > 0 && {
          attachmentIds,
          originalAttachmentCount: attachmentIds.length,
        }),
      },
      timestamp: new Date(),
    };

    if (attachments && attachments.length > 0) {
      for (const attachment of attachments) {
        await this.storage.saveAttachment(userMessage.id, attachment);
      }
    }

    await this.storage.saveMessage(chatId, userMessage);
    return userMessage;
  }

  /**
   * Drive `runAgenticLoop` and adapt its events into protocol `LoopEvent`s.
   * Persists messages on `message_created`, updates chat totals on
   * `tokens_consumed`, and reports the terminal status to the caller.
   *
   * Mirrors `consumeAgenticLoop` in `useChat.ts` but yields events instead
   * of dispatching to React state setters.
   */
  private async *consumeLoop(
    options: Parameters<typeof runAgenticLoop>[0],
    context: Message<unknown>[],
    ctx: ChatLoopContext
  ): AsyncGenerator<LoopEvent, { status: ChatRunnerResult['status'] }, void> {
    const totals = createTokenTotals();
    let currentChat = ctx.chat;
    let lastContextWindowUsage = 0;
    let hasUnreliableCost = false;

    yield { type: 'streaming_start' };

    try {
      const gen = runAgenticLoop(options, context);
      let result: IteratorResult<AgenticLoopEvent, AgenticLoopResult>;
      do {
        result = await gen.next();
        if (!result.done) {
          const event = result.value;
          // Adapt the inner event to the protocol shape.
          switch (event.type) {
            case 'streaming_start':
              yield { type: 'streaming_chunk', groups: [] };
              break;

            case 'streaming_chunk':
              yield { type: 'streaming_chunk', groups: event.groups };
              break;

            case 'streaming_end':
              // We yield streaming_end at the very bottom in finally.
              break;

            case 'first_chunk':
              yield { type: 'first_chunk' };
              break;

            case 'message_created':
              await this.storage.saveMessage(ctx.chat.id, event.message);
              if (
                event.message.role === 'assistant' &&
                event.message.metadata?.contextWindowUsage
              ) {
                lastContextWindowUsage = event.message.metadata.contextWindowUsage;
              }
              if (event.message.metadata?.costUnreliable) {
                hasUnreliableCost = true;
              }
              yield { type: 'message_created', message: prepareMessageForWire(event.message) };
              break;

            case 'tokens_consumed': {
              addTokens(totals, event.tokens);
              const tokenChat: Chat = applyTokensToChat(currentChat, event);
              currentChat = tokenChat;
              await this.storage.saveChat(tokenChat);
              yield { type: 'tokens_consumed', tokens: event.tokens, isToolCost: event.isToolCost };
              yield { type: 'chat_updated', chat: tokenChat };
              break;
            }

            case 'pending_tool_result':
              yield { type: 'pending_tool_result', message: prepareMessageForWire(event.message) };
              break;

            case 'tool_block_update':
              yield {
                type: 'tool_block_update',
                toolUseId: event.toolUseId,
                block: event.block,
              };
              break;

            case 'checkpoint_set': {
              const cpChat: Chat = {
                ...currentChat,
                checkpointMessageIds: [
                  ...(currentChat.checkpointMessageIds ?? []),
                  event.messageId,
                ],
              };
              currentChat = cpChat;
              await this.storage.saveChat(cpChat);
              yield { type: 'checkpoint_set', messageId: event.messageId };
              yield { type: 'chat_updated', chat: cpChat };
              break;
            }

            case 'active_hook_changed': {
              const hookChat: Chat = {
                ...currentChat,
                activeHook: event.hookName ?? undefined,
              };
              currentChat = hookChat;
              await this.storage.saveChat(hookChat);
              yield { type: 'active_hook_changed', hookName: event.hookName };
              yield { type: 'chat_updated', chat: hookChat };
              break;
            }

            case 'chat_metadata_updated': {
              const metaChat: Chat = {
                ...currentChat,
                ...(event.name !== undefined && { name: event.name }),
                ...(event.summary !== undefined && { summary: event.summary }),
              };
              currentChat = metaChat;
              await this.storage.saveChat(metaChat);
              yield { type: 'chat_metadata_updated', name: event.name, summary: event.summary };
              yield { type: 'chat_updated', chat: metaChat };
              break;
            }

            case 'dummy_hook_start':
              yield { type: 'dummy_hook_start', hookName: event.hookName };
              break;

            case 'dummy_hook_end':
              yield { type: 'dummy_hook_end', result: event.result };
              break;
          }
        }
      } while (!result.done);

      // result.done — final result is in result.value
      const finalResult = result.value;

      // Final chat save: rolls in lastContextWindowUsage + new messageCount.
      const finalChat: Chat = {
        ...currentChat,
        contextWindowUsage: lastContextWindowUsage,
        messageCount: (ctx.chat.messageCount ?? 0) + finalResult.messages.length - context.length,
        lastModifiedAt: new Date(),
        costUnreliable: hasUnreliableCost || currentChat.costUnreliable || undefined,
      };
      await this.storage.saveChat(finalChat);
      yield { type: 'chat_updated', chat: finalChat };

      const finalProject: Project = {
        ...ctx.project,
        lastUsedAt: new Date(),
      };
      await this.storage.saveProject(finalProject);
      yield { type: 'project_updated', project: finalProject };

      return { status: finalResult.status };
    } finally {
      yield { type: 'streaming_end' };
    }
  }
}

/**
 * Apply a `tokens_consumed` event to a chat object, returning a new chat
 * with the cumulative totals updated. Mirrors the equivalent block in
 * `useChat.ts`'s `consumeAgenticLoop`.
 */
function applyTokensToChat(
  chat: Chat,
  event: { tokens: import('../protocol/types/content').TokenTotals; isToolCost?: boolean }
): Chat {
  return {
    ...chat,
    totalInputTokens: (chat.totalInputTokens ?? 0) + event.tokens.inputTokens,
    totalOutputTokens: (chat.totalOutputTokens ?? 0) + event.tokens.outputTokens,
    totalReasoningTokens: (chat.totalReasoningTokens ?? 0) + event.tokens.reasoningTokens,
    totalCacheCreationTokens:
      (chat.totalCacheCreationTokens ?? 0) + event.tokens.cacheCreationTokens,
    totalCacheReadTokens: (chat.totalCacheReadTokens ?? 0) + event.tokens.cacheReadTokens,
    totalCost: (chat.totalCost ?? 0) + event.tokens.cost,
    costUnreliable: event.tokens.costUnreliable || chat.costUnreliable || undefined,
    ...(event.isToolCost && {
      minionTotalInputTokens: (chat.minionTotalInputTokens ?? 0) + event.tokens.inputTokens,
      minionTotalOutputTokens: (chat.minionTotalOutputTokens ?? 0) + event.tokens.outputTokens,
      minionTotalReasoningTokens:
        (chat.minionTotalReasoningTokens ?? 0) + event.tokens.reasoningTokens,
      minionTotalCacheCreationTokens:
        (chat.minionTotalCacheCreationTokens ?? 0) + event.tokens.cacheCreationTokens,
      minionTotalCacheReadTokens:
        (chat.minionTotalCacheReadTokens ?? 0) + event.tokens.cacheReadTokens,
      minionTotalCost: (chat.minionTotalCost ?? 0) + event.tokens.cost,
    }),
  };
}
