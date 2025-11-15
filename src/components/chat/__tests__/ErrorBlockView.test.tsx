import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ErrorBlockView from '../ErrorBlockView';
import type { ErrorRenderBlock, TextRenderBlock } from '../../../types/content';

describe('ErrorBlockView', () => {
  const errorBlock: ErrorRenderBlock = {
    type: 'error',
    message: 'Something went wrong',
    stack: 'Error: Something went wrong\n    at doSomething (/app/index.js:10:5)',
    status: 500,
  };

  const errorBlockWithoutStack: ErrorRenderBlock = {
    type: 'error',
    message: 'Network error occurred',
  };

  const errorBlockWithoutStatus: ErrorRenderBlock = {
    type: 'error',
    message: 'Unknown error',
    stack: 'Error: Unknown error\n    at somewhere',
  };

  it('renders error message preview in collapsed state', () => {
    render(<ErrorBlockView blocks={[errorBlock]} />);

    expect(screen.getByText('❌ Error')).toBeInTheDocument();
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('shows expand arrow when stack trace is present', () => {
    render(<ErrorBlockView blocks={[errorBlock]} />);

    expect(screen.getByText('▶')).toBeInTheDocument();
  });

  it('does not show expand arrow when no stack trace', () => {
    render(<ErrorBlockView blocks={[errorBlockWithoutStack]} />);

    expect(screen.queryByText('▶')).not.toBeInTheDocument();
    expect(screen.queryByText('▼')).not.toBeInTheDocument();
  });

  it('expands to show full content when clicked', () => {
    render(<ErrorBlockView blocks={[errorBlock]} />);

    // Click to expand
    fireEvent.click(screen.getByRole('button'));

    // Arrow should change
    expect(screen.getByText('▼')).toBeInTheDocument();

    // Should show HTTP status
    expect(screen.getByText('HTTP 500')).toBeInTheDocument();

    // Should show full message
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();

    // Should show stack trace
    expect(screen.getByText(/Error: Something went wrong/)).toBeInTheDocument();
    expect(screen.getByText(/at doSomething/)).toBeInTheDocument();
  });

  it('collapses when clicked again', () => {
    render(<ErrorBlockView blocks={[errorBlock]} />);

    // Click to expand
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('▼')).toBeInTheDocument();

    // Click to collapse
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('▶')).toBeInTheDocument();

    // Stack trace should be hidden
    expect(screen.queryByText(/at doSomething/)).not.toBeInTheDocument();
  });

  it('handles error without status code', () => {
    render(<ErrorBlockView blocks={[errorBlockWithoutStatus]} defaultExpanded={true} />);

    expect(screen.queryByText(/HTTP/)).not.toBeInTheDocument();
    expect(screen.getByText('Unknown error')).toBeInTheDocument();
    expect(screen.getByText(/at somewhere/)).toBeInTheDocument();
  });

  it('renders with defaultExpanded true', () => {
    render(<ErrorBlockView blocks={[errorBlock]} defaultExpanded={true} />);

    // Should show expanded content
    expect(screen.getByText('▼')).toBeInTheDocument();
    expect(screen.getByText('HTTP 500')).toBeInTheDocument();
    expect(screen.getByText(/at doSomething/)).toBeInTheDocument();
  });

  it('renders multiple error blocks', () => {
    render(<ErrorBlockView blocks={[errorBlock, errorBlockWithoutStack]} defaultExpanded={true} />);

    // Both error messages should be visible
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('Network error occurred')).toBeInTheDocument();
  });

  it('returns null for empty blocks array', () => {
    const { container } = render(<ErrorBlockView blocks={[]} />);

    expect(container.firstChild).toBeNull();
  });

  it('filters out non-error blocks', () => {
    const textBlock: TextRenderBlock = {
      type: 'text',
      text: 'This is text',
    };

    const { container } = render(<ErrorBlockView blocks={[textBlock]} />);

    expect(container.firstChild).toBeNull();
  });

  it('only shows first line in preview', () => {
    const multilineError: ErrorRenderBlock = {
      type: 'error',
      message: 'First line\nSecond line\nThird line',
    };

    render(<ErrorBlockView blocks={[multilineError]} />);

    // Preview should only show first line
    const preview = screen.getByText('First line');
    expect(preview).toBeInTheDocument();
    expect(preview).toHaveClass('truncate');
  });

  it('shows full multiline message when expanded', () => {
    const multilineError: ErrorRenderBlock = {
      type: 'error',
      message: 'First line\nSecond line\nThird line',
      stack: 'Stack trace here',
    };

    render(<ErrorBlockView blocks={[multilineError]} defaultExpanded={true} />);

    // Full message should be visible with whitespace preserved
    const messageDiv = screen.getByText(/First line/);
    expect(messageDiv).toHaveClass('whitespace-pre-wrap');
    expect(messageDiv.textContent).toContain('Second line');
    expect(messageDiv.textContent).toContain('Third line');
  });
});
