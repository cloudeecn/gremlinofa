import React, { useEffect } from 'react';

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
  // [iOS-diag] Trace modal lifecycle to confirm no stray overlay outlives close.
  useEffect(() => {
    if (!isOpen) return;
    console.debug('[Modal] mount size=%s position=%s', size, position);
    return () => console.debug('[Modal] unmount');
  }, [isOpen, size, position]);

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
    center: 'animate-scale-in',
    bottom: 'animate-slide-up md:animate-scale-in',
  };

  // The outer div is NOT a click target. The dedicated backdrop below is the
  // close-on-click surface — keeping that responsibility on a visible element
  // avoids the iOS Safari failure mode where a `fixed inset-0` overlay drifts
  // past the visual viewport after a keyboard transition but still captures
  // pointer events at stale layout-viewport coordinates.
  return (
    <div
      className={`animate-fade-in fixed inset-0 z-50 flex ${positionClasses[position]} safe-area-inset-bottom p-4`}
    >
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div
        className={`relative w-full ${sizeClasses[size]} ${
          position === 'bottom' ? 'md:max-w-2xl' : ''
        } ${contentAnimationClasses[position]} ${className}`}
      >
        {children}
      </div>
    </div>
  );
}
