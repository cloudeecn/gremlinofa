import React, { useState } from 'react';
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

export default function ProjectNameIconModal({
  isOpen,
  project,
  onSave,
  onCancel,
}: ProjectNameIconModalProps) {
  // Initialize state from props - reset when modal opens
  const [name, setName] = useState(project.name);
  const [icon, setIcon] = useState(project.icon || '📁');

  // Reset state when modal opens
  const handleModalOpen = () => {
    if (isOpen) {
      setName(project.name);
      setIcon(project.icon || '📁');
    }
  };

  React.useEffect(handleModalOpen, [isOpen, project.name, project.icon]);

  const handleSave = () => {
    // Validate required fields
    if (!name.trim()) {
      showAlert('Validation Error', 'Project name is required');
      return;
    }

    const updatedProject: Project = {
      ...project,
      name: name.trim(),
      icon,
      lastUsedAt: new Date(),
    };

    onSave(updatedProject);
  };

  return (
    <Modal isOpen={isOpen} onClose={onCancel} size="lg" position="bottom">
      <div className="flex max-h-[75vh] flex-col rounded-t-2xl bg-white md:max-h-[600px] md:rounded-2xl">
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
          {/* Project Name */}
          <div className="mb-6">
            <label className="mb-2 block text-sm font-semibold text-gray-900">Project Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Enter project name"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none"
            />
          </div>

          {/* Project Icon */}
          <div className="mb-6">
            <label className="mb-2 block text-sm font-semibold text-gray-900">Project Icon</label>
            <div className="grid grid-cols-8 gap-2">
              {PROJECT_EMOJIS.map(emoji => (
                <button
                  key={emoji}
                  onClick={() => setIcon(emoji)}
                  className={`flex h-12 w-12 items-center justify-center rounded-lg border-2 text-2xl transition-colors ${
                    icon === emoji
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
            className="flex-1 rounded-lg border border-gray-300 px-4 py-3 font-semibold text-gray-700 transition-colors hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="flex-1 rounded-lg bg-blue-600 px-4 py-3 font-semibold text-white transition-colors hover:bg-blue-700"
          >
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}
