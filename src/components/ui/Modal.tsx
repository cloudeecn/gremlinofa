import React from 'react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  position?: 'center' | 'bottom';
  className?: string;
}

export default function Modal({
  isOpen,
  onClose,
  children,
  size = 'md',
  position = 'center',
  className = '',
}: ModalProps) {
  if (!isOpen) return null;

  const sizeClasses = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
    xl: 'max-w-xl',
    full: 'max-w-full',
  };

  const positionClasses = {
    center: 'items-center justify-center',
    bottom: 'items-end justify-center md:items-center',
  };

  const contentAnimationClasses = {
    center: 'animate-in fade-in zoom-in-95 duration-300',
    bottom: 'animate-in slide-in-from-bottom md:fade-in md:zoom-in-95 duration-300',
  };

  return (
    <div
      className={`fixed inset-0 z-50 flex ${positionClasses[position]} animate-in fade-in p-4 duration-300`}
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="bg-opacity-50 absolute inset-0 bg-black" />

      {/* Modal content */}
      <div
        className={`relative w-full ${sizeClasses[size]} ${
          position === 'bottom' ? 'md:max-w-2xl' : ''
        } ${contentAnimationClasses[position]} ${className}`}
        onClick={e => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
