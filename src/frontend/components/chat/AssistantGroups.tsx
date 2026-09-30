import type { RenderingBlockGroup } from '../../../shared/protocol/types/content';
import BackstageView from './BackstageView';
import ErrorBlockView from './ErrorBlockView';
import TextGroupView from './TextGroupView';

interface AssistantGroupsProps {
  groups: RenderingBlockGroup[];
  focusMode?: boolean;
  disableMath?: boolean;
  /** Live reply: markdown renders without filling the markdown cache */
  streaming?: boolean;
  /** Backstage groups (by index) that start expanded */
  expandedGroups?: ReadonlySet<number>;
  onGroupExpandedChange?: (groupIndex: number, expanded: boolean) => void;
}

/**
 * An assistant reply's rendering groups. The finished message and the live
 * one both render through here, so a reply looks the same while it streams
 * and after. Focus mode skips backstage groups without renumbering, so an
 * index names the same group in both trees (the expanded-group handoff keys
 * on it).
 */
export default function AssistantGroups({
  groups,
  focusMode,
  disableMath,
  streaming,
  expandedGroups,
  onGroupExpandedChange,
}: AssistantGroupsProps) {
  return groups.map((group, index) => {
    if (focusMode && group.category === 'backstage') return null;
    return (
      <div key={index} className="mb-2 last:mb-0">
        {group.category === 'backstage' ? (
          <BackstageView
            blocks={group.blocks}
            defaultExpanded={expandedGroups?.has(index) ?? false}
            disableMath={disableMath}
            onExpandedChange={
              onGroupExpandedChange && (expanded => onGroupExpandedChange(index, expanded))
            }
          />
        ) : group.category === 'error' ? (
          <ErrorBlockView blocks={group.blocks} />
        ) : (
          <div className="w-full bg-transparent py-2 text-gray-900">
            <TextGroupView blocks={group.blocks} disableMath={disableMath} streaming={streaming} />
          </div>
        )}
      </div>
    );
  });
}
