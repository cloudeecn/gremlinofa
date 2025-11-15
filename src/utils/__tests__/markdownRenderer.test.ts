import { describe, it, expect } from 'vitest';
import { renderMarkdownSafe, parseMarkdown } from '../markdownRenderer';

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
      const result = parseMarkdown('```javascript\nconst x = 1;\n```');
      // hljs adds span classes for highlighting
      expect(result).toContain('hljs-');
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
});
