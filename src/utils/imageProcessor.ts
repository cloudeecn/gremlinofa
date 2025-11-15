import { generateUniqueId } from './idGenerator';
import type { MessageAttachment } from '../types';

const MAX_IMAGE_DIMENSION = 1920;
const MAX_FILE_SIZE_AFTER_COMPRESSION = 1024 * 1024; // 1MB
const COMPRESSION_THRESHOLD = 500 * 1024; // 500KB
const JPEG_QUALITY = 0.85;

interface ProcessImageResult {
  attachment: MessageAttachment | null;
  error?: string;
}

/**
 * Convert File to base64 string without processing
 */
async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Remove data URL prefix (e.g., "data:image/png;base64,")
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = () => {
      reject(new Error('Failed to read file'));
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Load an image file and return an HTMLImageElement
 */
async function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image'));
    };

    img.src = url;
  });
}

/**
 * Resize image if needed and return canvas
 */
function resizeImage(img: HTMLImageElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  let { width, height } = img;

  // Check if resizing is needed
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    if (width > height) {
      height = (height / width) * MAX_IMAGE_DIMENSION;
      width = MAX_IMAGE_DIMENSION;
    } else {
      width = (width / height) * MAX_IMAGE_DIMENSION;
      height = MAX_IMAGE_DIMENSION;
    }
  }

  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to get canvas context');
  }

  ctx.drawImage(img, 0, 0, width, height);
  return canvas;
}

/**
 * Convert canvas to base64 with specified format and quality
 */
function canvasToBase64(canvas: HTMLCanvasElement, mimeType: string, quality?: number): string {
  const dataUrl = canvas.toDataURL(mimeType, quality);
  // Remove data URL prefix (e.g., "data:image/png;base64,")
  return dataUrl.split(',')[1];
}

/**
 * Get base64 size in bytes (approximate)
 */
function getBase64Size(base64: string): number {
  // Base64 adds ~33% overhead, but padding affects exact size
  return Math.ceil((base64.length * 3) / 4);
}

/**
 * Process an image file: resize, compress if needed, and return MessageAttachment
 *
 * Processing pipeline:
 * 1. Load image
 * 2. Resize if > 1920px on any side
 * 3. Convert to base64
 * 4. If > 500KB, try JPEG compression
 * 5. If PNG becomes larger after JPEG conversion, keep PNG
 * 6. Validate final size <= 1MB
 */
export async function processImage(file: File): Promise<ProcessImageResult> {
  try {
    // Validate file type
    if (!file.type.match(/^image\/(jpeg|png|gif|webp)$/)) {
      return {
        attachment: null,
        error: 'Unsupported image format. Please use JPEG, PNG, GIF, or WebP.',
      };
    }

    // Early bypass: use original file if it's JPG/PNG and under threshold
    if (
      (file.type === 'image/jpeg' || file.type === 'image/png') &&
      file.size < COMPRESSION_THRESHOLD
    ) {
      console.debug(
        `[imageProcessor] Using original file (${file.type}, ${(file.size / 1024).toFixed(1)}KB) - no processing needed`
      );

      const base64 = await fileToBase64(file);

      return {
        attachment: {
          id: generateUniqueId('att'),
          type: 'image',
          mimeType: file.type as MessageAttachment['mimeType'],
          data: base64,
        },
      };
    }

    // Load and resize image
    const img = await loadImage(file);
    const canvas = resizeImage(img);

    // Get original MIME type
    const originalMimeType = file.type as MessageAttachment['mimeType'];

    // First attempt: convert to original format
    const originalBase64 = canvasToBase64(canvas, originalMimeType);
    const originalSize = getBase64Size(originalBase64);

    console.debug(
      `[imageProcessor] Original format: ${originalMimeType}, size: ${(originalSize / 1024).toFixed(1)}KB`
    );

    // If size is acceptable, use original format
    if (originalSize <= COMPRESSION_THRESHOLD) {
      if (originalSize > MAX_FILE_SIZE_AFTER_COMPRESSION) {
        return {
          attachment: null,
          error: `Image too large (${(originalSize / 1024).toFixed(1)}KB). Maximum size is 1MB.`,
        };
      }

      return {
        attachment: {
          id: generateUniqueId('att'),
          type: 'image',
          mimeType: originalMimeType,
          data: originalBase64,
        },
      };
    }

    // Try JPEG compression if over threshold
    const jpegBase64 = canvasToBase64(canvas, 'image/jpeg', JPEG_QUALITY);
    const jpegSize = getBase64Size(jpegBase64);

    console.debug(`[imageProcessor] JPEG compressed size: ${(jpegSize / 1024).toFixed(1)}KB`);

    // Choose smaller version (only use JPEG if it's actually smaller)
    const useJpeg = jpegSize < originalSize;
    const finalBase64 = useJpeg ? jpegBase64 : originalBase64;
    const finalSize = useJpeg ? jpegSize : originalSize;
    const finalMimeType = useJpeg ? 'image/jpeg' : originalMimeType;

    console.debug(
      `[imageProcessor] Using ${finalMimeType}, final size: ${(finalSize / 1024).toFixed(1)}KB`
    );

    // Validate final size
    if (finalSize > MAX_FILE_SIZE_AFTER_COMPRESSION) {
      return {
        attachment: null,
        error: `Image too large after compression (${(finalSize / 1024).toFixed(1)}KB). Maximum size is 1MB.`,
      };
    }

    return {
      attachment: {
        id: generateUniqueId('att'),
        type: 'image',
        mimeType: finalMimeType,
        data: finalBase64,
      },
    };
  } catch (error) {
    console.error('[imageProcessor] Failed to process image:', error);
    return {
      attachment: null,
      error: error instanceof Error ? error.message : 'Failed to process image',
    };
  }
}

/**
 * Process multiple images with a maximum limit
 */
export async function processImages(
  files: File[],
  maxImages: number = 10
): Promise<{
  attachments: MessageAttachment[];
  errors: string[];
}> {
  const attachments: MessageAttachment[] = [];
  const errors: string[] = [];

  // Limit number of files
  const filesToProcess = files.slice(0, maxImages);

  if (files.length > maxImages) {
    errors.push(`Only the first ${maxImages} images will be attached.`);
  }

  // Process each file
  for (const file of filesToProcess) {
    const result = await processImage(file);

    if (result.attachment) {
      attachments.push(result.attachment);
    } else if (result.error) {
      errors.push(`${file.name}: ${result.error}`);
    }
  }

  return { attachments, errors };
}
