import React, { useState, useCallback } from 'react';
import Spinner from '../ui/Spinner';
import Modal from '../ui/Modal';
import type { Project } from '../../types';
import { PROJECT_EMOJIS } from '../../constants/emojis';
import { showAlert } from '../../utils/alerts';

interface ProjectNameIconModalProps {
  isOpen: boolean;
  project: Project;
  onSave: (updatedProject: Project) => void;
  onCancel: () => void;
}

const DEFAULT_ICON = '📁';

export default function ProjectNameIconModal({
  isOpen,
  project,
  onSave,
  onCancel,
}: ProjectNameIconModalProps) {
  // Initialize state from props - reset when modal opens
  const [name, setName] = useState(project.name);
  // Store empty string if using default, so placeholder shows
  const [icon, setIcon] = useState(project.icon === DEFAULT_ICON ? '' : project.icon || '');
  const [isSaving, setIsSaving] = useState(false);

  // Reset state when modal opens
  const handleModalOpen = () => {
    if (isOpen) {
      setName(project.name);
      // Show empty input (with placeholder) when using default icon
      setIcon(project.icon === DEFAULT_ICON ? '' : project.icon || '');
    }
  };

  React.useEffect(handleModalOpen, [isOpen, project.name, project.icon]);

  // Effective icon for display and comparison (empty → default)
  const effectiveIcon = icon.trim() || DEFAULT_ICON;

  const handleSave = useCallback(async () => {
    // Validate required fields
    if (!name.trim()) {
      showAlert('Validation Error', 'Project name is required');
      return;
    }

    setIsSaving(true);
    try {
      const updatedProject: Project = {
        ...project,
        name: name.trim(),
        icon: effectiveIcon,
        lastUsedAt: new Date(),
      };

      await onSave(updatedProject);
    } finally {
      setIsSaving(false);
    }
  }, [name, effectiveIcon, project, onSave]);

  return (
    <Modal isOpen={isOpen} onClose={onCancel} size="lg" position="bottom">
      <div className="flex max-h-[75dvh] flex-col rounded-t-2xl bg-white md:max-h-[600px] md:rounded-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 p-4">
          <h2 className="text-lg font-semibold text-gray-900">Edit Project</h2>
          <button
            onClick={onCancel}
            className="flex h-11 w-11 items-center justify-center text-gray-600 transition-colors hover:text-gray-900"
          >
            <span className="text-2xl leading-none">✕</span>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {/* Project Name with Emoji Input */}
          <div className="mb-6">
            <label className="mb-2 block text-sm font-semibold text-gray-900">Project Name</label>
            <div className="flex gap-2">
              {/* Emoji input */}
              <input
                type="text"
                value={icon}
                onChange={e => setIcon(e.target.value)}
                placeholder={DEFAULT_ICON}
                maxLength={3}
                className="w-12 shrink-0 rounded-lg border border-gray-300 text-center text-2xl focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none"
              />
              {/* Name input */}
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Enter project name"
                className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2 text-base focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none"
              />
            </div>
          </div>

          {/* Icon Picker */}
          <div className="mb-6">
            <label className="mb-2 block text-sm font-semibold text-gray-900">Pick an icon</label>
            <div className="grid grid-cols-8 gap-2">
              {PROJECT_EMOJIS.map(emoji => (
                <button
                  key={emoji}
                  onClick={() => setIcon(emoji === DEFAULT_ICON ? '' : emoji)}
                  className={`flex h-12 w-12 items-center justify-center rounded-lg border-2 text-2xl transition-colors ${
                    effectiveIcon === emoji
                      ? 'border-blue-500 bg-blue-50'
                      : 'border-transparent bg-white hover:bg-gray-50'
                  }`}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex gap-3 rounded-b-2xl border-t border-gray-200 bg-white p-4">
          <button
            onClick={onCancel}
            disabled={isSaving}
            className="flex-1 rounded-lg border border-gray-300 px-4 py-3 font-semibold text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-3 font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-400"
          >
            {isSaving && <Spinner size={16} colorClass="border-white" />}
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}
