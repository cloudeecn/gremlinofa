import { useState, useEffect } from 'react';
import { gremlinClient } from '../client';
import type { ConnectionState } from '../../shared/protocol/transport';

/**
 * Subscribe to the transport's connection state. Returns `'connected'` on
 * non-WebSocket transports (worker) where connection state is not tracked.
 */
export function useConnectionState(): ConnectionState {
  const [state, setState] = useState<ConnectionState>(
    () => gremlinClient.connectionState ?? 'connected'
  );

  useEffect(() => {
    return gremlinClient.onConnectionStateChange(setState);
  }, []);

  return state;
}
