/**
 * Destructive-op guard.
 *
 * `rotateCek`, `purgeAllData`, `dataImport`, and `detachStorage` are all
 * "rip the rug out from under the running app" operations. If a chat loop
 * is in flight while one of them runs, the loop's storage / encryption
 * handles get yanked mid-stream and the user is left with garbled
 * partial state. The frontend disables those buttons in settings UI when
 * `subscribeActiveLoops` reports a non-empty set, but the backend
 * enforces it again here so an out-of-band caller (a stale tab, a
 * keyboard shortcut, a script) can't trip the same race.
 *
 * Throws a typed `LOOPS_RUNNING` `ProtocolError` listing the active loop
 * ids so the caller can render a meaningful message.
 */

import { ProtocolError } from '../GremlinServer';
import type { LoopRegistry } from '../LoopRegistry';

export function assertNoLoopsRunning(registry: LoopRegistry, op: string): void {
  const loops = registry.list();
  if (loops.length > 0) {
    const ids = loops.map(l => l.loopId).join(', ');
    throw new ProtocolError(
      'LOOPS_RUNNING',
      `${op}: refused — ${loops.length} active loop(s) running (${ids}). Stop all running loops and try again.`,
      { activeLoopIds: loops.map(l => l.loopId) }
    );
  }
}
