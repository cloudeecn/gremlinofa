import { generateUniqueId } from '../../shared/protocol/idGenerator';
import type { MessageAttachment } from '../../shared/protocol/types';

const MAX_IMAGE_DIMENSION = 1920;
const MAX_FILE_SIZE_AFTER_COMPRESSION = 1024 * 1024; // 1MB
const COMPRESSION_THRESHOLD = 500 * 1024; // 500KB
const JPEG_QUALITY = 0.85;

type AttachmentMimeType = MessageAttachment['mimeType'];
const ATTACHMENT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const satisfies readonly AttachmentMimeType[];

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

interface EncodedImage {
  mimeType: AttachmentMimeType;
  base64: string;
  /** Decoded size in bytes (approximate: ignores base64 padding) */
  size: number;
}

/**
 * Encode the canvas, labeling the bytes with the type the browser actually produced.
 * `toDataURL` silently falls back to PNG for formats it can't encode (GIF in every
 * browser, WebP on older Safari), so the requested type can't be trusted.
 */
function encodeCanvas(canvas: HTMLCanvasElement, mimeType: string, quality?: number): EncodedImage {
  let dataUrl = canvas.toDataURL(mimeType, quality);
  let producedType = dataUrlMimeType(dataUrl);
  if (!isAttachmentMimeType(producedType)) {
    console.debug(
      '[imageProcessor] Canvas produced %o for %s, re-encoding as PNG',
      producedType,
      mimeType
    );
    dataUrl = canvas.toDataURL('image/png');
    producedType = dataUrlMimeType(dataUrl);
    if (!isAttachmentMimeType(producedType)) {
      throw new Error('Failed to encode image');
    }
  }
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return { mimeType: producedType, base64, size: Math.ceil((base64.length * 3) / 4) };
}

/** "data:image/png;base64,..." -> "image/png"; "" for an empty canvas ("data:,") */
function dataUrlMimeType(dataUrl: string): string {
  const header = dataUrl.slice('data:'.length, dataUrl.indexOf(','));
  return header.split(';')[0];
}

function isAttachmentMimeType(mimeType: string): mimeType is AttachmentMimeType {
  return (ATTACHMENT_MIME_TYPES as readonly string[]).includes(mimeType);
}

const toKb = (bytes: number) => (bytes / 1024).toFixed(1);

/**
 * Process an image file: resize, compress if needed, and return MessageAttachment
 *
 * Processing pipeline:
 * 1. Any supported file under 500KB is sent as-is (keeps GIF animation and the
 *    original bytes; the canvas can't encode GIF at all)
 * 2. Otherwise load it, resize if > 1920px on any side, and re-encode in the
 *    original format (or whatever the browser falls back to)
 * 3. If still > 500KB, try JPEG and keep whichever is smaller
 * 4. Validate final size <= 1MB
 */
export async function processImage(file: File): Promise<ProcessImageResult> {
  try {
    if (!isAttachmentMimeType(file.type)) {
      return {
        attachment: null,
        error: 'Unsupported image format. Please use JPEG, PNG, GIF, or WebP.',
      };
    }

    if (file.size < COMPRESSION_THRESHOLD) {
      console.debug(
        '[imageProcessor] Using original file (%s, %sKB) - no processing needed',
        file.type,
        toKb(file.size)
      );

      return {
        attachment: {
          id: generateUniqueId('att'),
          type: 'image',
          mimeType: file.type,
          data: await fileToBase64(file),
        },
      };
    }

    const img = await loadImage(file);
    const canvas = resizeImage(img);

    const reencoded = encodeCanvas(canvas, file.type);
    console.debug(
      '[imageProcessor] Re-encoded %s as %s, size: %sKB',
      file.type,
      reencoded.mimeType,
      toKb(reencoded.size)
    );

    let encoded = reencoded;
    if (reencoded.size > COMPRESSION_THRESHOLD) {
      const jpeg = encodeCanvas(canvas, 'image/jpeg', JPEG_QUALITY);
      console.debug('[imageProcessor] JPEG compressed size: %sKB', toKb(jpeg.size));
      if (jpeg.size < reencoded.size) encoded = jpeg;
    }

    console.debug(
      '[imageProcessor] Using %s, final size: %sKB',
      encoded.mimeType,
      toKb(encoded.size)
    );

    if (encoded.size > MAX_FILE_SIZE_AFTER_COMPRESSION) {
      return {
        attachment: null,
        error: `Image too large after compression (${toKb(encoded.size)}KB). Maximum size is 1MB.`,
      };
    }

    return {
      attachment: {
        id: generateUniqueId('att'),
        type: 'image',
        mimeType: encoded.mimeType,
        data: encoded.base64,
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
