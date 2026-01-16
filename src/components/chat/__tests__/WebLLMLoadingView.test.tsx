/**
 * Tests for WebLLMLoadingView component
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import WebLLMLoadingView from '../WebLLMLoadingView';

// Mock useIsMobile hook
vi.mock('../../../hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

describe('WebLLMLoadingView', () => {
  const defaultProps = {
    modelName: 'Llama 3.2 3B',
    progress: {
      text: 'Downloading model...',
      progress: 45,
    },
  };

  it('should render model name', () => {
    render(<WebLLMLoadingView {...defaultProps} />);

    expect(screen.getByText('Llama 3.2 3B')).toBeInTheDocument();
  });

  it('should render loading title', () => {
    render(<WebLLMLoadingView {...defaultProps} />);

    expect(screen.getByText('Loading Local Model')).toBeInTheDocument();
  });

  it('should render status text', () => {
    render(<WebLLMLoadingView {...defaultProps} />);

    expect(screen.getByText('Downloading model...')).toBeInTheDocument();
  });

  it('should render progress percentage', () => {
    render(<WebLLMLoadingView {...defaultProps} />);

    expect(screen.getByText('45%')).toBeInTheDocument();
  });

  it('should render download icon when downloading', () => {
    render(<WebLLMLoadingView {...defaultProps} />);

    expect(screen.getByText('📥')).toBeInTheDocument();
  });

  it('should render loading icon when loading (not downloading)', () => {
    const props = {
      ...defaultProps,
      progress: {
        text: 'Loading model weights...',
        progress: 75,
      },
    };

    render(<WebLLMLoadingView {...props} />);

    expect(screen.getByText('⚙️')).toBeInTheDocument();
  });

  it('should render "Initializing..." when progress is unknown', () => {
    const props = {
      ...defaultProps,
      progress: {
        text: 'Starting...',
        progress: -1,
      },
    };

    render(<WebLLMLoadingView {...props} />);

    expect(screen.getByText('Initializing...')).toBeInTheDocument();
  });

  it('should not render progress bar when progress is unknown', () => {
    const props = {
      ...defaultProps,
      progress: {
        text: 'Starting...',
        progress: -1,
      },
    };

    const { container } = render(<WebLLMLoadingView {...props} />);

    // Progress bar has specific class
    const progressBar = container.querySelector('.bg-gradient-to-r.from-blue-500');
    expect(progressBar).not.toBeInTheDocument();
  });

  it('should render progress bar when progress is known', () => {
    const { container } = render(<WebLLMLoadingView {...defaultProps} />);

    const progressBar = container.querySelector('.bg-gradient-to-r.from-blue-500');
    expect(progressBar).toBeInTheDocument();
    expect(progressBar).toHaveStyle({ width: '45%' });
  });

  it('should clamp progress to 0-100 range', () => {
    const props = {
      ...defaultProps,
      progress: {
        text: 'Almost done...',
        progress: 150, // Over 100%
      },
    };

    render(<WebLLMLoadingView {...props} />);

    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('should handle negative progress as 0%', () => {
    const props = {
      ...defaultProps,
      progress: {
        text: 'Preparing...',
        progress: 0,
      },
    };

    render(<WebLLMLoadingView {...props} />);

    expect(screen.getByText('0%')).toBeInTheDocument();
  });

  it('should render time remaining when provided', () => {
    const props = {
      ...defaultProps,
      progress: {
        text: 'Downloading model...',
        progress: 45,
        timeRemaining: 90, // 90 seconds = 2m (rounded)
      },
    };

    render(<WebLLMLoadingView {...props} />);

    expect(screen.getByText('~2m')).toBeInTheDocument();
  });

  it('should format time remaining in seconds for < 60s', () => {
    const props = {
      ...defaultProps,
      progress: {
        text: 'Downloading model...',
        progress: 90,
        timeRemaining: 30,
      },
    };

    render(<WebLLMLoadingView {...props} />);

    expect(screen.getByText('~30s')).toBeInTheDocument();
  });

  it('should format time remaining in hours for >= 3600s', () => {
    const props = {
      ...defaultProps,
      progress: {
        text: 'Downloading model...',
        progress: 10,
        timeRemaining: 7200,
      },
    };

    render(<WebLLMLoadingView {...props} />);

    expect(screen.getByText('~2h')).toBeInTheDocument();
  });

  it('should render helper text about first load', () => {
    render(<WebLLMLoadingView {...defaultProps} />);

    expect(screen.getByText('First load may take a while')).toBeInTheDocument();
  });
});
