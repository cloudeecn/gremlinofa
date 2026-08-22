import { useEffect, useState } from 'react';
import { gremlinClient } from '../client';
import type { ToolInventoryEntry } from '../../shared/protocol/protocol';

/**
 * The tool registry lives server-side, so the inventory comes over RPC.
 * One-shot fetch on mount — the registry is static for the session.
 *
 * `listTools` already filters out internal tools (`return` and friends), so
 * callers never have to special-case them in a checkbox list.
 */
export function useToolInventory(): ToolInventoryEntry[] {
  const [availableTools, setAvailableTools] = useState<ToolInventoryEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    gremlinClient.listTools().then(tools => {
      if (!cancelled) setAvailableTools(tools);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return availableTools;
}
