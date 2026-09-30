import type {
  RenderingBlockGroup,
  RenderingContentBlock,
  StreamingGroupsOp,
} from '../../protocol/types';

/**
 * Apply a batch of streaming ops (from `StreamingContentAssembler.takeOps()`)
 * to a groups array. Copy-on-write: the input array, its groups and blocks
 * are never mutated, so any state handed out earlier (a cached snapshot, a
 * React state value, an `init` payload) stays exactly as it was. Groups and
 * blocks no op touched keep their identity, which keeps memoized renders of
 * the finished part of a reply cheap.
 *
 * Returns `groups` itself when `ops` is empty. An op that doesn't fit the
 * current shape is dropped rather than thrown: the sender and receiver have
 * drifted, and the next `streaming_snapshot` or `reset` resyncs them.
 */
export function applyStreamingGroupsOps(
  groups: RenderingBlockGroup[],
  ops: readonly StreamingGroupsOp[]
): RenderingBlockGroup[] {
  if (ops.length === 0) return groups;

  const next = groups.slice();
  // Copies made by this call. Nobody else can see them yet, so later ops in
  // the same batch edit them in place instead of copying again per op.
  const ownedGroups = new Set<RenderingBlockGroup>();
  const ownedBlocks = new Set<RenderingContentBlock>();

  const ownGroup = (g: number): RenderingBlockGroup => {
    const group = next[g];
    if (ownedGroups.has(group)) return group;
    const copy = { ...group, blocks: group.blocks.slice() };
    next[g] = copy;
    ownedGroups.add(copy);
    return copy;
  };

  for (const op of ops) {
    switch (op.op) {
      case 'reset':
        next.length = 0;
        break;

      case 'add': {
        if (op.g === next.length) {
          const group: RenderingBlockGroup = { category: op.category, blocks: [op.block] };
          next.push(group);
          ownedGroups.add(group);
        } else if (op.g >= 0 && op.g === next.length - 1 && next[op.g].category === op.category) {
          ownGroup(op.g).blocks.push(op.block);
        } else {
          console.debug('[streamingOps] dropped %o', op);
        }
        break;
      }

      case 'append': {
        const block = next[op.g]?.blocks[op.b];
        if (!block || (block.type !== 'text' && block.type !== 'thinking')) {
          console.debug('[streamingOps] dropped %o', op);
          break;
        }
        if (ownedBlocks.has(block)) {
          if (block.type === 'text') block.text += op.text;
          else block.thinking += op.text;
          break;
        }
        const grown: RenderingContentBlock =
          block.type === 'text'
            ? { ...block, text: block.text + op.text }
            : { ...block, thinking: block.thinking + op.text };
        ownGroup(op.g).blocks[op.b] = grown;
        ownedBlocks.add(grown);
        break;
      }

      case 'put': {
        const group = next[op.g];
        if (!group || op.b < 0 || op.b >= group.blocks.length) {
          console.debug('[streamingOps] dropped %o', op);
          break;
        }
        ownGroup(op.g).blocks[op.b] = op.block;
        break;
      }
    }
  }

  return next;
}
