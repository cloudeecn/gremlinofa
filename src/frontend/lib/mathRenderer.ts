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
 * KaTeX output skips the markdown sanitizer (it needs inline `style`), so cap
 * what a model can make it draw: `maxSize` bounds `\rule` / spacing in em, and
 * `maxExpand` bounds macro expansion.
 */
const RENDER_LIMITS = { maxSize: 20, maxExpand: 1000 };

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
        ...RENDER_LIMITS,
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
        ...RENDER_LIMITS,
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

/** A single letter (a variable) or a plain integer */
const MATH_FULL_MATCHES = /^([a-zA-Z]|[0-9]+)$/;

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
 * @returns true if content might be math (has indicators, a single letter or an integer)
 */
export function hasMathIndicators(content: string): boolean {
  const trimmed = content.trim();

  if (MATH_FULL_MATCHES.test(trimmed)) {
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
