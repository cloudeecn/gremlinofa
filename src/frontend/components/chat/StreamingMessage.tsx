import type { StreamingMessageProps } from './types';
import AssistantGroups from './AssistantGroups';
import BouncingDots from './BouncingDots';

/**
 * The reply being generated. Renders through the same `AssistantGroups` as a
 * finished assistant message (markdown included), so nothing jumps when the
 * reply completes; the frontend's 200ms streaming flush throttles the parses.
 */
export default function StreamingMessage({
  groups,
  focusMode,
  disableMath,
  dummyHookStatus,
  expandedGroups,
  onGroupExpandedChange,
}: StreamingMessageProps) {
  return (
    <div className="mb-4 px-4">
      <div className="w-full">
        {dummyHookStatus?.state === 'intercepting' && (
          <div className="mb-1 text-xs text-green-700">✨ DUMMY System: Intercepting...</div>
        )}
        <AssistantGroups
          groups={groups}
          focusMode={focusMode}
          disableMath={disableMath}
          streaming
          expandedGroups={expandedGroups}
          onGroupExpandedChange={onGroupExpandedChange}
        />
        <div className="mt-1">
          <BouncingDots />
        </div>
      </div>
    </div>
  );
}
