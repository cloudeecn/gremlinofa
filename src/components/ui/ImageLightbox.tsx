import { useEffect, useCallback } from 'react';

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
  // Handle keyboard events
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    },
    [onClose]
  );

  // Add keyboard listener on mount
  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    // Prevent body scroll while lightbox is open
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [handleKeyDown]);

  // Handle backdrop click (close if clicking outside image)
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div
      className="animate-fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/90"
      onClick={handleBackdropClick}
    >
      {/* Close button */}
      <button
        onClick={onClose}
        className="absolute top-4 right-4 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
        title="Close (Escape)"
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
