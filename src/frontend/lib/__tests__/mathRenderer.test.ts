import { describe, it, expect } from 'vitest';
import {
  katexRenderer,
  hasMathIndicators,
  isValidLatex,
  shouldExtractAsMath,
} from '../mathRenderer';

describe('mathRenderer', () => {
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

    it('caps user-specified sizes', () => {
      const html = katexRenderer.renderInline('\\rule{500em}{500em}');

      expect(html).toContain('katex');
      expect(html).not.toContain('500em');
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

    it('returns true for integers, trimmed', () => {
      expect(hasMathIndicators('2')).toBe(true);
      expect(hasMathIndicators('42')).toBe(true);
      expect(hasMathIndicators(' 7 ')).toBe(true);
    });

    it('returns false for multi-char text without math symbols', () => {
      expect(hasMathIndicators('abc')).toBe(false);
      expect(hasMathIndicators('hello')).toBe(false);
      expect(hasMathIndicators('x1')).toBe(false);
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
      expect(shouldExtractAsMath('1.5')).toBe(false);
    });

    it('returns true for single characters and integers', () => {
      expect(shouldExtractAsMath('x')).toBe(true);
      expect(shouldExtractAsMath('y')).toBe(true);
      expect(shouldExtractAsMath('100')).toBe(true);
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
});
