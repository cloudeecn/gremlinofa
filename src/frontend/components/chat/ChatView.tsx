import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChat } from '../../hooks/useChat';
import { useApiDefinitions } from '../../hooks/useApp';
import { showAlert, showConfirm, showDestructiveConfirm } from '../../lib/alerts';
import { formatTokenGroup, messagePreviewLine, userMessageText } from '../../lib/messageFormatters';
import { clearDraft, useDraftPersistence } from '../../hooks/useDraftPersistence';
import { useImageDropZone } from '../../hooks/useImageDropZone';
import { useImeSafeEnter } from '../../hooks/useImeSafeEnter';
import { useOverlay } from '../../hooks/useOverlay';
import { useStableCallback } from '../../hooks/useStableCallback';
import { useViewOptions } from '../../hooks/useViewOptions';
import { processImages } from '../../lib/imageProcessor';
import { gremlinClient } from '../../client';
import { getApiDefinitionIcon } from '../../lib/apiTypeUtils';
import { hasChatAgentOverrides } from '../../../shared/protocol/types';
import type { CarriedInjection, MessageAttachment } from '../../../shared/protocol/types';
import { carriesFiles, extractCarriedInjection } from '../../../shared/protocol/carriedInjection';
import ModelSelector from '../project/ModelSelector';
import ChatSettingsPanel from './ChatSettingsPanel';
import Modal from '../ui/Modal';
import Spinner from '../ui/Spinner';
import CarriedFilesStrip from './CarriedFilesStrip';
import ChatInput from './ChatInput';
import MessageList from './MessageList';
import type { ChatInputHandle, MessageAction, MessageListHandle } from './types';
import MinionChatView from './MinionChatView';
import { MinionChatOverlayContext } from './MinionChatOverlayContext';

const ignoreClose = () => {};

interface ChatViewProps {
  chatId: string;
  onMenuPress?: () => void;
}

export default function ChatView({ chatId, onMenuPress }: ChatViewProps) {
  const navigate = useNavigate();
  const [inputMessage, setInputMessage] = useState('');
  // Store processed attachments (MessageAttachment[]) instead of raw Files
  // This prevents performance issues with large HDR images
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  // Injected files an edited message carries into its replacement. Like
  // attachments they ride along with the next send, but only an edit adds them.
  const [carriedInjection, setCarriedInjection] = useState<CarriedInjection | null>(null);
  const [isProcessingAttachments, setIsProcessingAttachments] = useState(false);

  // Draft persistence for chat input
  useDraftPersistence({
    place: 'chatview',
    contextId: chatId,
    value: inputMessage,
    onChange: setInputMessage,
  });

  const [showModelSelector, setShowModelSelector] = useState(false);
  // Stack of open minion-chat overlays. "View Chat" inside a minion overlay
  // drills in by pushing onto this stack (a minion can itself spawn sub-minions),
  // and each layer's back/close pops one level. Empty = no overlay.
  const [minionChatStack, setMinionChatStack] = useState<string[]>([]);
  const pushMinionChat = useCallback((id: string) => {
    setMinionChatStack(stack => [...stack, id]);
  }, []);
  const minionChatOverlay = useMemo(() => ({ viewMinionChat: pushMinionChat }), [pushMinionChat]);
  const [isRenamingChat, setIsRenamingChat] = useState(false);
  const [renameChatText, setRenameChatText] = useState('');
  const [isSavingRename, setIsSavingRename] = useState(false);
  const renameIme = useImeSafeEnter();
  const {
    options: { focusMode, expandMinions, disableMath, alwaysAutoScroll },
    toggle: toggleViewOption,
  } = useViewOptions();
  const messageListRef = useRef<MessageListHandle>(null);
  const chatInputRef = useRef<ChatInputHandle>(null);
  const [showViewMenu, setShowViewMenu] = useState(false);
  const [showChatSettings, setShowChatSettings] = useState(false);
  const viewMenuRef = useRef<HTMLDivElement>(null);
  const viewMenuPanelRef = useRef<HTMLDivElement>(null);
  const viewMenuButtonRef = useRef<HTMLButtonElement>(null);
  // Editing an earlier user message: the composer holds its text, and nothing
  // is deleted until the edit is sent
  const [editing, setEditing] = useState<{ messageId: string; preview: string } | null>(null);

  const { isDragging, dropZoneProps } = useImageDropZone(files =>
    chatInputRef.current?.addFiles(files)
  );

  // Get API definitions for icon display
  const apiDefinitions = useApiDefinitions();

  // Close view menu when clicking outside
  useEffect(() => {
    if (!showViewMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (viewMenuRef.current && !viewMenuRef.current.contains(e.target as Node)) {
        setShowViewMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showViewMenu]);

  useOverlay({
    active: showViewMenu,
    onEscape: () => {
      setShowViewMenu(false);
      viewMenuButtonRef.current?.focus();
    },
    containerRef: viewMenuPanelRef,
  });

  // Memoize callbacks to prevent unnecessary re-renders
  const handleMessagesLoaded = React.useCallback(
    (callbackChatId: string) => {
      if (callbackChatId !== chatId) {
        console.debug('[ChatView] Ignoring onMessagesLoaded for different chat');
        return;
      }
      console.debug('[ChatView] Messages loaded callback');
    },
    [chatId]
  );

  const handleMessageAppended = React.useCallback(
    (callbackChatId: string) => {
      if (callbackChatId !== chatId) {
        console.debug('[ChatView] Ignoring onMessageAppended for different chat');
        return;
      }
      console.debug('[ChatView] Message appended callback');
    },
    [chatId]
  );

  const handleMessagesRemovedOnAndAfter = React.useCallback(
    (callbackChatId: string) => {
      if (callbackChatId !== chatId) {
        console.debug('[ChatView] Ignoring onMessagesRemovedOnAndAfter for different chat');
        return;
      }
      console.debug('[ChatView] Messages removed callback');
    },
    [chatId]
  );

  const handleStreamingStart = React.useCallback(
    (callbackChatId: string) => {
      if (callbackChatId !== chatId) {
        console.debug('[ChatView] Ignoring onStreamingStart for different chat');
        return;
      }
      console.debug('[ChatView] Streaming start');
    },
    [chatId]
  );

  const handleStreamingEnd = React.useCallback(
    (callbackChatId: string) => {
      if (callbackChatId !== chatId) {
        console.debug('[ChatView] Ignoring onStreamingEnd for different chat');
        return;
      }
      console.debug('[ChatView] Streaming end');
    },
    [chatId]
  );

  const callbacks = React.useMemo(
    () => ({
      onMessagesLoaded: handleMessagesLoaded,
      onMessageAppended: handleMessageAppended,
      onMessagesRemovedOnAndAfter: handleMessagesRemovedOnAndAfter,
      onStreamingStart: handleStreamingStart,
      onStreamingEnd: handleStreamingEnd,
    }),
    [
      handleMessagesLoaded,
      handleMessageAppended,
      handleMessagesRemovedOnAndAfter,
      handleStreamingStart,
      handleStreamingEnd,
    ]
  );

  // Initialize useChat hook
  const {
    chat,
    project,
    messages,
    isLoading,
    loopPhase,
    showContinueBanner,
    tokenUsage,
    minionTokenUsage,
    currentApiDefId,
    currentModelId,
    parentApiDefId,
    parentModelId,
    streamingGroups,
    unresolvedToolCalls,
    softStopRequested,
    isLockedByIncompleteTail,
    snapshotLoading,
    sendMessage,
    sendEditedMessage,
    editMessage,
    forkChat,
    overrideModel,
    updateAgentConfig,
    updateChatName,
    resolvePendingToolCalls,
    rollbackToMessage,
    requestSoftStop,
    continueAfterToolStop,
    dummyHookStatus,
  } = useChat({
    chatId: chatId,
    callbacks,
  });

  // Handle message actions. Stable identity so MessageList/MessageBubble memo holds
  // while the handler still sees the latest messages and useChat commands.
  const handleMessageAction = useStableCallback(
    async (action: MessageAction, messageId: string) => {
      if (action === 'rollback') {
        const confirmed = await showDestructiveConfirm(
          'Roll Back',
          'This will delete all messages after this one.',
          'Roll Back'
        );
        if (confirmed) {
          await rollbackToMessage(chatId, messageId);
        }
      } else if (action === 'fork') {
        if (chat?.claudeAgentSessionId) {
          // Forking a claude-agent chat would split the SDK session. The hazard
          // itself is solved — `claudeAgentProtectedSessionIds` is exactly what
          // lets two records share an ancestor safely (see development.md) — so
          // this is now unimplemented UI rather than a hard constraint: seed the
          // protect list from the forked-at message's stamp, same as the clone.
          return;
        }
        const forkedChat = await forkChat(chatId, messageId);
        if (forkedChat) {
          navigate(`/chat/${forkedChat.id}`);
        }
      } else if (action === 'edit') {
        const message = messages.find(m => m.id === messageId);
        if (!message) return;

        // Nothing is deleted here — only the composer's unsent text is at stake
        const hasDraft =
          inputMessage.trim() !== '' || attachments.length > 0 || carriesFiles(carriedInjection);
        if (hasDraft && editing?.messageId !== messageId) {
          const replace = await showConfirm(
            'Replace your draft?',
            'The message box has unsent text. Editing this message replaces it.',
            'Replace'
          );
          if (!replace) return;
        }

        // Load attachments if the message has any (already processed MessageAttachment[])
        let loadedAttachments: MessageAttachment[] = [];
        if (message.content.attachmentIds?.length) {
          console.debug('[ChatView] Loading attachments for edit:', message.content.attachmentIds);
          loadedAttachments = await gremlinClient.getAttachments(messageId);
          console.debug('[ChatView] Loaded attachments:', loadedAttachments.length);
        }

        setInputMessage(userMessageText(message));
        setAttachments(loadedAttachments);
        setCarriedInjection(extractCarriedInjection(message.content) ?? null);
        setEditing({ messageId, preview: messagePreviewLine(message, 80) });
      }
    }
  );

  const handleCancelEdit = () => {
    setEditing(null);
    setInputMessage('');
    setAttachments([]);
    setCarriedInjection(null);
    clearDraft('chatview', chatId);
  };

  const handleRemoveCarriedFile = (side: 'before' | 'after', index: number) => {
    setCarriedInjection(current => {
      if (!current) return current;
      const next = { ...current, [side]: current[side].filter((_, i) => i !== index) };
      return carriesFiles(next) ? next : null;
    });
  };

  // Process files immediately when added (fixes performance with large HDR images)
  const handleFilesAdded = useCallback(
    async (files: File[]) => {
      setIsProcessingAttachments(true);
      try {
        const result = await processImages(files, 10 - attachments.length);

        if (result.errors.length > 0) {
          showAlert('Image Processing Error', result.errors.join('\n'));
        }

        if (result.attachments.length > 0) {
          setAttachments(prev => [...prev, ...result.attachments]);
          console.debug('[ChatView] Processed and added attachments:', result.attachments.length);
        }
      } finally {
        setIsProcessingAttachments(false);
      }
    },
    [attachments.length]
  );

  // Remove attachment by ID
  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  }, []);

  const handleSendMessage = async () => {
    const messageText = inputMessage.trim();
    // An edit replaces the message the pending tool calls hang off
    const hasPendingTools = !editing && unresolvedToolCalls && unresolvedToolCalls.length > 0;

    // Allow send with empty input if there are pending tool calls
    if (
      (!messageText &&
        attachments.length === 0 &&
        !carriesFiles(carriedInjection) &&
        !hasPendingTools) ||
      isLoading ||
      isProcessingAttachments
    )
      return;

    // Validate API configuration
    if (!currentApiDefId || !currentModelId) {
      showAlert(
        'Configuration Required',
        'Please configure an API and model for this chat or project.'
      );
      return;
    }

    // Attachments are already processed (MessageAttachment[])
    const processedAttachments = attachments.length > 0 ? attachments : undefined;
    const draftText = inputMessage;
    const draftAttachments = attachments;
    const draftCarried = carriesFiles(carriedInjection) ? carriedInjection : undefined;
    const editedMessage = editing;

    clearComposer();

    if (editedMessage) {
      setEditing(null);
      setCarriedInjection(null);
      const outcome = await sendEditedMessage(
        chatId,
        editedMessage.messageId,
        messageText,
        processedAttachments,
        draftCarried
      );
      // 'truncated' keeps the files too: the follow-up plain send carries them
      if (outcome !== 'sent') restoreComposer(draftText, draftAttachments, draftCarried);
      // Only an edit whose message is still there can resume editing it
      if (outcome === 'untouched') setEditing(current => current ?? editedMessage);
      return;
    }
    // The pending-tools reply can't carry injected files, so they stay in the
    // composer. Unreachable in practice: only an edit adds them, an edit hides
    // the pending-tools path, and an edited message is never a tool result.
    let sent: boolean;
    if (hasPendingTools) {
      // User message triggers reject with the message
      sent = await resolvePendingToolCalls('stop', messageText || undefined, processedAttachments);
    } else {
      setCarriedInjection(null);
      sent = await sendMessage(chatId, messageText, processedAttachments, draftCarried);
    }
    if (!sent) restoreComposer(draftText, draftAttachments, draftCarried);
  };

  /** Empties the composer for a send; `restoreComposer` undoes it if the send fails. */
  const clearComposer = () => {
    setInputMessage('');
    setAttachments([]);
    clearDraft('chatview', chatId);
    // Sending from deep in history shows the new message and follows the reply
    messageListRef.current?.jumpToLatest();
  };

  /**
   * Puts back what a failed send took out of the composer, ahead of anything
   * typed since. The draft is saved again by the normal debounce. Carried
   * files come back only if no edit loaded others meanwhile.
   */
  const restoreComposer = (
    text: string,
    restoredAttachments: MessageAttachment[],
    restoredCarried?: CarriedInjection
  ) => {
    if (text) setInputMessage(current => (current ? `${text}\n${current}` : text));
    if (restoredAttachments.length > 0) {
      setAttachments(current => [...restoredAttachments, ...current]);
    }
    if (restoredCarried) setCarriedInjection(current => current ?? restoredCarried);
  };

  const resolvePendingToolsFromBanner = async (mode: 'stop' | 'continue') => {
    // Same guard as the composer's send: the banner buttons stay clickable
    if (isLoading || isProcessingAttachments) return;
    const draftText = inputMessage;
    const draftAttachments = attachments;
    clearComposer();
    const resolved = await resolvePendingToolCalls(
      mode,
      draftText.trim() || undefined,
      draftAttachments.length > 0 ? draftAttachments : undefined
    );
    if (!resolved) restoreComposer(draftText, draftAttachments);
  };
  const handlePendingToolReject = useStableCallback(() => resolvePendingToolsFromBanner('stop'));
  const handlePendingToolAccept = useStableCallback(() =>
    resolvePendingToolsFromBanner('continue')
  );
  const handleContinueAfterToolStop = useStableCallback(() => continueAfterToolStop());

  const handleModelSelect = async (apiDefId: string | null, modelId: string | null) => {
    try {
      await overrideModel(chatId, apiDefId, modelId);
      setShowModelSelector(false);
    } catch (err) {
      showAlert('Model not changed', err instanceof Error ? err.message : String(err));
    }
  };

  const handleStartRename = () => {
    setRenameChatText(chat?.name || '');
    setIsRenamingChat(true);
  };

  const handleSaveRename = async () => {
    if (!renameChatText.trim()) {
      setIsRenamingChat(false);
      return;
    }

    setIsSavingRename(true);
    try {
      await updateChatName(chatId, renameChatText.trim());
      setIsRenamingChat(false);
    } catch (err) {
      showAlert('Rename failed', err instanceof Error ? err.message : String(err));
    } finally {
      setIsSavingRename(false);
    }
  };

  const handleCancelRename = () => {
    setIsRenamingChat(false);
    setRenameChatText('');
  };

  const handleClose = () => {
    if (chat) {
      navigate(`/project/${chat.projectId}`);
    } else {
      navigate('/');
    }
  };

  if (!chat) return null;

  return (
    <MinionChatOverlayContext.Provider value={minionChatOverlay}>
      {/* The whole view takes dropped images, so a drop a few pixels off the
          composer doesn't navigate the browser to the file */}
      <div className="relative flex h-full flex-col bg-white" {...dropZoneProps}>
        {/* Header with safe area */}
        <div className="border-b border-gray-200 bg-white">
          <div className="safe-area-inset-top" />
          <div className="flex h-14 items-center px-4">
            {/* Mobile: burger menu to open sidebar */}
            {onMenuPress && (
              <button
                onClick={onMenuPress}
                aria-label="Open menu"
                className="-ml-2 flex h-11 w-11 items-center justify-center rounded-lg transition-colors hover:bg-gray-100 md:hidden"
              >
                <span className="text-2xl text-gray-700">☰</span>
              </button>
            )}
            {/* Desktop: back arrow to project */}
            <button
              onClick={handleClose}
              className={`-ml-2 flex h-11 w-11 items-center justify-center rounded-lg transition-colors hover:bg-gray-100 ${onMenuPress ? 'hidden md:flex' : ''}`}
            >
              <span className="text-2xl text-gray-700">←</span>
            </button>
            <div className="flex min-w-0 flex-1 flex-col justify-center">
              <button
                onClick={handleStartRename}
                className="text-left transition-colors hover:text-blue-600"
              >
                <h1 className="truncate text-lg font-semibold text-gray-900">{chat.name}</h1>
              </button>
              <button
                onClick={() => setShowModelSelector(true)}
                className="truncate text-left text-xs text-gray-600 transition-colors hover:text-blue-600"
              >
                {(chat.apiDefinitionId !== null ||
                  chat.modelId !== null ||
                  hasChatAgentOverrides(chat)) && (
                  <span title="This chat overrides some project settings">*</span>
                )}
                {currentApiDefId &&
                  (() => {
                    const apiDef = apiDefinitions.find(d => d.id === currentApiDefId);
                    return apiDef ? getApiDefinitionIcon(apiDef) + ' ' : '';
                  })()}
                {currentModelId || 'No model'} ▼
              </button>
            </div>
            {/* View menu */}
            <div ref={viewMenuRef} className="relative">
              <button
                ref={viewMenuButtonRef}
                onClick={() => setShowViewMenu(prev => !prev)}
                aria-label="Chat menu"
                aria-haspopup="menu"
                aria-expanded={showViewMenu}
                className="flex h-11 w-11 items-center justify-center text-gray-600 hover:text-gray-900"
              >
                <span className="text-xl">⋯</span>
              </button>
              {showViewMenu && (
                <div
                  ref={viewMenuPanelRef}
                  tabIndex={-1}
                  className="absolute top-full right-0 z-10 mt-1 w-52 rounded-lg border border-gray-200 bg-white py-1 shadow-lg outline-none"
                >
                  <button
                    onClick={() => toggleViewOption('focusMode')}
                    className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100"
                  >
                    <span className="w-5 text-center">{focusMode ? '✓' : ''}</span>
                    <span>Focus Mode</span>
                  </button>
                  <button
                    onClick={() => toggleViewOption('expandMinions')}
                    className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100"
                  >
                    <span className="w-5 text-center">{expandMinions ? '✓' : ''}</span>
                    <span>Expand Minions</span>
                  </button>
                  <button
                    onClick={() => toggleViewOption('disableMath')}
                    className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100"
                  >
                    <span className="w-5 text-center">{disableMath ? '✓' : ''}</span>
                    <span>Disable Math</span>
                  </button>
                  <button
                    onClick={() => toggleViewOption('alwaysAutoScroll')}
                    className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100"
                  >
                    <span className="w-5 text-center">{alwaysAutoScroll ? '✓' : ''}</span>
                    <span>Always Auto Scroll</span>
                  </button>
                  <div className="my-1 border-t border-gray-200" />
                  <button
                    onClick={() => {
                      setShowViewMenu(false);
                      setShowChatSettings(true);
                    }}
                    className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100"
                  >
                    <span className="w-5 text-center">⚙</span>
                    <span>Chat Settings</span>
                  </button>
                  <div className="my-1 border-t border-gray-200" />
                  <button
                    onClick={() => {
                      setShowViewMenu(false);
                      handleClose();
                    }}
                    className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100"
                  >
                    <span className="w-5 text-center">↩</span>
                    <span>Exit Chat</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Info Bar */}
        {(() => {
          const minionCost = minionTokenUsage.cost ?? 0;
          const hasMinionData =
            minionTokenUsage.input > 0 || minionTokenUsage.output > 0 || minionCost > 0;
          return (
            <div className="flex flex-col items-end border-b border-gray-200 bg-white px-4 py-1">
              <div className="text-[10px] text-gray-600">
                {chat.activeHook && <span className="text-green-600">● </span>}
                {hasMinionData ? (
                  <>
                    {formatTokenGroup('↑', tokenUsage.input - minionTokenUsage.input, [
                      {
                        prefix: 'C↑',
                        value:
                          (tokenUsage.cacheCreation ?? 0) - (minionTokenUsage.cacheCreation ?? 0) ||
                          undefined,
                      },
                      {
                        prefix: 'C↓',
                        value:
                          (tokenUsage.cacheRead ?? 0) - (minionTokenUsage.cacheRead ?? 0) ||
                          undefined,
                      },
                    ])}{' '}
                    {formatTokenGroup('↓', tokenUsage.output - minionTokenUsage.output, [
                      {
                        prefix: 'R:',
                        value:
                          (tokenUsage.reasoning ?? 0) - (minionTokenUsage.reasoning ?? 0) ||
                          undefined,
                      },
                    ])}
                    {' $'}
                    {((tokenUsage.cost || 0) - minionCost).toFixed(3)}
                  </>
                ) : (
                  <>
                    {formatTokenGroup('↑', tokenUsage.input, [
                      { prefix: 'C↑', value: tokenUsage.cacheCreation },
                      { prefix: 'C↓', value: tokenUsage.cacheRead },
                    ])}{' '}
                    {formatTokenGroup('↓', tokenUsage.output, [
                      { prefix: 'R:', value: tokenUsage.reasoning },
                    ])}{' '}
                    ${tokenUsage.cost?.toFixed(3) || '0.000'}
                  </>
                )}
                {chat.costUnreliable && (
                  <span className="ml-1 text-yellow-600" title="Cost calculation may be inaccurate">
                    (unreliable)
                  </span>
                )}
              </div>
              {hasMinionData && (
                <div className="text-[10px] text-purple-600">
                  minion:{' '}
                  {formatTokenGroup('↑', minionTokenUsage.input, [
                    { prefix: 'C↑', value: minionTokenUsage.cacheCreation },
                    { prefix: 'C↓', value: minionTokenUsage.cacheRead },
                  ])}{' '}
                  {formatTokenGroup('↓', minionTokenUsage.output, [
                    { prefix: 'R:', value: minionTokenUsage.reasoning },
                  ])}
                  {' $'}
                  {minionCost.toFixed(3)}
                </div>
              )}
            </div>
          );
        })()}

        {/* Message List */}
        <MessageList
          ref={messageListRef}
          messages={messages}
          onAction={handleMessageAction}
          isLoading={isLoading}
          streamingGroups={streamingGroups}
          currentApiDefId={currentApiDefId}
          currentModelId={currentModelId}
          isClaudeAgentChat={!!chat?.claudeAgentSessionId}
          pendingToolCount={unresolvedToolCalls?.length}
          onPendingToolReject={handlePendingToolReject}
          onPendingToolAccept={handlePendingToolAccept}
          suspendedAfterTools={showContinueBanner}
          onContinueAfterToolStop={handleContinueAfterToolStop}
          focusMode={focusMode}
          expandMinions={expandMinions}
          disableMath={disableMath}
          alwaysAutoScroll={alwaysAutoScroll}
          dummyHookStatus={dummyHookStatus}
          snapshotLoading={snapshotLoading}
        />

        {/* Incomplete tail banner — chat is locked from continuation until
            the user resolves the partial assistant message left behind by a
            hard abort. The two resolution actions reuse existing message-
            context-menu / message-list flows: Delete removes the incomplete
            message; Roll Back to Last Checkpoint removes everything past the
            last checkpoint. */}
        {!snapshotLoading && isLockedByIncompleteTail && messages.length > 0 && (
          <div className="border-t border-yellow-300 bg-yellow-50 px-4 py-3 text-sm text-yellow-900">
            <div className="mb-2 font-medium">Last message was aborted.</div>
            <div className="mb-3 text-xs text-yellow-800">
              Resolve before continuing — delete the incomplete message or roll back to an earlier
              checkpoint.
            </div>
            <div className="flex gap-2">
              <button
                onClick={async () => {
                  const lastMsg = messages[messages.length - 1];
                  const confirmed = await showDestructiveConfirm(
                    'Delete Incomplete Message',
                    'This will delete the aborted assistant message so you can continue the chat.',
                    'Delete'
                  );
                  if (confirmed) {
                    await editMessage(chatId, lastMsg.id, '');
                  }
                }}
                className="rounded-md bg-yellow-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-yellow-700"
              >
                Delete Message
              </button>
              {chat?.checkpointMessageIds && chat.checkpointMessageIds.length > 0 && (
                <button
                  onClick={async () => {
                    const lastCheckpoint =
                      chat.checkpointMessageIds![chat.checkpointMessageIds!.length - 1];
                    const confirmed = await showDestructiveConfirm(
                      'Roll Back to Checkpoint',
                      'This will delete every message after the last checkpoint.',
                      'Roll Back'
                    );
                    if (confirmed) {
                      // Find the message right after the checkpoint and
                      // delete from there. The checkpoint message itself
                      // stays.
                      const cpIdx = messages.findIndex(m => m.id === lastCheckpoint);
                      if (cpIdx >= 0 && cpIdx + 1 < messages.length) {
                        await editMessage(chatId, messages[cpIdx + 1].id, '');
                      }
                    }
                  }}
                  className="rounded-md border border-yellow-600 bg-white px-3 py-1.5 text-xs font-medium text-yellow-700 transition-colors hover:bg-yellow-100"
                >
                  Roll Back to Checkpoint
                </button>
              )}
            </div>
          </div>
        )}

        {editing && (
          <div className="flex items-center gap-3 border-t border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-900">
            <div className="min-w-0 flex-1">
              <div className="truncate">
                <span className="font-medium">Editing:</span> {editing.preview}
              </div>
              <div className="text-xs text-blue-700">
                Sending replaces it and everything after it.
              </div>
            </div>
            <button
              onClick={handleCancelEdit}
              className="h-9 shrink-0 rounded-md px-3 text-sm font-medium transition-colors hover:bg-blue-100"
            >
              Cancel
            </button>
          </div>
        )}

        {carriedInjection && (
          <CarriedFilesStrip injection={carriedInjection} onRemove={handleRemoveCarriedFile} />
        )}

        {/* Chat Input */}
        <ChatInput
          ref={chatInputRef}
          value={inputMessage}
          onChange={setInputMessage}
          onSend={handleSendMessage}
          // Sending an edit truncates the locked tail first, so it may go through
          sendDisabled={isLoading || snapshotLoading || (isLockedByIncompleteTail && !editing)}
          attachments={attachments}
          onFilesAdded={handleFilesAdded}
          onRemoveAttachment={handleRemoveAttachment}
          maxAttachments={10}
          isProcessing={isProcessingAttachments}
          showSendSpinner={loopPhase === 'pending'}
          hasPendingToolCalls={!editing && !!unresolvedToolCalls && unresolvedToolCalls.length > 0}
          hasCarriedFiles={carriesFiles(carriedInjection)}
          softStopRequested={softStopRequested}
          onRequestSoftStop={loopPhase !== 'idle' ? requestSoftStop : undefined}
        />

        {/* Model Selector Modal */}
        {showModelSelector && (
          <ModelSelector
            isOpen={showModelSelector}
            onClose={() => setShowModelSelector(false)}
            currentApiDefinitionId={currentApiDefId}
            currentModelId={currentModelId}
            parentApiDefinitionId={parentApiDefId}
            parentModelId={parentModelId}
            onSelect={handleModelSelect}
            title="Configure Chat"
            showResetOption={true}
          />
        )}

        {/* Rename Chat Modal. A save in flight can't be called back, so the
            backdrop and Escape wait for it like Cancel does. */}
        <Modal
          isOpen={isRenamingChat}
          onClose={isSavingRename ? ignoreClose : handleCancelRename}
          ariaLabel="Rename chat"
        >
          <div className="w-full rounded-xl bg-white p-6 shadow-xl">
            <h2 className="mb-4 text-lg font-semibold text-gray-900">Rename Chat</h2>
            <input
              type="text"
              value={renameChatText}
              onChange={e => setRenameChatText(e.target.value)}
              placeholder="Enter chat name"
              aria-label="Chat name"
              className="mb-4 w-full rounded-lg border border-gray-300 px-4 py-2 text-base focus:ring-2 focus:ring-blue-500 focus:outline-none"
              onCompositionEnd={renameIme.onCompositionEnd}
              onKeyDown={e => {
                if (renameIme.isImeEnter(e)) return;
                if (e.key === 'Enter' && !isSavingRename) {
                  handleSaveRename();
                }
              }}
            />
            <div className="flex justify-end gap-3">
              <button
                onClick={handleCancelRename}
                disabled={isSavingRename}
                className="rounded-lg border border-gray-300 px-4 py-2 text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveRename}
                disabled={isSavingRename}
                className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-400"
              >
                {isSavingRename && <Spinner size={14} colorClass="border-white" />}
                Save
              </button>
            </div>
          </div>
        </Modal>

        {/* Chat settings — a full-bleed overlay, not a route: a route change
            would tear down the live loop subscription mid-edit. */}
        {showChatSettings && project && (
          <ChatSettingsPanel
            chat={chat}
            project={project}
            apiDefinitions={apiDefinitions}
            currentApiDefId={currentApiDefId}
            currentModelId={currentModelId}
            onOpenModelSelector={() => setShowModelSelector(true)}
            onSave={updateAgentConfig}
            onClose={() => {
              setShowChatSettings(false);
              viewMenuButtonRef.current?.focus();
            }}
          />
        )}

        {/* Minion Chat Overlay(s) — layered so drilling into a sub-minion
            keeps the parent overlay mounted underneath; closing pops one.
            Above the chat settings panel (z-40), which is a sibling overlay. */}
        {minionChatStack.map((id, idx) => (
          <div
            key={`${idx}-${id}`}
            className="absolute inset-0 flex flex-col bg-white"
            style={{ zIndex: 50 + idx }}
          >
            <MinionChatView
              minionChatId={id}
              live={isLoading}
              disableMath={disableMath}
              onClose={() => setMinionChatStack(stack => stack.slice(0, idx))}
            />
          </div>
        ))}

        {isDragging && (
          <div className="pointer-events-none absolute inset-0 z-[60] flex items-center justify-center border-4 border-dashed border-blue-400 bg-blue-50/80 text-lg font-medium text-blue-700">
            Drop images to attach
          </div>
        )}
      </div>
    </MinionChatOverlayContext.Provider>
  );
}
