import DOMPurify from 'dompurify';
import { marked, type Tokens, type TokenizerExtension, type RendererExtension } from 'marked';
import hljs from 'highlight.js';
import { mathRenderer, shouldExtractAsMath, isValidLatex } from './mathRenderer';

// Custom renderer for code blocks with syntax highlighting
const renderer = new marked.Renderer();

renderer.code = ({ text, lang }: Tokens.Code) => {
  // Apply syntax highlighting
  let highlighted: string;
  if (lang && hljs.getLanguage(lang)) {
    try {
      highlighted = hljs.highlight(text, { language: lang }).value;
    } catch {
      highlighted = escapeHtml(text);
    }
  } else {
    // Auto-detect language if not specified
    try {
      highlighted = hljs.highlightAuto(text).value;
    } catch {
      highlighted = escapeHtml(text);
    }
  }

  // Build element tree using DOM APIs for safe escaping
  const wrapper = document.createElement('div');
  wrapper.className = 'code-block-container';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'code-copy-button';
  copyBtn.type = 'button';
  copyBtn.setAttribute('aria-label', 'Copy code');
  copyBtn.textContent = '📋';
  copyBtn.dataset.code = text; // DOM handles escaping automatically

  const pre = document.createElement('pre');
  const code = document.createElement('code');
  if (lang) code.className = `language-${lang}`;
  code.innerHTML = highlighted; // Already safe from hljs

  pre.appendChild(code);
  wrapper.appendChild(copyBtn);
  wrapper.appendChild(pre);

  return wrapper.outerHTML;
};

// ============================================================================
// Math Extensions for marked
// ============================================================================

/**
 * Find next unescaped $ in text starting from position.
 */
function findUnescapedDollar(text: string, start: number): number {
  for (let i = start; i < text.length; i++) {
    if (text[i] === '$') {
      if (i > 0 && text[i - 1] === '\\') {
        continue;
      }
      return i;
    }
  }
  return -1;
}

/**
 * Find the next $$ that is a valid display math delimiter.
 * Must NOT be:
 * - Part of $$$+ run (has $ immediately before or after)
 * - Starting with an escaped $ (preceded by \)
 * Returns -1 if no valid $$ found.
 */
function findIsolatedDoubleDollar(src: string, startPos: number = 0): number {
  let pos = startPos;
  while (pos < src.length) {
    const idx = src.indexOf('$$', pos);
    if (idx === -1) return -1;

    // Check if this $$ is part of $$$+ (has $ immediately before or after)
    const hasDollarBefore = idx > 0 && src[idx - 1] === '$';
    const hasDollarAfter = src[idx + 2] === '$';

    // Check if the first $ of $$ is escaped (e.g., \$$ in $\$\$\$$)
    const firstDollarEscaped = idx > 0 && src[idx - 1] === '\\';

    if (!hasDollarBefore && !hasDollarAfter && !firstDollarEscaped) {
      return idx;
    }

    // Skip past this position and continue searching
    pos = idx + 1;
  }
  return -1;
}

/**
 * Block-level math extension for $$...$$
 */
const blockMathExtension: TokenizerExtension & RendererExtension = {
  name: 'blockMath',
  level: 'block',

  start(src: string) {
    return findIsolatedDoubleDollar(src);
  },

  tokenizer(src: string) {
    // Reject if starting with 3+ consecutive $ (shouldn't happen with new start(), but be safe)
    if (/^\${3,}/.test(src)) return undefined;

    // Match $$...$$ at start of line (block level)
    const match = src.match(/^\$\$([\s\S]+?)\$\$/);
    if (match) {
      const latex = match[1].trim();
      if (isValidLatex(latex)) {
        return {
          type: 'blockMath',
          raw: match[0],
          latex,
        };
      }
    }
    return undefined;
  },

  renderer(token) {
    return mathRenderer.renderDisplay((token as unknown as { latex: string }).latex);
  },
};

/**
 * Inline math extension for $...$
 * Uses try-and-skip algorithm with strict validation.
 */
const inlineMathExtension: TokenizerExtension & RendererExtension = {
  name: 'inlineMath',
  level: 'inline',

  start(src: string) {
    return findUnescapedDollar(src, 0);
  },

  tokenizer(src: string) {
    // Reject 3+ consecutive dollar signs (e.g., $$$, $$$$, $$$$$)
    // These are colloquial expressions for "expensive", not math
    if (/^\${3,}/.test(src)) return undefined;

    // Find first $
    const firstDollar = findUnescapedDollar(src, 0);
    if (firstDollar === -1 || firstDollar !== 0) return undefined;

    // Skip if this is $$ (handled by block math)
    if (src[1] === '$') return undefined;

    // Try-and-skip algorithm: find valid math starting at position 0
    let searchPos = 1;
    while (searchPos < src.length) {
      const secondDollar = findUnescapedDollar(src, searchPos);
      if (secondDollar === -1) break;

      // Skip if second $ is part of $$
      if (src[secondDollar + 1] === '$') {
        searchPos = secondDollar + 2;
        continue;
      }

      const content = src.slice(1, secondDollar);

      // No newlines in inline math
      if (content.includes('\n')) {
        searchPos = secondDollar + 1;
        continue;
      }

      // No backticks in math (would interfere with inline code)
      if (content.includes('`')) {
        searchPos = secondDollar + 1;
        continue;
      }

      const trimmed = content.trim();

      if (shouldExtractAsMath(trimmed)) {
        return {
          type: 'inlineMath',
          raw: src.slice(0, secondDollar + 1),
          latex: trimmed,
        };
      }

      // Not valid - try next $ (skip algorithm)
      searchPos = secondDollar + 1;
    }

    return undefined;
  },

  renderer(token) {
    return mathRenderer.renderInline((token as unknown as { latex: string }).latex);
  },
};

// Configure marked with GitHub Flavored Markdown, custom renderer, and math extensions
marked.use({
  breaks: true,
  gfm: true,
  renderer,
  extensions: [blockMathExtension, inlineMathExtension],
});

/**
 * Parse markdown to HTML using marked library (with syntax highlighting and math)
 */
export function parseMarkdown(content: string): string {
  return marked.parse(content) as string;
}

/**
 * Sanitize HTML using DOMPurify to prevent XSS attacks
 */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['data-code'], // Allow data-code attribute for copy button
    ADD_TAGS: ['thinking'], // Allow <thinking> tag for models that output thinking in text
  });
}

/**
 * Combined markdown parsing (with hljs and math) and sanitization.
 * Math is now handled by marked extensions, so code blocks are protected automatically.
 */
export function renderMarkdownSafe(content: string): string {
  const html = parseMarkdown(content);
  return sanitizeHtml(html);
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
