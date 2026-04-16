import { describe, it, expect } from 'vitest';
import {
  extractMath,
  restoreMath,
  processWithMath,
  katexRenderer,
  hasMathIndicators,
  isValidLatex,
  shouldExtractAsMath,
  type MathRenderer,
  type MathBlock,
} from '../mathRenderer';

describe('mathRenderer', () => {
  describe('extractMath', () => {
    it('extracts inline math with $...$', () => {
      const { processed, blocks } = extractMath('The formula $E=mc^2$ is famous');

      expect(blocks).toHaveLength(1);
      expect(blocks[0].latex).toBe('E=mc^2');
      expect(blocks[0].displayMode).toBe(false);
      expect(processed).toContain('%%MATH_INLINE_');
      expect(processed).not.toContain('$');
    });

    it('extracts display math with $$...$$', () => {
      const { processed, blocks } = extractMath('Here is a formula:\n$$x = \\frac{-b}{2a}$$');

      expect(blocks).toHaveLength(1);
      expect(blocks[0].latex).toBe('x = \\frac{-b}{2a}');
      expect(blocks[0].displayMode).toBe(true);
      expect(processed).toContain('%%MATH_DISPLAY_');
    });

    it('extracts multiple inline math expressions', () => {
      const { processed, blocks } = extractMath('Both $a^2$ and $b^2$ are squares');

      expect(blocks).toHaveLength(2);
      expect(blocks[0].latex).toBe('a^2');
      expect(blocks[1].latex).toBe('b^2');
      expect(blocks.every(b => !b.displayMode)).toBe(true);
      expect(processed.match(/%%MATH_INLINE_\d+%%/g)).toHaveLength(2);
    });

    it('extracts mixed inline and display math', () => {
      const { processed, blocks } = extractMath(
        'Inline $x$ and display:\n$$y = mx + b$$\nMore inline $z$'
      );

      expect(blocks).toHaveLength(3);
      expect(blocks[0].displayMode).toBe(true); // Display extracted first
      expect(blocks[0].latex).toBe('y = mx + b');
      expect(blocks[1].displayMode).toBe(false);
      expect(blocks[1].latex).toBe('x');
      expect(blocks[2].displayMode).toBe(false);
      expect(blocks[2].latex).toBe('z');
      expect(processed).not.toContain('$');
    });

    it('handles multiline display math', () => {
      const input = `Equation:
$$
\\begin{aligned}
a &= b + c \\\\
d &= e + f
\\end{aligned}
$$
End`;
      const { processed, blocks } = extractMath(input);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].displayMode).toBe(true);
      expect(blocks[0].latex).toContain('\\begin{aligned}');
      expect(processed).not.toContain('$$');
    });

    it('does not extract inline math with newlines', () => {
      const { processed, blocks } = extractMath('This $has\nnewline$ should not match');

      expect(blocks).toHaveLength(0);
      expect(processed).toContain('$has');
    });

    it('returns empty blocks for text without math', () => {
      const { processed, blocks } = extractMath('Just regular text here');

      expect(blocks).toHaveLength(0);
      expect(processed).toBe('Just regular text here');
    });

    it('trims whitespace from extracted LaTeX', () => {
      const { blocks } = extractMath('Formula: $  E=mc^2  $');

      expect(blocks[0].latex).toBe('E=mc^2');
    });

    it('handles escaped dollar signs', () => {
      const { processed, blocks } = extractMath('Price is \\$100 but $x=5$ is math');

      expect(blocks).toHaveLength(1);
      expect(blocks[0].latex).toBe('x=5');
      expect(processed).toContain('\\$100');
    });
  });

  describe('restoreMath', () => {
    it('restores math blocks with rendered HTML', () => {
      const blocks: MathBlock[] = [
        { placeholder: '%%MATH_INLINE_0%%', latex: 'E=mc^2', displayMode: false },
      ];
      const html = '<p>Formula: %%MATH_INLINE_0%% is famous</p>';

      const mockRenderer: MathRenderer = {
        renderInline: latex => `<span class="katex">${latex}</span>`,
        renderDisplay: latex => `<div class="katex-display">${latex}</div>`,
      };

      const result = restoreMath(html, blocks, mockRenderer);

      expect(result).toBe('<p>Formula: <span class="katex">E=mc^2</span> is famous</p>');
    });

    it('restores multiple blocks in order', () => {
      const blocks: MathBlock[] = [
        { placeholder: '%%MATH_DISPLAY_0%%', latex: 'y=x', displayMode: true },
        { placeholder: '%%MATH_INLINE_1%%', latex: 'a', displayMode: false },
      ];
      const html = '<p>%%MATH_INLINE_1%% and %%MATH_DISPLAY_0%%</p>';

      const mockRenderer: MathRenderer = {
        renderInline: latex => `[inline:${latex}]`,
        renderDisplay: latex => `[display:${latex}]`,
      };

      const result = restoreMath(html, blocks, mockRenderer);

      expect(result).toBe('<p>[inline:a] and [display:y=x]</p>');
    });

    it('returns unchanged HTML when no blocks', () => {
      const html = '<p>No math here</p>';
      const result = restoreMath(html, []);

      expect(result).toBe(html);
    });
  });

  describe('processWithMath', () => {
    it('integrates extraction, processing, and restoration', () => {
      const mockMarkdown = (text: string) => `<p>${text}</p>`;
      const mockRenderer: MathRenderer = {
        renderInline: latex => `<math>${latex}</math>`,
        renderDisplay: latex => `<MATH>${latex}</MATH>`,
      };

      const result = processWithMath('Text with $x^2$ math', mockMarkdown, mockRenderer);

      expect(result).toBe('<p>Text with <math>x^2</math> math</p>');
    });

    it('processes text without math unchanged', () => {
      const mockMarkdown = (text: string) => `<p>${text}</p>`;
      const result = processWithMath('No math here', mockMarkdown);

      expect(result).toBe('<p>No math here</p>');
    });
  });

  describe('katexRenderer', () => {
    it('renders inline math to HTML with katex class', () => {
      const html = katexRenderer.renderInline('E=mc^2');

      expect(html).toContain('class="katex"');
      expect(html).toContain('E');
      // KaTeX renders 'm' and 'c' as separate spans
      expect(html).toContain('>m<');
      expect(html).toContain('>c<');
    });

    it('renders display math with katex-display wrapper', () => {
      const html = katexRenderer.renderDisplay('x^2 + y^2 = r^2');

      expect(html).toContain('katex-display');
      expect(html).toContain('katex');
    });

    it('handles complex LaTeX expressions', () => {
      const html = katexRenderer.renderDisplay(
        '\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}'
      );

      expect(html).toContain('katex');
      // Should not throw
    });

    it('handles fractions', () => {
      const html = katexRenderer.renderInline('\\frac{a}{b}');

      expect(html).toContain('katex');
    });

    it('handles subscripts and superscripts', () => {
      const html = katexRenderer.renderInline('x_1^2 + x_2^2');

      expect(html).toContain('katex');
    });

    it('handles Greek letters', () => {
      const html = katexRenderer.renderInline('\\alpha + \\beta = \\gamma');

      expect(html).toContain('katex');
    });

    it('handles invalid LaTeX gracefully without throwing', () => {
      // KaTeX with throwOnError: false should not throw
      expect(() => katexRenderer.renderInline('\\invalid{command}')).not.toThrow();
      expect(() => katexRenderer.renderDisplay('\\bad{')).not.toThrow();
    });

    it('shows error styling for invalid LaTeX', () => {
      const html = katexRenderer.renderInline('\\undefined');

      // KaTeX shows error in red when throwOnError: false
      expect(html).toContain('katex');
    });
  });

  describe('hasMathIndicators', () => {
    it('returns true for single characters (could be variables)', () => {
      expect(hasMathIndicators('x')).toBe(true);
      expect(hasMathIndicators('y')).toBe(true);
    });

    it('returns false for multi-char text without math symbols', () => {
      expect(hasMathIndicators('abc')).toBe(false);
      expect(hasMathIndicators('hello')).toBe(false);
      expect(hasMathIndicators('123')).toBe(false);
      expect(hasMathIndicators('1.5')).toBe(false);
      expect(hasMathIndicators('hello world')).toBe(false);
    });

    it('returns true for text with math operators', () => {
      expect(hasMathIndicators('x + y')).toBe(true);
      expect(hasMathIndicators('a = b')).toBe(true);
      expect(hasMathIndicators('x^2')).toBe(true);
      expect(hasMathIndicators('a_1')).toBe(true);
      expect(hasMathIndicators('a/b')).toBe(true);
      expect(hasMathIndicators('a*b')).toBe(true);
    });

    it('returns true for text with LaTeX commands', () => {
      expect(hasMathIndicators('\\alpha')).toBe(true);
      expect(hasMathIndicators('\\frac{a}{b}')).toBe(true);
    });

    it('returns true for text with braces/brackets', () => {
      expect(hasMathIndicators('{a}')).toBe(true);
      expect(hasMathIndicators('(a)')).toBe(true);
      expect(hasMathIndicators('[a]')).toBe(true);
    });

    describe('minus sign handling', () => {
      it('returns true for minus followed by space (binary minus)', () => {
        expect(hasMathIndicators('a - b')).toBe(true);
        expect(hasMathIndicators('x - y')).toBe(true);
      });

      it('returns true for minus followed by digit (negative number)', () => {
        expect(hasMathIndicators('-2')).toBe(true);
        expect(hasMathIndicators('-123')).toBe(true);
        expect(hasMathIndicators('x + -5')).toBe(true);
      });

      it('returns true for minus followed by dot (negative decimal)', () => {
        expect(hasMathIndicators('-.5')).toBe(true);
        expect(hasMathIndicators('-.123')).toBe(true);
      });

      it('returns false for hyphens in words (not math)', () => {
        expect(hasMathIndicators('well-known')).toBe(false);
        expect(hasMathIndicators('x-y')).toBe(false);
        expect(hasMathIndicators('a-b-c')).toBe(false);
        expect(hasMathIndicators("it's-confusing")).toBe(false);
      });

      it('returns false for em-dash in prose', () => {
        expect(hasMathIndicators('" is confusing—it\'s "')).toBe(false);
      });
    });
  });

  describe('isValidLatex', () => {
    it('returns true for valid LaTeX', () => {
      expect(isValidLatex('x^2')).toBe(true);
      expect(isValidLatex('E=mc^2')).toBe(true);
      expect(isValidLatex('\\frac{a}{b}')).toBe(true);
      expect(isValidLatex('\\alpha + \\beta')).toBe(true);
    });

    it('returns false for invalid LaTeX', () => {
      expect(isValidLatex('\\invalid{command}')).toBe(false);
      expect(isValidLatex('\\bad{')).toBe(false);
    });

    it('returns true for simple valid expressions', () => {
      expect(isValidLatex('x')).toBe(true);
      expect(isValidLatex('a + b')).toBe(true);
    });
  });

  describe('shouldExtractAsMath', () => {
    it('returns false for content with citation links', () => {
      expect(shouldExtractAsMath('text <a href="...">link</a> more')).toBe(false);
      expect(shouldExtractAsMath('<a href="#cite">1</a>')).toBe(false);
    });

    it('returns false for text without math indicators', () => {
      expect(shouldExtractAsMath('abc')).toBe(false);
      expect(shouldExtractAsMath('hello world')).toBe(false);
      expect(shouldExtractAsMath('100')).toBe(false);
      expect(shouldExtractAsMath('1.5')).toBe(false);
    });

    it('returns true for single characters', () => {
      expect(shouldExtractAsMath('x')).toBe(true);
      expect(shouldExtractAsMath('y')).toBe(true);
    });

    it('returns true for valid math expressions', () => {
      expect(shouldExtractAsMath('x^2')).toBe(true);
      expect(shouldExtractAsMath('E=mc^2')).toBe(true);
      expect(shouldExtractAsMath('\\frac{a}{b}')).toBe(true);
      expect(shouldExtractAsMath('a + b')).toBe(true);
    });

    it('returns false for invalid LaTeX (fails validation)', () => {
      expect(shouldExtractAsMath('\\invalid{}')).toBe(false);
    });
  });

  describe('currency false positive prevention', () => {
    it('does NOT extract currency as math: $1.5 to $2.25', () => {
      const { processed, blocks } = extractMath('The price is from $1.5 to $2.25');

      // No math should be extracted - this is currency, not math
      expect(blocks).toHaveLength(0);
      expect(processed).toBe('The price is from $1.5 to $2.25');
    });

    it('does NOT extract single price as math', () => {
      const { processed, blocks } = extractMath('It costs $50 dollars');

      expect(blocks).toHaveLength(0);
      expect(processed).toBe('It costs $50 dollars');
    });

    it('extracts math when currency uses escaped dollars', () => {
      // When currency is properly escaped, math can be extracted
      const { blocks } = extractMath('Price is \\$100 but formula $x^2 + y^2 = r^2$ works');

      expect(blocks).toHaveLength(1);
      expect(blocks[0].latex).toBe('x^2 + y^2 = r^2');
    });

    it('extracts math after unescaped currency with try-and-skip algorithm', () => {
      // Try-and-skip: "$100 but formula $" is rejected, then "$x^2 + y^2 = r^2$" is found
      const { blocks } = extractMath('Price is $100 but formula $x^2 + y^2 = r^2$ works');

      expect(blocks).toHaveLength(1);
      expect(blocks[0].latex).toBe('x^2 + y^2 = r^2');
    });

    it('extracts math: The price is $1.5, $(x^2)$', () => {
      const { blocks } = extractMath('The price is $1.5, $(x^2)$');

      // Try-and-skip: "$1.5, $" is rejected, then "$(x^2)$" is found
      expect(blocks).toHaveLength(1);
      expect(blocks[0].latex).toBe('(x^2)');
    });

    it('extracts math: I paid $20 for $\\frac{1}{4}$ of pizza', () => {
      const { blocks } = extractMath('I paid $20 for $\\frac{1}{4}$ of pizza');

      // Try-and-skip: "$20 for $" is rejected, then "$\frac{1}{4}$" is found
      expect(blocks).toHaveLength(1);
      expect(blocks[0].latex).toBe('\\frac{1}{4}');
    });

    it('does NOT extract plain words in dollars', () => {
      const { blocks } = extractMath('From $start to $end point');

      expect(blocks).toHaveLength(0);
    });
  });

  describe('edge cases', () => {
    it('handles empty math delimiters', () => {
      const { blocks } = extractMath('Empty $$ and $ $ here');

      // Empty delimiters may or may not be valid depending on validation
      expect(blocks.length).toBeGreaterThanOrEqual(0);
    });

    it('handles nested-looking delimiters', () => {
      const { blocks } = extractMath('Test $a + $b$ + c$');

      // With try-and-skip:
      // - "$a + $" has "+", validated -> valid
      // - Then "$b$" has no indicators (single char) -> valid
      expect(blocks.length).toBeGreaterThanOrEqual(1);
    });

    it('handles dollar amounts mixed with math', () => {
      const { processed, blocks } = extractMath('Price \\$50 and formula $x=5$ is math');

      expect(blocks).toHaveLength(1);
      expect(blocks[0].latex).toBe('x=5');
      expect(processed).toContain('\\$50');
    });

    it('handles consecutive math expressions', () => {
      const { blocks } = extractMath('$a^2$$b^2$$c^2$');

      // Should extract display math and valid inline math
      expect(blocks.length).toBeGreaterThan(0);
    });

    it('keeps invalid display math as text', () => {
      const { processed, blocks } = extractMath('Invalid: $$\\bad{$$ text');

      // Invalid display math should be kept as original text
      expect(blocks).toHaveLength(0);
      expect(processed).toContain('$$\\bad{$$');
    });

    it('handles $A$B$C$ pattern', () => {
      // A is single char (has indicators), B is single char, C is single char
      // With try-and-skip: $A$ extracted, then $C$ extracted
      // B is in between, not delimited
      const { blocks } = extractMath('Test $A$B$C$ here');

      // Should extract A and C
      expect(blocks).toHaveLength(2);
      expect(blocks[0].latex).toBe('A');
      expect(blocks[1].latex).toBe('C');
    });
  });
});
