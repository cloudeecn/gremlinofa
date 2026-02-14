import { createContext, useContext } from 'react';

export const MinionChatOverlayContext = createContext<{
  viewMinionChat: (id: string) => void;
} | null>(null);

export function useMinionChatOverlay() {
  return useContext(MinionChatOverlayContext);
}
