import { useEffect, useState, useSyncExternalStore } from 'react';
import { activeLoopsStore, gremlinClient } from '../../client';
import type { ActiveLoop, LoopId } from '../../../shared/protocol/protocol';
import ActiveLoopRow from './ActiveLoopRow';

interface RunningLoopsSectionProps {
  /** Mobile sidebar overlay close handler — propagated to row clicks. */
  onAfterNavigate?: () => void;
}

/**
 * Sidebar section listing every currently-running agentic loop. Renders
 * nothing when no loops are active so users without an in-flight chat see
 * no UI change. Active loops are grouped by parent: minion sub-loops are
 * indented under their parent root loop.
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

  // Look up chat names lazily for the labels. We only fetch each chatId
  // once per session — the names rarely change while a loop is in flight.
  const chatNames = useChatNamesForLoops(loops);

  if (loops.length === 0) return null;

  // Group: roots first, children indented under their parent. We don't try
  // to handle deeper minion-of-minion nesting; just one level of indent.
  const roots = loops.filter(l => !l.parentLoopId);
  const childrenByParent = new Map<LoopId, ActiveLoop[]>();
  for (const loop of loops) {
    if (loop.parentLoopId) {
      const list = childrenByParent.get(loop.parentLoopId) ?? [];
      list.push(loop);
      childrenByParent.set(loop.parentLoopId, list);
    }
  }

  return (
    <div className="border-b border-gray-700 bg-gray-950/50 px-2 py-2">
      <div className="mb-1 flex items-center justify-between px-2">
        <span className="text-[10px] font-semibold tracking-wider text-gray-400">
          RUNNING LOOPS
        </span>
        <span className="rounded-full bg-green-900/40 px-1.5 py-0.5 text-[9px] font-medium text-green-300">
          {loops.length}
        </span>
      </div>
      <div className="space-y-0.5">
        {roots.map(root => {
          const children = childrenByParent.get(root.loopId) ?? [];
          return (
            <div key={root.loopId}>
              <ActiveLoopRow
                loop={root}
                chatLabel={chatNames.get(root.chatId) ?? 'Loading…'}
                onAfterNavigate={onAfterNavigate}
              />
              {children.map(child => (
                <ActiveLoopRow
                  key={child.loopId}
                  loop={child}
                  isChild
                  chatLabel={chatNames.get(child.chatId) ?? 'Loading…'}
                  onAfterNavigate={onAfterNavigate}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Lazy chat-name lookup for the loops list. We avoid putting chat metadata
 * in `ActiveLoop` itself because it would go stale on rename and would
 * couple the registry record to a particular client's view of the world.
 */
function useChatNamesForLoops(loops: ActiveLoop[]): Map<string, string> {
  const [names, setNames] = useState<Map<string, string>>(() => new Map());

  useEffect(() => {
    const missing = new Set<string>();
    for (const loop of loops) {
      if (!names.has(loop.chatId)) missing.add(loop.chatId);
    }
    if (missing.size === 0) return;

    let cancelled = false;
    const fetchNames = async () => {
      const updates = new Map(names);
      for (const chatId of missing) {
        try {
          const chat = await gremlinClient.getChat(chatId);
          if (cancelled) return;
          if (chat) updates.set(chatId, chat.name);
        } catch {
          // Ignore — the row will show "Loading…" until next attempt
        }
      }
      if (!cancelled) setNames(updates);
    };
    void fetchNames();

    return () => {
      cancelled = true;
    };
    // We deliberately depend only on the loops array (not `names`) so we
    // don't loop forever after a successful fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loops]);

  return names;
}
