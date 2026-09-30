import { useSyncExternalStore } from 'react';
import { gremlinClient } from '../client';
import type { ConnectionState } from '../../shared/protocol/transport';

const subscribe = (onChange: () => void) => gremlinClient.onConnectionStateChange(onChange);
const getSnapshot = (): ConnectionState => gremlinClient.connectionState ?? 'connected';

/**
 * Subscribe to the transport's connection state. Returns `'connected'` on
 * non-WebSocket transports (worker) where connection state is not tracked.
 * `useSyncExternalStore` re-reads the state after subscribing, so a change
 * between render and subscription isn't lost.
 */
export function useConnectionState(): ConnectionState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
