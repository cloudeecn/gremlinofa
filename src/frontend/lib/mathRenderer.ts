/**
 * Math rendering abstraction layer.
 * Provides a swappable interface for rendering LaTeX math expressions.
 * Currently uses KaTeX, but can be swapped to MathJax or other libraries.
 */

import katex from 'katex';

/**
 * Interface for math rendering implementations.
 * Implement this interface to swap out the math rendering library.
 */
export interface MathRenderer {
  /**
   * Render inline math (e.g., $E=mc^2$)
   * @param latex - The LaTeX expression without delimiters
   * @returns HTML string of rendered math
   */
  renderInline(latex: string): string;

  /**
   * Render display math (e.g., $$\int_0^1 x dx$$)
   * @param latex - The LaTeX expression without delimiters
   * @returns HTML string of rendered math
   */
  renderDisplay(latex: string): string;
}

/**
 * KaTeX implementation of MathRenderer.
 * Fast, lightweight, and handles most common LaTeX math.
 */
export const katexRenderer: MathRenderer = {
  renderInline: (latex: string): string => {
    try {
      return katex.renderToString(latex, {
        displayMode: false,
        throwOnError: false,
        errorColor: '#cc0000',
        strict: false,
        trust: false,
        output: 'html',
      });
    } catch {
      // Fallback: show the original LaTeX in a styled span
      return `<span class="math-error" title="Failed to render LaTeX">$${escapeHtml(latex)}$</span>`;
    }
  },

  renderDisplay: (latex: string): string => {
    try {
      return katex.renderToString(latex, {
        displayMode: true,
        throwOnError: false,
        errorColor: '#cc0000',
        strict: false,
        trust: false,
        output: 'html',
      });
    } catch {
      // Fallback: show the original LaTeX in a styled span
      return `<span class="math-error" title="Failed to render LaTeX">$$${escapeHtml(latex)}$$</span>`;
    }
  },
};

/**
 * Currently active math renderer.
 * Change this to swap out the math rendering library.
 */
export const mathRenderer: MathRenderer = katexRenderer;

/**
 * Helper to escape HTML for fallback display
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Represents an extracted math block with its placeholder.
 */
export interface MathBlock {
  /** Unique placeholder string to insert in text */
  placeholder: string;
  /** The LaTeX expression (without delimiters) */
  latex: string;
  /** Whether this is display mode ($$) or inline ($) */
  displayMode: boolean;
}

const MATH_FULL_MATCHES = /^([a-zA-Z]|(0-9)+)$/;

/**
 * Pattern to detect math/LaTeX indicator characters (excluding minus).
 * If content contains ANY of these, it might be math and should be validated.
 * Characters: \ { } ^ _ + * / = ( ) [ ] & % # ~ < >
 * Note: Minus (-) is checked separately with context (must be followed by space/digit/dot)
 */
const MATH_INDICATORS = /[\\{}^_+*/=()[\]&%#~<>]/;

/**
 * Pattern for minus sign in math context.
 * Minus counts as math indicator only if followed by:
 * - Space: `a - b` (binary minus)
 * - Digit: `-2` (negative number)
 * - Dot: `-.5` (negative decimal)
 * This rejects hyphens in words like "well-known" or "x-y"
 */
const MATH_MINUS = /-( |[0-9]|\.)/;

/**
 * Check if content has math indicator characters.
 * This is an inverted bailout: if NO indicators, it's definitely not math.
 *
 * @param content - The content between $ delimiters
 * @returns true if content might be math (has indicators or is single char)
 */
export function hasMathIndicators(content: string): boolean {
  const trimmed = content.trim();

  // Single characters, all numbers
  if (MATH_FULL_MATCHES.test(content)) {
    return true;
  }

  // Has any math/LaTeX indicator character (excluding minus)?
  if (MATH_INDICATORS.test(trimmed)) {
    return true;
  }

  // Check for minus in math context (followed by space, digit, or dot)
  return MATH_MINUS.test(trimmed);
}

/**
 * Validate if a string is valid LaTeX using KaTeX parser.
 * Used as second-stage validation after indicator check.
 */
export function isValidLatex(latex: string): boolean {
  try {
    katex.renderToString(latex, { throwOnError: true, strict: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if content should be extracted as math.
 * Two-stage validation:
 * 1. Quick check for math indicators (fast bailout if none)
 * 2. KaTeX validation for remaining candidates (accurate)
 */
export function shouldExtractAsMath(content: string): boolean {
  const trimmed = content.trim();

  // Early bailout: citation links are not math
  if (trimmed.includes('<a href=')) {
    return false;
  }

  // Stage 1: Must have math indicators (or be single char)
  if (!hasMathIndicators(trimmed)) {
    return false;
  }

  // Stage 2: Validate with KaTeX
  return isValidLatex(trimmed);
}

/**
 * Find the next unescaped $ in text starting from position.
 * Skips escaped \$ sequences.
 *
 * @param text - The text to search
 * @param start - Starting position
 * @returns Position of $ or -1 if not found
 */
function findUnescapedDollar(text: string, start: number): number {
  for (let i = start; i < text.length; i++) {
    if (text[i] === '$') {
      // Check if escaped (preceded by \)
      if (i > 0 && text[i - 1] === '\\') {
        continue;
      }
      return i;
    }
  }
  return -1;
}

/**
 * Extract math expressions from text, replacing them with placeholders.
 * This protects math from markdown processing.
 *
 * Uses try-and-skip algorithm for inline math:
 * - Find first $, find second $
 * - If content is valid math, extract it and continue after second $
 * - If content is NOT valid, skip first $ and try again from first $ + 1
 *
 * This correctly handles cases like "$1.5, $(real math)$" by skipping
 * the invalid "$1.5, $" and finding the valid "$(real math)$".
 *
 * @param text - The input text containing math expressions
 * @returns Object with processed text and extracted blocks
 */
export function extractMath(text: string): { processed: string; blocks: MathBlock[] } {
  const blocks: MathBlock[] = [];
  let id = 0;

  // Step 1: Extract display math ($$...$$) first
  // Uses regex since $$ is less ambiguous than single $
  let processed = text.replace(/\$\$([\s\S]+?)\$\$/g, (match, latex: string) => {
    const trimmed = latex.trim();
    // Validate display math
    if (!isValidLatex(trimmed)) {
      return match; // Leave original text unchanged
    }
    const placeholder = `%%MATH_DISPLAY_${id}%%`;
    blocks.push({
      placeholder,
      latex: trimmed,
      displayMode: true,
    });
    id++;
    return placeholder;
  });

  // Step 2: Extract inline math ($...$) using try-and-skip algorithm
  // This handles cases like "$1.5, $(x^2)$" correctly
  const extractedRanges: Array<{ start: number; end: number; placeholder: string }> = [];
  let pos = 0;

  while (pos < processed.length) {
    // Find first unescaped $
    const firstDollar = findUnescapedDollar(processed, pos);
    if (firstDollar === -1) break;

    // Skip if this is part of $$ (already handled)
    if (processed[firstDollar + 1] === '$') {
      pos = firstDollar + 2;
      continue;
    }

    // Find second unescaped $ (closing)
    const secondDollar = findUnescapedDollar(processed, firstDollar + 1);
    if (secondDollar === -1) break;

    // Skip if second $ is part of $$ or if there's a newline between
    if (processed[secondDollar + 1] === '$') {
      pos = firstDollar + 1;
      continue;
    }

    const content = processed.slice(firstDollar + 1, secondDollar);

    // No newlines allowed in inline math
    if (content.includes('\n')) {
      pos = firstDollar + 1;
      continue;
    }

    const trimmed = content.trim();

    // Try to extract as math
    if (shouldExtractAsMath(trimmed)) {
      // Valid math - record this extraction
      const placeholder = `%%MATH_INLINE_${id}%%`;
      blocks.push({
        placeholder,
        latex: trimmed,
        displayMode: false,
      });
      extractedRanges.push({
        start: firstDollar,
        end: secondDollar,
        placeholder,
      });
      id++;
      // Continue after the second $
      pos = secondDollar + 1;
    } else {
      // Not valid math - skip only the first $ and try again
      // This allows "$1.5, $(x^2)$" to find the valid math
      pos = firstDollar + 1;
    }
  }

  // Apply extractions in reverse order to preserve indices
  for (let i = extractedRanges.length - 1; i >= 0; i--) {
    const { start, end, placeholder } = extractedRanges[i];
    processed = processed.slice(0, start) + placeholder + processed.slice(end + 1);
  }

  return { processed, blocks };
}

/**
 * Restore math blocks by replacing placeholders with rendered HTML.
 *
 * @param html - The HTML string containing placeholders
 * @param blocks - The math blocks to restore
 * @param renderer - The math renderer to use (defaults to active renderer)
 * @returns HTML string with rendered math
 */
export function restoreMath(
  html: string,
  blocks: MathBlock[],
  renderer: MathRenderer = mathRenderer
): string {
  let result = html;

  for (const block of blocks) {
    const rendered = block.displayMode
      ? renderer.renderDisplay(block.latex)
      : renderer.renderInline(block.latex);

    result = result.replace(block.placeholder, rendered);
  }

  return result;
}

/**
 * Process text with math extraction and restoration.
 * Convenience function that combines extract and restore.
 *
 * @param text - Input text with LaTeX math
 * @param markdownProcessor - Function to process the text (e.g., marked.parse)
 * @param renderer - Math renderer to use
 * @returns Processed HTML with rendered math
 */
export function processWithMath(
  text: string,
  markdownProcessor: (text: string) => string,
  renderer: MathRenderer = mathRenderer
): string {
  const { processed, blocks } = extractMath(text);
  const html = markdownProcessor(processed);
  return restoreMath(html, blocks, renderer);
}
