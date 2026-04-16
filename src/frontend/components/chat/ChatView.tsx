import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChat } from '../../hooks/useChat';
import { useApp } from '../../hooks/useApp';
import { showAlert, showDestructiveConfirm } from '../../lib/alerts';
import { formatTokenGroup, stripMetadata } from '../../lib/messageFormatters';
import { clearDraft, useDraftPersistence } from '../../hooks/useDraftPersistence';
import { processImages } from '../../lib/imageProcessor';
import { gremlinClient } from '../../client';
import { getApiDefinitionIcon } from '../../lib/apiTypeUtils';
import type { MessageAttachment } from '../../../shared/protocol/types';
import ModelSelector from '../project/ModelSelector';
import Spinner from '../ui/Spinner';
import ChatInput from './ChatInput';
import MessageList from './MessageList';
import MinionChatView from './MinionChatView';
import { MinionChatOverlayContext } from './MinionChatOverlayContext';

interface ChatViewProps {
  chatId: string;
}

export default function ChatView({ chatId }: ChatViewProps) {
  const navigate = useNavigate();
  const [inputMessage, setInputMessage] = useState('');
  // Store processed attachments (MessageAttachment[]) instead of raw Files
  // This prevents performance issues with large HDR images
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [isProcessingAttachments, setIsProcessingAttachments] = useState(false);

  // Draft persistence for chat input
  useDraftPersistence({
    place: 'chatview',
    contextId: chatId,
    value: inputMessage,
    onChange: setInputMessage,
  });

  const [showModelSelector, setShowModelSelector] = useState(false);
  const [activeMinionChatId, setActiveMinionChatId] = useState<string | null>(null);
  const [isRenamingChat, setIsRenamingChat] = useState(false);
  const [renameChatText, setRenameChatText] = useState('');
  const [isSavingRename, setIsSavingRename] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [expandMinions, setExpandMinions] = useState(false);
  const [disableMath, setDisableMath] = useState(false);
  const [alwaysAutoScroll, setAlwaysAutoScroll] = useState(false);
  const [showViewMenu, setShowViewMenu] = useState(false);
  const viewMenuRef = useRef<HTMLDivElement>(null);

  // Get API definitions for icon display
  const { apiDefinitions } = useApp();

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

  const handleForkMessageLoaded = React.useCallback(
    (callbackChatId: string, message: string) => {
      if (callbackChatId !== chatId) {
        console.debug('[ChatView] Ignoring onForkMessageLoaded for different chat');
        return;
      }
      console.debug('[ChatView] Fork message loaded into input');
      setInputMessage(message);
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
      onForkMessageLoaded: handleForkMessageLoaded,
    }),
    [
      handleMessagesLoaded,
      handleMessageAppended,
      handleMessagesRemovedOnAndAfter,
      handleStreamingStart,
      handleStreamingEnd,
      handleForkMessageLoaded,
    ]
  );

  // Initialize useChat hook
  const {
    chat,
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
    sendMessage,
    editMessage,
    copyMessage,
    forkChat,
    overrideModel,
    updateChatName,
    resolvePendingToolCalls,
    resendFromMessage,
    requestSoftStop,
    continueAfterToolStop,
    dummyHookStatus,
  } = useChat({
    chatId: chatId,
    callbacks,
  });

  // Handle message actions
  const handleMessageAction = async (
    action: 'copy' | 'fork' | 'edit' | 'delete' | 'resend',
    messageId: string
  ) => {
    if (action === 'copy') {
      await copyMessage(chatId, messageId);
    } else if (action === 'resend') {
      // Show confirmation dialog
      const confirmed = await showDestructiveConfirm(
        'Resend Message',
        'This will delete all messages after this one and resend. Continue?',
        'Resend'
      );
      if (confirmed) {
        await resendFromMessage(messageId);
      }
    } else if (action === 'fork') {
      const forkedChat = await forkChat(chatId, messageId);
      if (forkedChat) {
        navigate(`/chat/${forkedChat.id}`);
      }
    } else if (action === 'edit') {
      // Find the message
      const message = messages.find(m => m.id === messageId);
      if (!message) return;

      // Show confirmation using custom dialog (avoids mobile WebView issues with native confirm)
      const confirmed = await showDestructiveConfirm(
        'Edit Message',
        'This will delete this message and all messages after it.',
        'Edit'
      );
      if (confirmed) {
        // Load attachments if the message has any (already processed MessageAttachment[])
        let loadedAttachments: MessageAttachment[] = [];
        if (message.content.attachmentIds?.length) {
          console.debug('[ChatView] Loading attachments for edit:', message.content.attachmentIds);
          loadedAttachments = await gremlinClient.getAttachments(messageId);
          console.debug('[ChatView] Loaded attachments:', loadedAttachments.length);
        }

        // Delete the message and all after it
        await editMessage(chatId, messageId, message.content.content);

        // Strip metadata before setting in input
        const contentWithoutMetadata = stripMetadata(message.content.content);
        setInputMessage(contentWithoutMetadata);

        // Set attachments in state (already processed, no conversion needed)
        setAttachments(loadedAttachments);
      }
    } else if (action === 'delete') {
      // Show confirmation dialog
      const confirmed = await showDestructiveConfirm(
        'Delete Message',
        'This will delete this message and all messages after it.',
        'Delete'
      );
      if (confirmed) {
        // Delete the message and all after it (without populating input)
        await editMessage(chatId, messageId, '');
      }
    }
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
    const hasPendingTools = unresolvedToolCalls && unresolvedToolCalls.length > 0;

    // Allow send with empty input if there are pending tool calls
    if (
      (!messageText && attachments.length === 0 && !hasPendingTools) ||
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

    setInputMessage('');
    setAttachments([]); // Clear attachments
    clearDraft('chatview', chatId); // Clear draft when message is sent

    // Handle pending tool calls: user message triggers reject with the message
    if (hasPendingTools) {
      await resolvePendingToolCalls('stop', messageText || undefined, processedAttachments);
    } else {
      await sendMessage(chatId, messageText, processedAttachments);
    }
  };

  const handleModelSelect = async (apiDefId: string | null, modelId: string | null) => {
    await overrideModel(chatId, apiDefId, modelId);
    setShowModelSelector(false);
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
    <MinionChatOverlayContext.Provider value={{ viewMinionChat: setActiveMinionChatId }}>
      <div className="relative flex h-full flex-col bg-white">
        {/* Header with safe area */}
        <div className="border-b border-gray-200 bg-white">
          <div className="safe-area-inset-top" />
          <div className="flex h-14 items-center px-4">
            <button
              onClick={handleClose}
              className="-ml-2 flex h-11 w-11 items-center justify-center rounded-lg transition-colors hover:bg-gray-100"
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
                {(chat.apiDefinitionId !== null || chat.modelId !== null) && '*'}
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
                onClick={() => setShowViewMenu(prev => !prev)}
                className="flex h-11 w-11 items-center justify-center text-gray-600 hover:text-gray-900"
              >
                <span className="text-xl">⋯</span>
              </button>
              {showViewMenu && (
                <div className="absolute top-full right-0 z-10 mt-1 w-52 rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
                  <button
                    onClick={() => setFocusMode(prev => !prev)}
                    className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100"
                  >
                    <span className="w-5 text-center">{focusMode ? '✓' : ''}</span>
                    <span>Focus Mode</span>
                  </button>
                  <button
                    onClick={() => setExpandMinions(prev => !prev)}
                    className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100"
                  >
                    <span className="w-5 text-center">{expandMinions ? '✓' : ''}</span>
                    <span>Expand Minions</span>
                  </button>
                  <button
                    onClick={() => setDisableMath(prev => !prev)}
                    className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100"
                  >
                    <span className="w-5 text-center">{disableMath ? '✓' : ''}</span>
                    <span>Disable Math</span>
                  </button>
                  <button
                    onClick={() => setAlwaysAutoScroll(prev => !prev)}
                    className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100"
                  >
                    <span className="w-5 text-center">{alwaysAutoScroll ? '✓' : ''}</span>
                    <span>Always Auto Scroll</span>
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
          messages={messages}
          onAction={handleMessageAction}
          isLoading={isLoading}
          streamingGroups={streamingGroups}
          currentApiDefId={currentApiDefId}
          currentModelId={currentModelId}
          pendingToolCount={unresolvedToolCalls?.length}
          onPendingToolReject={() => resolvePendingToolCalls('stop')}
          onPendingToolAccept={() => resolvePendingToolCalls('continue')}
          suspendedAfterTools={showContinueBanner}
          onContinueAfterToolStop={continueAfterToolStop}
          focusMode={focusMode}
          expandMinions={expandMinions}
          disableMath={disableMath}
          alwaysAutoScroll={alwaysAutoScroll}
          dummyHookStatus={dummyHookStatus}
        />

        {/* Incomplete tail banner — chat is locked from continuation until
            the user resolves the partial assistant message left behind by a
            hard abort. The two resolution actions reuse existing message-
            context-menu / message-list flows: Delete removes the incomplete
            message; Roll Back to Last Checkpoint removes everything past the
            last checkpoint. */}
        {isLockedByIncompleteTail && messages.length > 0 && (
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

        {/* Chat Input */}
        <ChatInput
          value={inputMessage}
          onChange={setInputMessage}
          onSend={handleSendMessage}
          disabled={isLoading || isLockedByIncompleteTail}
          attachments={attachments}
          onFilesAdded={handleFilesAdded}
          onRemoveAttachment={handleRemoveAttachment}
          maxAttachments={10}
          isProcessing={isProcessingAttachments}
          showSendSpinner={loopPhase === 'pending'}
          hasPendingToolCalls={!!unresolvedToolCalls && unresolvedToolCalls.length > 0}
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

        {/* Rename Chat Modal */}
        {isRenamingChat && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
            onClick={handleCancelRename}
          >
            <div
              className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl"
              onClick={e => e.stopPropagation()}
            >
              <h2 className="mb-4 text-lg font-semibold text-gray-900">Rename Chat</h2>
              <input
                type="text"
                value={renameChatText}
                onChange={e => setRenameChatText(e.target.value)}
                placeholder="Enter chat name"
                autoFocus
                className="mb-4 w-full rounded-lg border border-gray-300 px-4 py-2 text-base focus:ring-2 focus:ring-blue-500 focus:outline-none"
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    handleSaveRename();
                  } else if (e.key === 'Escape') {
                    handleCancelRename();
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
          </div>
        )}

        {/* Minion Chat Overlay */}
        {activeMinionChatId && (
          <div className="absolute inset-0 z-30 flex flex-col bg-white">
            <MinionChatView
              key={activeMinionChatId}
              minionChatId={activeMinionChatId}
              onClose={() => setActiveMinionChatId(null)}
            />
          </div>
        )}
      </div>
    </MinionChatOverlayContext.Provider>
  );
}
