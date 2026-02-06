import React, { useEffect, useState } from 'react';

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
  const [vpRect, setVpRect] = useState<{ top: number; height: number } | null>(null);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => setVpRect({ top: vv.offsetTop, height: vv.height });
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    update();

    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

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

  return (
    <div
      className={`animate-fade-in fixed inset-0 z-50 flex ${positionClasses[position]} p-4`}
      style={vpRect ? { top: vpRect.top, height: vpRect.height, bottom: 'auto' } : undefined}
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" />

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
