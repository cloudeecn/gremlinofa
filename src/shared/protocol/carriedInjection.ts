/**
 * Reading the injected files off a stored user message, so an edit can carry
 * them into the message that replaces it. Lives in `protocol/` because the
 * composer needs it; the matching builder is `buildCarriedUserContent` in
 * `services/api/fileInjectionHelper.ts`.
 */

import type {
  CarriedInjectedFile,
  CarriedInjection,
  MessageContent,
  RenderingBlockGroup,
  StoredInjectedFile,
} from './types';
import type { InjectedFileRenderBlock } from './types/content';

export const END_OF_FILES_MARKER = '=== end of files ===';

/** True when `injection` still holds a file, i.e. it counts as message content. */
export function carriesFiles(
  injection: CarriedInjection | null | undefined
): injection is CarriedInjection {
  return !!injection && injection.before.length + injection.after.length > 0;
}

/**
 * The `injected_file` blocks on each side of a user message's text group:
 * leading files render (and were sent) before the text, trailing ones after.
 * An inject-only message keeps an empty text group, so the split is the
 * group's category, not a text block.
 */
export function splitInjectedFileBlocks(groups: RenderingBlockGroup[] | undefined): {
  before: InjectedFileRenderBlock[];
  after: InjectedFileRenderBlock[];
} {
  const all = groups ?? [];
  const textGroupIdx = all.findIndex(g => g.category === 'text');
  const splitAt = textGroupIdx === -1 ? all.length : textGroupIdx;
  const pick = (side: RenderingBlockGroup[]) =>
    side
      .flatMap(g => g.blocks)
      .filter((b): b is InjectedFileRenderBlock => b.type === 'injected_file');
  return { before: pick(all.slice(0, splitAt)), after: pick(all.slice(splitAt)) };
}

/** Carried files as inline sections, in the separators `buildInlinePrefix` uses. */
export function joinCarriedSections(files: CarriedInjectedFile[]): string {
  return files.map(f => f.display).join('\n\n');
}

/**
 * The injected files of a user message, for an edit to carry into the message
 * that replaces it; `undefined` when it has none.
 *
 * Block-level and mock modes pair each file bar with its stored entry by
 * position, since the minion tool writes both from one list. `inline` stores no
 * entries, so the bars are the source: a bar's text and the section the model
 * read both come from `buildInlineSection(entry, label)`, byte for byte. That
 * producer invariant is the only reason render content may feed model input
 * here. Stored entries that don't line up with the bars fall back to the same
 * inline reading rather than dropping files the user can see.
 */
export function extractCarriedInjection(
  content: MessageContent<unknown>
): CarriedInjection | undefined {
  const split = splitInjectedFileBlocks(content.renderingContent);
  // A failed read never reached the model (the minion tool aborts the call)
  const bars = {
    before: split.before.filter(b => !b.error),
    after: split.after.filter(b => !b.error),
  };
  if (bars.before.length + bars.after.length === 0) return undefined;

  const mode = content.injectionMode ?? 'inline';
  if (mode !== 'inline') {
    const storedBefore = content.injectedFiles ?? [];
    const storedAfter = content.injectedFilesAfter ?? [];
    if (storedBefore.length === bars.before.length && storedAfter.length === bars.after.length) {
      const pair = (stored: StoredInjectedFile[]) => (b: InjectedFileRenderBlock, i: number) => ({
        path: b.path,
        display: b.content,
        entry: stored[i],
      });
      return {
        mode,
        before: bars.before.map(pair(storedBefore)),
        after: bars.after.map(pair(storedAfter)),
        endMarker: false,
      };
    }
    console.debug(
      '[fileInjection] stored entries do not match the file bars, carrying inline: %o',
      {
        mode,
        bars: [bars.before.length, bars.after.length],
        stored: [storedBefore.length, storedAfter.length],
      }
    );
  }

  const toCarried = (b: InjectedFileRenderBlock) => ({ path: b.path, display: b.content });
  const before = bars.before.map(toCarried);
  return {
    mode: 'inline',
    before,
    after: bars.after.map(toCarried),
    endMarker:
      before.length > 0 &&
      content.content.startsWith(`${joinCarriedSections(before)}\n\n${END_OF_FILES_MARKER}`),
  };
}
