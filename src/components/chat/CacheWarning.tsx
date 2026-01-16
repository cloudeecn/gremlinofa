import { useEffect, useState } from 'react';
import { storage } from '../../services/storage';
import type { Message, APIDefinition } from '../../types';

interface CacheWarningProps {
  messages: Message<unknown>[];
  currentApiDefId: string | null;
  currentModelId: string | null;
}

export default function CacheWarning({
  messages,
  currentApiDefId,
  currentModelId,
}: CacheWarningProps) {
  const [shouldShowWarning, setShouldShowWarning] = useState(false);
  const [estimatedCost, setEstimatedCost] = useState<number>(0);

  useEffect(() => {
    const checkCacheInvalidation = async () => {
      // Reset state
      setShouldShowWarning(false);
      setEstimatedCost(0);

      // Need messages and API definition
      if (messages.length === 0 || !currentApiDefId || !currentModelId) {
        return;
      }

      // Load API definition to check if it's Anthropic
      const apiDef: APIDefinition | null = await storage.getAPIDefinition(currentApiDefId);
      if (!apiDef || apiDef.apiType !== 'anthropic') {
        return;
      }

      // Get last message
      const lastMessage = messages[messages.length - 1];
      if (!lastMessage) {
        return;
      }

      // Check conditions for cache invalidation
      const now = Date.now();
      const lastMessageTime = lastMessage.timestamp.getTime();
      const fiveMinutesInMs = 5 * 60 * 1000;
      const isOlderThan5Minutes = now - lastMessageTime > fiveMinutesInMs;
      const isNotFromAnthropic = lastMessage.content.modelFamily !== 'anthropic';

      // Show warning if either condition is met
      if (isOlderThan5Minutes || isNotFromAnthropic) {
        // Calculate estimated cost using context window usage from last message
        const contextWindowUsage = lastMessage.metadata?.contextWindowUsage || 0;

        if (contextWindowUsage > 0) {
          // Get model pricing info
          const model = await storage.getModel(currentApiDefId, currentModelId);

          // Cost = (tokens / 1M) * cacheWritePrice
          const cost =
            (contextWindowUsage / 1_000_000) * (model?.cacheWritePrice ?? model?.inputPrice ?? 0);

          setShouldShowWarning(true);
          setEstimatedCost(cost);
        }
      }
    };

    checkCacheInvalidation();
  }, [messages, currentApiDefId, currentModelId]);

  if (!shouldShowWarning) {
    return null;
  }

  return (
    <div className="mx-4 mb-4 text-xs text-gray-500">
      ⚠️ Cache likely expired. Next message will cost at least ${estimatedCost.toFixed(2)}
    </div>
  );
}
