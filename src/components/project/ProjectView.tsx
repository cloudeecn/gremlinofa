import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import Spinner from '../ui/Spinner';
import { useApp } from '../../hooks/useApp';
import { useProject } from '../../hooks/useProject';
import { getApiDefinitionIcon } from '../../utils/apiTypeUtils';
import type { MessageAttachment, Project } from '../../types';
import { useAlert } from '../../hooks/useAlert';
import { clearDraft, useDraftPersistence } from '../../hooks/useDraftPersistence';
import { processImages } from '../../utils/imageProcessor';
import ModelSelector from './ModelSelector';
import ProjectNameIconModal from './ProjectNameIconModal';
import SystemPromptModal from './SystemPromptModal';

interface ProjectViewProps {
  projectId: string;
  onMenuPress?: () => void;
}

export default function ProjectView({ projectId, onMenuPress }: ProjectViewProps) {
  const navigate = useNavigate();
  const { apiDefinitions } = useApp();
  const { showDestructiveConfirm } = useAlert();

  // Use the project hook
  const {
    project,
    chats,
    isCreatingChat,
    createNewChat,
    deleteChat: deleteProjectChat,
    updateProject,
  } = useProject({
    projectId,
    apiDefinitions,
  });

  // UI state
  const [newChatMessage, setNewChatMessage] = useState('');
  // Store processed attachments (MessageAttachment[]) instead of raw Files
  // This prevents performance issues with large HDR images
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [isProcessingAttachments, setIsProcessingAttachments] = useState(false);
  const [validationError, setValidationError] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const maxAttachments = 10;

  // Draft persistence for new chat message
  useDraftPersistence({
    place: 'project-chat',
    contextId: projectId,
    value: newChatMessage,
    onChange: setNewChatMessage,
  });

  const [showSettings, setShowSettings] = useState(false);
  const [showNameIcon, setShowNameIcon] = useState(false);
  const [showSettingsDropdown, setShowSettingsDropdown] = useState(false);
  const [showSystemPrompt, setShowSystemPrompt] = useState(false);
  const [newChatApiDefId, setNewChatApiDefId] = useState<string | null>(null);
  const [newChatModelId, setNewChatModelId] = useState<string | null>(null);
  const [showNewChatModelSelector, setShowNewChatModelSelector] = useState(false);
  const settingsDropdownRef = useRef<HTMLDivElement>(null);

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

  // Clear validation error after 5 seconds
  useEffect(() => {
    if (validationError) {
      const timer = setTimeout(() => setValidationError(''), 5000);
      return () => clearTimeout(timer);
    }
  }, [validationError]);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!showSettingsDropdown) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (settingsDropdownRef.current && !settingsDropdownRef.current.contains(e.target as Node)) {
        setShowSettingsDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showSettingsDropdown]);

  if (!project) return null;

  // If in settings mode, navigate to settings route
  if (showSettings) {
    navigate(`/project/${projectId}/settings`);
    return null;
  }

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

    setValidationError('');

    // Check total count
    const totalCount = attachments.length + files.length;
    if (totalCount > maxAttachments) {
      setValidationError(
        `Maximum ${maxAttachments} images allowed. You can add ${maxAttachments - attachments.length} more.`
      );
      // Reset input
      e.target.value = '';
      return;
    }

    // Filter for image files only
    const imageFiles = files.filter(file => file.type.startsWith('image/'));
    if (imageFiles.length < files.length) {
      setValidationError('Only image files are allowed');
    }

    if (imageFiles.length > 0) {
      // Process files immediately
      handleFilesAdded(imageFiles);
    }

    // Reset input so same file can be selected again
    e.target.value = '';
  };

  const handleRemoveAttachment = (id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
    setValidationError('');
  };

  const handleStartNewChat = async () => {
    if (
      (!newChatMessage.trim() && attachments.length === 0) ||
      isCreatingChat ||
      isProcessingAttachments
    ) {
      return;
    }

    // Attachments are already processed (MessageAttachment[])
    const processedAttachments = attachments.length > 0 ? attachments : undefined;

    const newChat = await createNewChat(
      newChatMessage.trim(),
      newChatApiDefId,
      newChatModelId,
      processedAttachments
    );

    if (newChat) {
      setNewChatMessage('');
      setAttachments([]);
      setValidationError('');
      clearDraft('project-chat', projectId); // Clear draft when chat is created
      // Reset model override after creating chat
      setNewChatApiDefId(null);
      setNewChatModelId(null);
      // Navigate to chat view - useChat will auto-send the pending message
      void navigate(`/chat/${newChat.id}`);
    }
  };

  const handleDeleteChat = async (chatId: string, chatName: string) => {
    const confirmed = await showDestructiveConfirm(
      'Delete Chat',
      `Delete "${chatName}"?`,
      'Delete'
    );

    if (confirmed) {
      await deleteProjectChat(chatId);
    }
  };

  const handleNewChatModelSelect = (apiDefId: string | null, modelId: string | null) => {
    setNewChatApiDefId(apiDefId);
    setNewChatModelId(modelId);
    setShowNewChatModelSelector(false);
  };

  const handleSystemPromptSave = async (value: string) => {
    await updateProject({ ...project, systemPrompt: value });
    setShowSystemPrompt(false);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header with safe area */}
      <div className="border-b border-gray-200 bg-white">
        <div className="safe-area-inset-top" />
        <div className="flex h-14 items-center px-4">
          {onMenuPress && (
            <button
              onClick={onMenuPress}
              className="flex h-11 w-11 items-center justify-center text-gray-700 hover:text-gray-900 md:hidden"
            >
              <span className="text-2xl">☰</span>
            </button>
          )}
          <div className="flex min-w-0 flex-1 flex-col items-center justify-center">
            <div className="flex items-center gap-1">
              <span className="text-lg">{project.icon || '📁'}</span>
              <h1 className="truncate text-lg font-semibold text-gray-900">{project.name}</h1>
              <button
                onClick={() => setShowNameIcon(true)}
                className="ml-1 flex h-7 w-7 items-center justify-center rounded text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
                title="Edit project name"
              >
                <span className="text-sm">✏️</span>
              </button>
            </div>
            <span className="truncate text-xs text-gray-500">
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
          {/* Settings Dropdown */}
          <div ref={settingsDropdownRef} className="relative">
            <button
              onClick={() => setShowSettingsDropdown(prev => !prev)}
              className="flex h-11 w-11 items-center justify-center text-gray-600 hover:text-gray-900"
            >
              <span className="text-2xl">🔧</span>
            </button>
            {showSettingsDropdown && (
              <div className="absolute top-full right-0 z-10 mt-1 w-48 rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
                <button
                  onClick={() => {
                    setShowSettingsDropdown(false);
                    setShowSettings(true);
                  }}
                  className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100"
                >
                  <span>⚙️</span>
                  <span>Project Settings</span>
                </button>
                <button
                  onClick={() => {
                    setShowSettingsDropdown(false);
                    setShowSystemPrompt(true);
                  }}
                  className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100"
                >
                  <span>📝</span>
                  <span>Project Instructions</span>
                </button>
                <button
                  onClick={() => {
                    setShowSettingsDropdown(false);
                    navigate(`/project/${projectId}/vfs`);
                  }}
                  className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100"
                >
                  <span>📁</span>
                  <span>Files</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Name/Icon Editor Modal */}
      <ProjectNameIconModal
        isOpen={showNameIcon}
        project={project}
        onSave={async (updatedProject: Project) => {
          await updateProject(updatedProject);
          setShowNameIcon(false);
        }}
        onCancel={() => setShowNameIcon(false)}
      />

      {/* System Prompt Modal */}
      <SystemPromptModal
        isOpen={showSystemPrompt}
        projectId={projectId}
        initialValue={project.systemPrompt || ''}
        onSave={handleSystemPromptSave}
        onCancel={() => setShowSystemPrompt(false)}
      />

      {/* New Chat Input Area */}
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
            rows={3}
            className="w-full resize-none rounded-lg border border-gray-300 bg-white px-3 py-2 focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none"
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
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
                isCreatingChat || attachments.length >= maxAttachments || isProcessingAttachments
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

            {/* Send Button */}
            <button
              onClick={handleStartNewChat}
              disabled={
                (!newChatMessage.trim() && attachments.length === 0) ||
                isCreatingChat ||
                isProcessingAttachments
              }
              className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-blue-600 px-6 py-2 font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              {isCreatingChat && <Spinner size={16} colorClass="border-white" />}
              {isCreatingChat ? 'Creating...' : isProcessingAttachments ? 'Processing...' : 'Send'}
            </button>
          </div>
        </div>
      </div>

      {/* Chat List */}
      <div className="ios-scroll scroll-safe-bottom flex-1 overflow-y-auto overscroll-y-contain p-4">
        <h2 className="mb-3 text-base font-semibold text-gray-900">Recent Chats</h2>
        {chats.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <p className="mb-2 text-base text-gray-600">No chats yet</p>
            <p className="text-sm text-gray-500">Start a conversation by typing above</p>
          </div>
        ) : (
          <div className="space-y-3">
            {chats.map(chat => (
              <div
                key={chat.id}
                className="flex gap-3 rounded-lg border border-gray-200 bg-white p-4 transition-colors hover:border-gray-300"
              >
                <div
                  onClick={() => navigate(`/chat/${chat.id}`)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      navigate(`/chat/${chat.id}`);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  className="flex-1 cursor-pointer text-left"
                >
                  <h3 className="mb-1 line-clamp-1 font-semibold text-gray-900">{chat.name}</h3>
                  <p className="text-xs text-gray-600">
                    {chat.lastModifiedAt.toLocaleDateString()}
                    {' • '}
                    {chat.messageCount || 0} msgs
                    {' • '}
                    ctx: {chat.contextWindowUsage || 0}
                    {' • '}${(chat.totalCost || 0).toFixed(4)}
                    {chat.costUnreliable && (
                      <span
                        className="ml-1 text-yellow-600"
                        title="Cost calculation may be inaccurate"
                      >
                        (unreliable)
                      </span>
                    )}
                  </p>
                </div>
                <button
                  onClick={() => handleDeleteChat(chat.id, chat.name)}
                  className="p-2 text-gray-600 transition-colors hover:text-red-600"
                >
                  <span className="text-lg">🗑️</span>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
