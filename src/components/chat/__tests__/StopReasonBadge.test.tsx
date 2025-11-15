import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import StopReasonBadge from '../StopReasonBadge';
import type { MessageStopReason } from '../../../types/content';

describe('StopReasonBadge', () => {
  describe('end_turn (normal completion)', () => {
    it('renders nothing for end_turn', () => {
      const { container } = render(<StopReasonBadge stopReason="end_turn" />);
      expect(container.firstChild).toBeNull();
    });
  });

  describe('max_tokens', () => {
    it('renders truncated badge with warning icon', () => {
      render(<StopReasonBadge stopReason="max_tokens" />);

      expect(screen.getByText('⚠️')).toBeInTheDocument();
      expect(screen.getByText('Truncated')).toBeInTheDocument();
    });

    it('has yellow styling', () => {
      const { container } = render(<StopReasonBadge stopReason="max_tokens" />);

      const badge = container.querySelector('.stop-reason-badge');
      expect(badge).toHaveClass('text-yellow-800');
    });

    it('has title with stop reason', () => {
      render(<StopReasonBadge stopReason="max_tokens" />);

      const badge = screen.getByTitle('Message stopped: max_tokens');
      expect(badge).toBeInTheDocument();
    });
  });

  describe('stop_sequence', () => {
    it('renders stop sequence badge', () => {
      render(<StopReasonBadge stopReason="stop_sequence" />);

      expect(screen.getByText('🛑')).toBeInTheDocument();
      expect(screen.getByText('Stop Sequence')).toBeInTheDocument();
    });

    it('has orange styling', () => {
      const { container } = render(<StopReasonBadge stopReason="stop_sequence" />);

      const badge = container.querySelector('.stop-reason-badge');
      expect(badge).toHaveClass('text-orange-800');
    });
  });

  describe('error', () => {
    it('renders error badge', () => {
      render(<StopReasonBadge stopReason="error" />);

      expect(screen.getByText('❌')).toBeInTheDocument();
      expect(screen.getByText('Error')).toBeInTheDocument();
    });

    it('has red styling', () => {
      const { container } = render(<StopReasonBadge stopReason="error" />);

      const badge = container.querySelector('.stop-reason-badge');
      expect(badge).toHaveClass('text-red-800');
    });
  });

  describe('cancelled', () => {
    it('renders cancelled badge', () => {
      render(<StopReasonBadge stopReason="cancelled" />);

      expect(screen.getByText('⏹️')).toBeInTheDocument();
      expect(screen.getByText('Cancelled')).toBeInTheDocument();
    });

    it('has gray styling', () => {
      const { container } = render(<StopReasonBadge stopReason="cancelled" />);

      const badge = container.querySelector('.stop-reason-badge');
      expect(badge).toHaveClass('text-gray-800');
    });
  });

  describe('unknown/provider-specific stop reasons', () => {
    it('renders unknown stop reason with info icon', () => {
      render(<StopReasonBadge stopReason={'tool_use' as MessageStopReason} />);

      expect(screen.getByText('ℹ️')).toBeInTheDocument();
      expect(screen.getByText('tool_use')).toBeInTheDocument();
    });

    it('has blue styling for unknown reasons', () => {
      const { container } = render(
        <StopReasonBadge stopReason={'custom_reason' as MessageStopReason} />
      );

      const badge = container.querySelector('.stop-reason-badge');
      expect(badge).toHaveClass('text-blue-800');
    });

    it('displays the exact stop reason text', () => {
      render(<StopReasonBadge stopReason={'content_filter' as MessageStopReason} />);

      expect(screen.getByText('content_filter')).toBeInTheDocument();
      expect(screen.getByTitle('Message stopped: content_filter')).toBeInTheDocument();
    });
  });

  describe('badge structure', () => {
    it('has proper badge classes', () => {
      const { container } = render(<StopReasonBadge stopReason="max_tokens" />);

      const badge = container.querySelector('.stop-reason-badge');
      expect(badge).toHaveClass('inline-flex', 'items-center', 'gap-1');
    });

    it('has icon and label in separate spans', () => {
      render(<StopReasonBadge stopReason="max_tokens" />);

      const badge = screen.getByTitle('Message stopped: max_tokens');
      const spans = badge.querySelectorAll('span');
      expect(spans.length).toBe(2); // icon span and label span
    });
  });
});
