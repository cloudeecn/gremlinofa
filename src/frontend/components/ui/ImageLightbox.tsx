import { useEffect, useRef } from 'react';
import { useOverlay } from '../../hooks/useOverlay';

interface ImageLightboxProps {
  /** Image source URL (data: URL or regular URL) */
  src: string;
  /** Alt text for the image */
  alt?: string;
  /** Callback when lightbox is closed */
  onClose: () => void;
}

/**
 * Full-screen lightbox for viewing images.
 * Supports keyboard (Escape to close) and click-outside-to-close.
 */
export default function ImageLightbox({ src, alt = 'Image preview', onClose }: ImageLightboxProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  useOverlay({
    active: true,
    onEscape: onClose,
    containerRef: rootRef,
    trapFocus: true,
    restoreFocus: true,
  });

  // Prevent body scroll while lightbox is open
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  // Handle backdrop click (close if clicking outside image)
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      className="animate-fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/90 outline-none"
      onClick={handleBackdropClick}
    >
      {/* Close button */}
      <button
        onClick={onClose}
        className="absolute top-4 right-4 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
        title="Close (Escape)"
        aria-label="Close"
      >
        <span className="text-2xl">✕</span>
      </button>

      {/* Image container with max dimensions */}
      <div className="animate-scale-in max-h-[90dvh] max-w-[90vw]">
        <img
          src={src}
          alt={alt}
          className="max-h-[90dvh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
        />
      </div>
    </div>
  );
}
