import React, { useRef } from 'react';
import { useOverlay } from '../../hooks/useOverlay';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | 'full';
  position?: 'center' | 'bottom';
  className?: string;
  /** Accessible name for the dialog when its content has no obvious title. */
  ariaLabel?: string;
}

export default function Modal({
  isOpen,
  onClose,
  children,
  size = 'md',
  position = 'center',
  className = '',
  ariaLabel,
}: ModalProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  useOverlay({
    active: isOpen,
    onEscape: onClose,
    containerRef: contentRef,
    trapFocus: true,
    restoreFocus: true,
  });

  if (!isOpen) return null;

  const sizeClasses = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
    xl: 'max-w-xl',
    '2xl': 'max-w-2xl',
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
      className={`animate-fade-in fixed inset-0 z-50 flex ${positionClasses[position]} p-4 pb-[max(1rem,env(safe-area-inset-bottom))]`}
    >
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div
        ref={contentRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        className={`relative w-full outline-none ${sizeClasses[size]} ${
          position === 'bottom' ? 'md:max-w-2xl' : ''
        } ${contentAnimationClasses[position]} ${className}`}
      >
        {children}
      </div>
    </div>
  );
}
