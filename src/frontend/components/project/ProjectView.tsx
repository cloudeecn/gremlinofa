import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  useSyncExternalStore,
} from 'react';
import { useNavigate } from 'react-router-dom';
import Spinner from '../ui/Spinner';
import { useApiDefinitions } from '../../hooks/useApp';
import { useProject } from '../../hooks/useProject';
import { getApiDefinitionIcon } from '../../lib/apiTypeUtils';
import type { Chat, MessageAttachment, Project } from '../../../shared/protocol/types';
import { useAlert } from '../../hooks/useAlert';
import { useImeSafeEnter } from '../../hooks/useImeSafeEnter';
import { useIsTouchDevice } from '../../hooks/useIsTouchDevice';
import { clearDraft, useDraftPersistence } from '../../hooks/useDraftPersistence';
import { useImageDropZone } from '../../hooks/useImageDropZone';
import { clipboardImageFiles, pickImageFiles } from '../../lib/imageFiles';
import { processImages } from '../../lib/imageProcessor';
import { describeLoopStartError } from '../../lib/loopStartError';
import { generateUniqueId } from '../../../shared/protocol/idGenerator';
import { activeLoopsStore, gremlinClient } from '../../client';
import ModelSelector from './ModelSelector';
import ProjectNameIconModal from './ProjectNameIconModal';
import SystemPromptModal from './SystemPromptModal';
import CompactModal from './CompactModal';
import ExportProjectModal from './ExportProjectModal';
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator } from '../ui/DropdownMenu';

// Memoized chat list item to prevent re-renders when parent state changes
const ChatListItem = React.memo(function ChatListItem({
  chat,
  isRunning,
  onNavigate,
  onDelete,
}: {
  chat: Chat;
  /** An agent loop is running on this chat: green breathing border */
  isRunning: boolean;
  onNavigate: (chatId: string) => void;
  onDelete: (chatId: string, chatName: string) => void;
}) {
  return (
    <div
      className={`flex gap-3 rounded-lg border bg-white p-4 transition-colors ${
        isRunning ? 'animate-running-border' : 'border-gray-200 hover:border-gray-300'
      }`}
    >
      <div
        onClick={() => onNavigate(chat.id)}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onNavigate(chat.id);
          }
        }}
        role="button"
        tabIndex={0}
        className="min-w-0 flex-1 cursor-pointer text-left"
      >
        <h3 className="mb-1 truncate font-semibold text-gray-900">{chat.name}</h3>
        {isRunning && <span className="sr-only">Agent loop running.</span>}
        <p className="text-xs text-gray-600">
          {chat.lastModifiedAt.toLocaleDateString()}
          {' • '}
          {chat.messageCount || 0} msgs
          {' • '}
          ctx: {chat.contextWindowUsage || 0}
          {' • '}${(chat.totalCost || 0).toFixed(4)}
          {chat.costUnreliable && (
            <span className="ml-1 text-yellow-600" title="Cost calculation may be inaccurate">
              (unreliable)
            </span>
          )}
        </p>
      </div>
      <button
        onClick={() => onDelete(chat.id, chat.name)}
        className="shrink-0 p-2 text-gray-600 transition-colors hover:text-red-600"
      >
        <span className="text-lg">🗑️</span>
      </button>
    </div>
  );
});

interface ProjectViewProps {
  projectId: string;
  onMenuPress?: () => void;
}

export default function ProjectView({ projectId, onMenuPress }: ProjectViewProps) {
  const navigate = useNavigate();
  const apiDefinitions = useApiDefinitions();
  const { showAlert, showDestructiveConfirm } = useAlert();
  const isTouchDevice = useIsTouchDevice();
  const { onCompositionEnd, isImeEnter } = useImeSafeEnter();

  // Use the project hook
  const {
    project,
    chats,
    createNewChat,
    deleteChat: deleteProjectChat,
    updateProject,
  } = useProject({ projectId });

  const vfsAdapter = useMemo(() => gremlinClient.getVfsAdapter(projectId), [projectId]);

  const activeLoops = useSyncExternalStore(
    activeLoopsStore.subscribe,
    activeLoopsStore.getSnapshot,
    activeLoopsStore.getSnapshot
  );
  const runningChatIds = useMemo(
    () => new Set(activeLoops.map(loop => loop.chatId)),
    [activeLoops]
  );

  // UI state
  const [newChatMessage, setNewChatMessage] = useState('');
  // Store processed attachments (MessageAttachment[]) instead of raw Files
  // This prevents performance issues with large HDR images
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [isProcessingAttachments, setIsProcessingAttachments] = useState(false);
  const [validationError, setValidationError] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const maxAttachments = 10;

  // Covers creating the chat and starting its loop. The ref answers a second
  // Enter that arrives before the state update renders.
  const [isStarting, setIsStarting] = useState(false);
  const isStartingRef = useRef(false);
  const pendingStartRef = useRef<{
    chatId: string;
    /** What was sent: the trimmed text, or the VFS path for send-as-file */
    content: string;
    composerText: string;
    asFile: boolean;
    apiDefId: string | null;
    modelId: string | null;
  } | null>(null);

  // Draft persistence for new chat message
  useDraftPersistence({
    place: 'project-chat',
    contextId: projectId,
    value: newChatMessage,
    onChange: setNewChatMessage,
  });

  const [showNameIcon, setShowNameIcon] = useState(false);
  const [showSystemPrompt, setShowSystemPrompt] = useState(false);
  const [newChatApiDefId, setNewChatApiDefId] = useState<string | null>(null);
  const [newChatModelId, setNewChatModelId] = useState<string | null>(null);
  const [showNewChatModelSelector, setShowNewChatModelSelector] = useState(false);
  const [showCompact, setShowCompact] = useState(false);
  const [showExport, setShowExport] = useState(false);

  // Reset new chat model override when project changes
  useEffect(() => {
    const resetModelOverride = () => {
      setNewChatApiDefId(null);
      setNewChatModelId(null);
    };
    resetModelOverride();
  }, [projectId]);

  // Process files immediately when added (fixes performance with large HDR images)
  const handleFilesAdded = useCallback(
    async (files: File[]) => {
      setIsProcessingAttachments(true);
      try {
        const result = await processImages(files, maxAttachments - attachments.length);

        if (result.errors.length > 0) {
          setValidationError(result.errors.join('; '));
        }

        if (result.attachments.length > 0) {
          setAttachments(prev => [...prev, ...result.attachments]);
          console.debug(
            '[ProjectView] Processed and added attachments:',
            result.attachments.length
          );
        }
      } finally {
        setIsProcessingAttachments(false);
      }
    },
    [attachments.length]
  );

  // One entry for the 📎 picker, pasted images and dropped files
  const addFiles = (files: File[]) => {
    const { images, error } = pickImageFiles(files, attachments.length, maxAttachments);
    setValidationError(error ?? '');
    if (images.length > 0) handleFilesAdded(images);
  };
  const { isDragging, dropZoneProps } = useImageDropZone(addFiles);

  // Clear validation error after 5 seconds
  useEffect(() => {
    if (validationError) {
      const timer = setTimeout(() => setValidationError(''), 5000);
      return () => clearTimeout(timer);
    }
  }, [validationError]);

  // Stable callbacks for memoized ChatListItem
  const handleNavigateToChat = useCallback(
    (chatId: string) => {
      navigate(`/chat/${chatId}`);
    },
    [navigate]
  );

  const handleDeleteChat = useCallback(
    async (chatId: string, chatName: string) => {
      const confirmed = await showDestructiveConfirm(
        'Delete Chat',
        `Delete "${chatName}"?`,
        'Delete'
      );

      if (confirmed) {
        await deleteProjectChat(chatId);
      }
    },
    [showDestructiveConfirm, deleteProjectChat]
  );

  if (!project) return null;

  const handleAttachClick = () => {
    if (attachments.length >= maxAttachments) {
      setValidationError(`Maximum ${maxAttachments} images allowed`);
      return;
    }
    fileInputRef.current?.click();
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    addFiles(files);
    // Reset input so same file can be selected again
    e.target.value = '';
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const images = clipboardImageFiles(e.clipboardData);
    if (images.length === 0) return;
    // Rich copies (a web page) carry text alongside the image: let the text paste too
    if (!e.clipboardData.getData('text/plain')) e.preventDefault();
    addFiles(images);
  };

  const handleRemoveAttachment = (id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
    setValidationError('');
  };

  /**
   * Creates the chat, starts its loop, then opens it. The composer and the
   * model override are cleared only once the loop has started: on failure
   * everything stays, and the chat already created is kept for the retry, so
   * a second attempt doesn't leave another empty chat behind.
   */
  const startNewChat = async (asFile: boolean) => {
    if (isStartingRef.current || isProcessingAttachments) return;
    const composerText = newChatMessage;
    const messageText = composerText.trim();
    if (asFile ? !messageText : !messageText && attachments.length === 0) return;
    const startAttachments = !asFile && attachments.length > 0 ? attachments : undefined;

    isStartingRef.current = true;
    setIsStarting(true);
    try {
      const pending = pendingStartRef.current;
      const retry =
        pending &&
        pending.asFile === asFile &&
        pending.composerText === composerText &&
        pending.apiDefId === newChatApiDefId &&
        pending.modelId === newChatModelId
          ? pending
          : null;

      let chatId: string;
      let content: string;
      if (retry) {
        ({ chatId, content } = retry);
      } else {
        content = messageText;
        if (asFile) {
          content = `/tmp/${generateUniqueId('tmp')}.txt`;
          await vfsAdapter.createFile(content, composerText);
        }
        const newChat = await createNewChat(
          content,
          newChatApiDefId,
          newChatModelId,
          startAttachments
        );
        if (!newChat) return;
        chatId = newChat.id;
        pendingStartRef.current = {
          chatId,
          content,
          composerText,
          asFile,
          apiDefId: newChatApiDefId,
          modelId: newChatModelId,
        };
      }

      // The backend persists the user message and drives the loop; ChatView's
      // `attachChat` subscription picks up its events on mount.
      await gremlinClient.startLoop({
        chatId,
        mode: 'send',
        content,
        attachments: startAttachments,
      });

      pendingStartRef.current = null;
      setNewChatMessage('');
      setAttachments([]);
      setValidationError('');
      clearDraft('project-chat', projectId);
      setNewChatApiDefId(null);
      setNewChatModelId(null);
      void navigate(`/chat/${chatId}`);
    } catch (err) {
      console.debug('[ProjectView] new chat did not start: %o', err);
      void showAlert('Chat not started', describeLoopStartError(err));
    } finally {
      isStartingRef.current = false;
      setIsStarting(false);
    }
  };

  const handleStartNewChat = () => startNewChat(false);
  const handleSendAsFile = () => startNewChat(true);

  const handleNewChatModelSelect = (apiDefId: string | null, modelId: string | null) => {
    setNewChatApiDefId(apiDefId);
    setNewChatModelId(modelId);
    setShowNewChatModelSelector(false);
  };

  const handleSystemPromptSave = async (value: string) => {
    const saved = await updateProject({ systemPrompt: value });
    if (saved) setShowSystemPrompt(false);
    return saved;
  };

  return (
    // The whole page takes dropped images for the new-chat composer, so a drop
    // a few pixels off the textarea doesn't navigate the browser to the file
    <div className="relative flex min-h-0 flex-1 flex-col" {...dropZoneProps}>
      {isDragging && (
        <div className="pointer-events-none absolute inset-0 z-[60] flex items-center justify-center border-4 border-dashed border-blue-400 bg-blue-50/80 text-lg font-medium text-blue-700">
          Drop images to attach
        </div>
      )}
      {/* Header with safe area */}
      <div className="border-b border-gray-200 bg-white">
        <div className="safe-area-inset-top" />
        <div className="flex h-14 items-center px-4">
          {onMenuPress && (
            <button
              onClick={onMenuPress}
              aria-label="Open menu"
              className="flex h-11 w-11 items-center justify-center text-gray-700 hover:text-gray-900 md:hidden"
            >
              <span className="text-2xl">☰</span>
            </button>
          )}
          <div className="flex min-w-0 flex-1 flex-col items-center justify-center">
            <div className="flex max-w-full items-center gap-1">
              <span className="text-lg">{project.icon || '📁'}</span>
              <h1 className="truncate text-lg font-semibold text-gray-900">{project.name}</h1>
              <button
                onClick={() => setShowNameIcon(true)}
                className="ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
                title="Edit project name"
              >
                <span className="text-sm">✏️</span>
              </button>
            </div>
            <span className="max-w-full truncate text-xs text-gray-500">
              {project.modelId
                ? (() => {
                    const apiDef = project.apiDefinitionId
                      ? apiDefinitions.find(d => d.id === project.apiDefinitionId)
                      : null;
                    return apiDef ? getApiDefinitionIcon(apiDef) + ' ' : '';
                  })() + project.modelId
                : 'set default model in project settings →'}
            </span>
          </div>
          <DropdownMenu label="Project menu" icon="🔧">
            <DropdownMenuItem icon="⚙️" onSelect={() => navigate(`/project/${projectId}/settings`)}>
              Project Settings
            </DropdownMenuItem>
            <DropdownMenuItem icon="📝" onSelect={() => setShowSystemPrompt(true)}>
              Project Instructions
            </DropdownMenuItem>
            <DropdownMenuItem icon="📁" onSelect={() => navigate(`/project/${projectId}/vfs`)}>
              Files
            </DropdownMenuItem>
            <DropdownMenuItem icon="🗜️" onSelect={() => setShowCompact(true)}>
              Compact Project
            </DropdownMenuItem>
            <DropdownMenuItem icon="📦" onSelect={() => setShowExport(true)}>
              Export Project
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem icon="🏠" onSelect={() => navigate('/')}>
              Home
            </DropdownMenuItem>
          </DropdownMenu>
        </div>
      </div>

      {/* Name/Icon Editor Modal */}
      <ProjectNameIconModal
        isOpen={showNameIcon}
        project={project}
        onSave={async (updatedProject: Project) => {
          // Only what the modal edits, so a stale copy can't overwrite other fields.
          const saved = await updateProject({
            name: updatedProject.name,
            icon: updatedProject.icon,
          });
          if (saved) setShowNameIcon(false);
        }}
        onCancel={() => setShowNameIcon(false)}
      />

      {/* System Prompt Modal */}
      <SystemPromptModal
        key={project.id}
        isOpen={showSystemPrompt}
        contextId={project.id}
        initialValue={project.systemPrompt || ''}
        onSave={handleSystemPromptSave}
        onCancel={() => setShowSystemPrompt(false)}
      />

      {/* Compact Project Modal */}
      <CompactModal
        isOpen={showCompact}
        onClose={() => setShowCompact(false)}
        projectId={projectId}
      />

      {/* Export Project Modal */}
      <ExportProjectModal
        isOpen={showExport}
        onClose={() => setShowExport(false)}
        projectId={projectId}
        projectName={project.name}
      />

      {/* New Chat Input Area */}
      {!project.apiDefinitionId || !project.modelId ? (
        <div className="border-b border-gray-200 bg-gray-50 p-4">
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <p className="text-sm text-gray-600">No default model configured for this project.</p>
            <button
              onClick={() => navigate(`/project/${projectId}/settings`)}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
            >
              Open Project Settings
            </button>
          </div>
        </div>
      ) : (
        <div className="border-b border-gray-200 bg-gray-50 p-4">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-sm font-medium text-gray-700">Start a new chat</span>
            <span className="text-gray-400">•</span>
            <button
              onClick={() => setShowNewChatModelSelector(true)}
              className="text-sm font-medium text-blue-600 hover:text-blue-700"
            >
              {(() => {
                const apiDefId = newChatApiDefId || project.apiDefinitionId;
                const apiDef = apiDefId ? apiDefinitions.find(d => d.id === apiDefId) : null;
                return apiDef ? getApiDefinitionIcon(apiDef) + ' ' : '';
              })()}
              {newChatModelId || 'default'} ▼
            </button>
          </div>

          {/* Model Selector for New Chat */}
          <ModelSelector
            isOpen={showNewChatModelSelector}
            onClose={() => setShowNewChatModelSelector(false)}
            currentApiDefinitionId={newChatApiDefId}
            currentModelId={newChatModelId}
            parentApiDefinitionId={project.apiDefinitionId}
            parentModelId={project.modelId}
            onSelect={handleNewChatModelSelect}
            title="Select Model for New Chat"
            showResetOption={true}
          />

          <div className="flex flex-col gap-3">
            {/* Hidden File Input */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={handleFileSelect}
              className="hidden"
            />

            {/* Thumbnail Preview Grid - uses processed MessageAttachment data: URLs */}
            {(attachments.length > 0 || isProcessingAttachments) && (
              <div className="flex flex-wrap gap-2">
                {attachments.map(attachment => (
                  <div
                    key={attachment.id}
                    className="relative h-20 w-20 overflow-hidden rounded-lg border border-gray-300"
                  >
                    <img
                      src={`data:${attachment.mimeType};base64,${attachment.data}`}
                      alt="Attachment preview"
                      className="h-full w-full object-cover"
                    />
                    <button
                      onClick={() => handleRemoveAttachment(attachment.id)}
                      className="absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-xs text-white hover:bg-red-600"
                      title="Remove image"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                {/* Processing indicator */}
                {isProcessingAttachments && (
                  <div className="flex h-20 w-20 items-center justify-center rounded-lg border border-gray-300 bg-gray-100">
                    <div className="text-xs text-gray-500">
                      <span className="bouncing-dot">.</span>
                      <span className="bouncing-dot">.</span>
                      <span className="bouncing-dot">.</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Validation Error */}
            {validationError && (
              <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
                {validationError}
              </div>
            )}

            <textarea
              value={newChatMessage}
              onChange={e => setNewChatMessage(e.target.value)}
              placeholder="Type your message here..."
              aria-label="New chat message"
              onPaste={handlePaste}
              readOnly={isStarting}
              rows={3}
              className="w-full resize-none rounded-lg border border-gray-300 bg-white px-3 py-2 text-base focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none"
              onCompositionEnd={onCompositionEnd}
              onKeyDown={e => {
                if (isImeEnter(e)) return;
                if (e.key === 'Enter' && !e.shiftKey && !isTouchDevice) {
                  e.preventDefault();
                  handleStartNewChat();
                }
              }}
            />

            <div className="flex gap-2">
              {/* Attach Button */}
              <button
                onClick={handleAttachClick}
                disabled={
                  isStarting || attachments.length >= maxAttachments || isProcessingAttachments
                }
                className="rounded-lg bg-gray-200 px-4 py-2 font-semibold text-gray-700 transition-colors hover:bg-gray-300 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-400"
                title={
                  attachments.length >= maxAttachments
                    ? `Maximum ${maxAttachments} images`
                    : 'Attach images'
                }
              >
                📎
              </button>

              {/* Send as File Button - only when filesystem tool is enabled */}
              {project.enabledTools?.includes('filesystem') && (
                <button
                  onClick={handleSendAsFile}
                  disabled={!newChatMessage.trim() || isStarting || isProcessingAttachments}
                  className="rounded-lg bg-gray-200 px-4 py-2 font-semibold text-gray-700 transition-colors hover:bg-gray-300 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-400"
                  title="Send text as a VFS file"
                >
                  📄
                </button>
              )}

              {/* Send Button */}
              <button
                onClick={handleStartNewChat}
                disabled={
                  (!newChatMessage.trim() && attachments.length === 0) ||
                  isStarting ||
                  isProcessingAttachments
                }
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-blue-600 px-6 py-2 font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300"
              >
                {isStarting && <Spinner size={16} colorClass="border-white" />}
                {isStarting ? 'Creating...' : isProcessingAttachments ? 'Processing...' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Chat List */}
      <div className="ios-scroll flex-1 overflow-y-auto overscroll-y-contain p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <h2 className="mb-3 text-base font-semibold text-gray-900">Recent Chats</h2>
        {chats.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <p className="mb-2 text-base text-gray-600">No chats yet</p>
            <p className="text-sm text-gray-500">Start a conversation by typing above</p>
          </div>
        ) : (
          <div className="space-y-3">
            {chats.map(chat => (
              <ChatListItem
                key={chat.id}
                chat={chat}
                isRunning={runningChatIds.has(chat.id)}
                onNavigate={handleNavigateToChat}
                onDelete={handleDeleteChat}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
