import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import RunningLoopsSection from '../RunningLoopsSection';
import type { ActiveLoop } from '../../../../shared/protocol/protocol';

const storeState = vi.hoisted(() => ({
  loops: [] as ActiveLoop[],
  titles: new Map<string, string>() as ReadonlyMap<string, string>,
  pending: new Set<string>() as ReadonlySet<string>,
}));

vi.mock('../../../client', () => ({
  activeLoopsStore: {
    subscribe: () => () => {},
    getSnapshot: () => storeState.loops,
    getTitlesSnapshot: () => storeState.titles,
    getPendingTitlesSnapshot: () => storeState.pending,
    abort: vi.fn(),
  },
}));

function makeLoop(loopId: string, chatId: string, extra: Partial<ActiveLoop> = {}): ActiveLoop {
  return {
    loopId,
    chatId,
    startedAt: Date.now(),
    status: 'running',
    apiDefinitionId: 'api_1',
    modelId: 'model-x',
    ...extra,
  };
}

function renderSection() {
  return render(
    <MemoryRouter>
      <RunningLoopsSection />
    </MemoryRouter>
  );
}

describe('RunningLoopsSection', () => {
  beforeEach(() => {
    storeState.loops = [];
    storeState.titles = new Map();
    storeState.pending = new Set();
  });

  it('renders nothing without running loops', () => {
    const { container } = renderSection();
    expect(container).toBeEmptyDOMElement();
  });

  it('labels rows by title, pending lookup, unknown chat and displayName', () => {
    storeState.loops = [
      makeLoop('loop_known', 'c_known'),
      makeLoop('loop_pending', 'c_pending'),
      makeLoop('loop_unknown', 'c_unknown'),
      makeLoop('loop_minion', 'minion_1', { parentLoopId: 'loop_known', displayName: 'Scout' }),
    ];
    storeState.titles = new Map([['c_known', 'Known chat']]);
    storeState.pending = new Set(['c_pending']);

    renderSection();

    expect(screen.getByText('Known chat')).toBeInTheDocument();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.getByText('Unknown chat')).toBeInTheDocument();
    expect(screen.getByText('Scout')).toBeInTheDocument();
  });
});
