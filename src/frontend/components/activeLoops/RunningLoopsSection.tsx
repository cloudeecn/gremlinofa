import { useSyncExternalStore } from 'react';
import { activeLoopsStore } from '../../client';
import type { ActiveLoop, LoopId } from '../../../shared/protocol/protocol';
import ActiveLoopRow from './ActiveLoopRow';

interface RunningLoopsSectionProps {
  /** Mobile sidebar overlay close handler — propagated to row clicks. */
  onAfterNavigate?: () => void;
}

/**
 * Sidebar section listing every currently-running agentic loop. Renders
 * nothing when no loops are active so users without an in-flight chat see
 * no UI change. Active loops are rendered as a tree: minion sub-loops nest
 * under their parent, to arbitrary depth (a minion that spawns its own
 * sub-minion shows up indented under it).
 *
 * The section is project-agnostic on purpose — users can switch projects
 * mid-run and still see (and abort) their loops without navigating back
 * to the originating chat.
 */
export default function RunningLoopsSection({ onAfterNavigate }: RunningLoopsSectionProps) {
  const loops = useSyncExternalStore(
    activeLoopsStore.subscribe,
    activeLoopsStore.getSnapshot,
    activeLoopsStore.getSnapshot
  );

  // The store resolves each chat's title once while it has running loops and
  // applies live renames.
  const titles = useSyncExternalStore(
    activeLoopsStore.subscribe,
    activeLoopsStore.getTitlesSnapshot,
    activeLoopsStore.getTitlesSnapshot
  );
  const pendingTitles = useSyncExternalStore(
    activeLoopsStore.subscribe,
    activeLoopsStore.getPendingTitlesSnapshot,
    activeLoopsStore.getPendingTitlesSnapshot
  );

  if (loops.length === 0) return null;

  const chatLabel = (chatId: string) =>
    titles.get(chatId) ?? (pendingTitles.has(chatId) ? 'Loading…' : 'Unknown chat');

  // Index children by parent so we can render a tree of arbitrary depth.
  const childrenByParent = new Map<LoopId, ActiveLoop[]>();
  for (const loop of loops) {
    if (loop.parentLoopId) {
      const list = childrenByParent.get(loop.parentLoopId) ?? [];
      list.push(loop);
      childrenByParent.set(loop.parentLoopId, list);
    }
  }
  // Roots = loops with no running parent. The `!loopIds.has(parentLoopId)`
  // clause promotes a sub-loop to a root if its parent already finished, so
  // it stays visible instead of being orphaned out of the tree.
  const loopIds = new Set(loops.map(l => l.loopId));
  const roots = loops.filter(l => !l.parentLoopId || !loopIds.has(l.parentLoopId));

  const renderLoop = (loop: ActiveLoop, depth: number): React.ReactNode => {
    const children = childrenByParent.get(loop.loopId) ?? [];
    return (
      <div key={loop.loopId}>
        <ActiveLoopRow
          loop={loop}
          depth={depth}
          chatLabel={chatLabel(loop.chatId)}
          onAfterNavigate={onAfterNavigate}
        />
        {children.map(child => renderLoop(child, depth + 1))}
      </div>
    );
  };

  return (
    <div className="ios-scroll max-h-[50vh] overflow-y-auto overscroll-y-contain border-b border-gray-700 bg-gray-950/50">
      <div className="sticky top-0 z-10 flex items-center justify-between bg-gray-950 px-4 pt-2 pb-1">
        <span className="text-[10px] font-semibold tracking-wider text-gray-400">
          RUNNING LOOPS
        </span>
        <span className="rounded-full bg-green-900/40 px-1.5 py-0.5 text-[9px] font-medium text-green-300">
          {loops.length}
        </span>
      </div>
      <div className="space-y-0.5 px-2 pb-2">{roots.map(root => renderLoop(root, 0))}</div>
    </div>
  );
}
