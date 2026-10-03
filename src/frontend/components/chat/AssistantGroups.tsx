import type { RenderingBlockGroup } from '../../../shared/protocol/types/content';
import BackstageView from './BackstageView';
import ErrorBlockView from './ErrorBlockView';
import TextGroupView from './TextGroupView';

interface AssistantGroupsProps {
  groups: RenderingBlockGroup[];
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
 * and after. Group indexes therefore name the same group in both trees,
 * which the expanded-group handoff keys on.
 */
export default function AssistantGroups({
  groups,
  disableMath,
  streaming,
  expandedGroups,
  onGroupExpandedChange,
}: AssistantGroupsProps) {
  return groups.map((group, index) => (
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
  ));
}
