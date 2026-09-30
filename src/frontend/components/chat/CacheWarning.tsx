import { useEffect, useState } from 'react';
import { useApiDefinitions, useModels } from '../../hooks/useApp';
import type { Message } from '../../../shared/protocol/types';

/** Anthropic's default prompt-cache lifetime. */
const CACHE_TTL_MS = 5 * 60 * 1000;
/** setTimeout's ceiling; a skewed future timestamp must not overflow to "now". */
const MAX_TIMER_MS = 2 ** 31 - 1;

interface CacheWarningProps {
  messages: Message<unknown>[];
  currentApiDefId: string | null;
  currentModelId: string | null;
}

/**
 * Warns before a send that has to write the whole context back into
 * Anthropic's prompt cache: the last message is older than the cache TTL, or
 * came from another provider. Reads the API definitions and model prices the
 * app context already holds, so it costs no RPC per messages update.
 */
export default function CacheWarning({
  messages,
  currentApiDefId,
  currentModelId,
}: CacheWarningProps) {
  const apiDefinitions = useApiDefinitions();
  const models = useModels();
  const lastMessage = messages.at(-1);
  const expiresAt = lastMessage ? lastMessage.timestamp.getTime() + CACHE_TTL_MS : null;

  // Set by a timer at the expiry time, so the warning appears while the chat
  // sits open. Compared against the current expiry: a newer last message
  // moves it, and the warning clears.
  const [expiredAt, setExpiredAt] = useState<number | null>(null);
  useEffect(() => {
    if (expiresAt === null) return;
    const delay = Math.min(Math.max(0, expiresAt - Date.now()), MAX_TIMER_MS);
    const timer = setTimeout(() => setExpiredAt(expiresAt), delay);
    return () => clearTimeout(timer);
  }, [expiresAt]);

  if (!lastMessage || !currentApiDefId || !currentModelId) return null;

  const apiDef = apiDefinitions.find(d => d.id === currentApiDefId);
  if (apiDef?.apiType !== 'anthropic') return null;

  const isExpired = expiredAt === expiresAt;
  const isNotFromAnthropic = lastMessage.content.modelFamily !== 'anthropic';
  if (!isExpired && !isNotFromAnthropic) return null;

  const contextWindowUsage = lastMessage.metadata?.contextWindowUsage || 0;
  if (contextWindowUsage <= 0) return null;

  const model = models.get(currentApiDefId)?.find(m => m.id === currentModelId);
  // Cost = (tokens / 1M) * cacheWritePrice
  const estimatedCost =
    (contextWindowUsage / 1_000_000) * (model?.cacheWritePrice ?? model?.inputPrice ?? 0);

  return (
    <div className="mx-4 mb-4 text-xs text-gray-500">
      ⚠️ Cache likely expired. Next message will cost at least ${estimatedCost.toFixed(2)}
    </div>
  );
}
