/**
 * StreamingContentAssembler - Assembles StreamChunk events into RenderingBlockGroup[]
 *
 * This class maintains object stability for React optimization:
 * - Groups array gets new elements but existing elements keep their reference
 * - Each RenderingBlockGroup object is stable while content is appended
 * - Each RenderingContentBlock object is stable while text is appended
 */

import type { StreamChunk } from '../api/baseClient';
import type {
  ErrorRenderBlock,
  RenderingBlockGroup,
  RenderingContentBlock,
  TextRenderBlock,
  ThinkingRenderBlock,
  ToolUseRenderBlock,
  WebFetchRenderBlock,
  WebSearchRenderBlock,
  WebSearchResult,
} from '../../types/content';
import { categorizeBlock } from '../../types/content';

export interface StreamingAssemblerOptions {
  /** Optional callback to get tool icon by name (for streaming display) */
  getToolIcon?: (toolName: string) => string | undefined;
}

export class StreamingContentAssembler {
  private groups: RenderingBlockGroup[] = [];
  private options: StreamingAssemblerOptions;
  private currentBlock: RenderingContentBlock | null = null;
  private webSearchMap: Map<string, WebSearchRenderBlock> = new Map();
  private webFetchMap: Map<string, WebFetchRenderBlock> = new Map();
  private lastEndedBlockType: string | null = null;
  private lastEvent: string = '';
  // Track pending citations for current text block (received before text)
  private pendingCitations: Array<{ url: string; title?: string; citedText?: string }> = [];

  constructor(options: StreamingAssemblerOptions = {}) {
    this.options = options;
  }

  /**
   * Process a streaming chunk and update internal state
   */
  pushChunk(chunk: StreamChunk): void {
    switch (chunk.type) {
      case 'thinking.start':
        this.handleThinkingStart();
        break;

      case 'thinking':
        this.handleThinkingDelta(chunk.content);
        break;

      case 'thinking.end':
        this.handleThinkingEnd();
        break;

      case 'content.start':
        this.handleContentStart();
        break;

      case 'content':
        this.handleContentDelta(chunk.content);
        break;

      case 'content.end':
        this.handleContentEnd();
        break;

      case 'web_search.start':
        this.handleWebSearchStart(chunk.id);
        break;

      case 'web_search':
        this.handleWebSearch(chunk.id, chunk.query);
        break;

      case 'web_search.result':
        this.handleWebSearchResult(chunk.tool_use_id, chunk.title, chunk.url);
        break;

      case 'web_fetch.start':
        this.handleWebFetchStart(chunk.id);
        break;

      case 'web_fetch':
        this.handleWebFetch(chunk.id, chunk.url);
        break;

      case 'web_fetch.result':
        this.handleWebFetchResult(chunk.tool_use_id, chunk.url, chunk.title);
        break;

      case 'citation':
        this.handleCitation(chunk.url, chunk.title, chunk.citedText);
        break;

      case 'event':
        this.lastEvent = chunk.content;
        break;

      case 'token_usage':
        // Ignore token_usage - not for rendering
        break;

      case 'tool_use':
        this.handleToolUse(chunk.id, chunk.name, chunk.input);
        break;
    }
  }

  /**
   * Get current groups (shallow copy for React re-render trigger)
   * Internal group and block objects keep their references
   */
  getGroups(): RenderingBlockGroup[] {
    return [...this.groups];
  }

  /**
   * Get the last event string for status display
   */
  getLastEvent(): string {
    return this.lastEvent;
  }

  /**
   * Reset the assembler to initial state
   */
  reset(): void {
    this.groups = [];
    this.currentBlock = null;
    this.webSearchMap.clear();
    this.webFetchMap.clear();
    this.lastEndedBlockType = null;
    this.lastEvent = '';
    this.pendingCitations = [];
  }

  /**
   * Finalize the assembled content with an error block appended.
   * Returns a deep copy of groups with the error block added.
   * This method does not modify the assembler's internal state.
   *
   * @param error - Error information to include in the error block
   * @returns A copy of groups with an error block appended
   */
  finalizeWithError(error: {
    message: string;
    status?: number;
    stack?: string;
  }): RenderingBlockGroup[] {
    // Deep copy groups to avoid mutation
    const resultGroups: RenderingBlockGroup[] = this.groups.map(group => ({
      category: group.category,
      blocks: [...group.blocks],
    }));

    // Create error block
    const errorBlock: ErrorRenderBlock = {
      type: 'error',
      message: error.message,
      ...(error.status !== undefined && { status: error.status }),
      ...(error.stack && { stack: error.stack }),
    };

    // Append to error group or create new one
    const lastGroup = resultGroups[resultGroups.length - 1];
    if (lastGroup && lastGroup.category === 'error') {
      lastGroup.blocks.push(errorBlock);
    } else {
      resultGroups.push({ category: 'error', blocks: [errorBlock] });
    }

    return resultGroups;
  }

  /**
   * Add a block to groups with on-the-fly grouping
   */
  private addBlockToGroups(block: RenderingContentBlock): void {
    const category = categorizeBlock(block);
    const lastGroup = this.groups[this.groups.length - 1];

    if (lastGroup && lastGroup.category === category) {
      // Same category - add to existing group
      lastGroup.blocks.push(block);
    } else {
      // Different category - create new group
      this.groups.push({ category, blocks: [block] });
    }
  }

  /**
   * Get the last text block from the last text group, if any
   */
  private getLastTextBlock(): TextRenderBlock | null {
    const lastGroup = this.groups[this.groups.length - 1];
    if (lastGroup && lastGroup.category === 'text') {
      const lastBlock = lastGroup.blocks[lastGroup.blocks.length - 1];
      if (lastBlock && lastBlock.type === 'text') {
        return lastBlock;
      }
    }
    return null;
  }

  // --- Handler methods ---

  private handleThinkingStart(): void {
    // Create new thinking block and add to groups immediately
    const thinkingBlock: ThinkingRenderBlock = { type: 'thinking', thinking: '' };
    this.currentBlock = thinkingBlock;
    this.addBlockToGroups(thinkingBlock);
    this.lastEndedBlockType = null;
  }

  private handleThinkingDelta(content: string): void {
    if (this.currentBlock && this.currentBlock.type === 'thinking') {
      (this.currentBlock as ThinkingRenderBlock).thinking += content;
    }
  }

  private handleThinkingEnd(): void {
    this.lastEndedBlockType = 'thinking';
    this.currentBlock = null;
  }

  private handleContentStart(): void {
    // Text block reuse strategy: if previous block was text, reuse it
    if (this.lastEndedBlockType === 'text') {
      const lastTextBlock = this.getLastTextBlock();
      if (lastTextBlock) {
        this.currentBlock = lastTextBlock;
        this.lastEndedBlockType = null;
        return;
      }
    }

    // Create new text block and add to groups
    const textBlock: TextRenderBlock = { type: 'text', text: '' };
    this.currentBlock = textBlock;
    this.addBlockToGroups(textBlock);
    this.lastEndedBlockType = null;
  }

  private handleContentDelta(content: string): void {
    if (this.currentBlock && this.currentBlock.type === 'text') {
      (this.currentBlock as TextRenderBlock).text += content;
    }
  }

  private handleContentEnd(): void {
    // Apply any pending citations to the current text block before ending
    if (this.pendingCitations.length > 0 && this.currentBlock?.type === 'text') {
      const textBlock = this.currentBlock as TextRenderBlock;
      const citationLinks = this.renderCitationLinks(this.pendingCitations);
      textBlock.text += citationLinks;
      this.pendingCitations = [];
    }
    this.lastEndedBlockType = 'text';
    this.currentBlock = null;
  }

  private handleWebSearchStart(id: string): void {
    // Create placeholder block with empty query - UI shows "Searching..." immediately
    const searchBlock: WebSearchRenderBlock = {
      type: 'web_search',
      id,
      query: '',
      results: [],
    };
    this.addBlockToGroups(searchBlock);
    this.webSearchMap.set(id, searchBlock);
    this.lastEndedBlockType = null;
  }

  private handleWebSearch(id: string, query: string): void {
    // Check if block already exists (from .start event)
    const existingBlock = this.webSearchMap.get(id);
    if (existingBlock) {
      // Update query on existing block
      existingBlock.query = query;
    } else {
      // Create new block (fallback for providers that send query immediately)
      const searchBlock: WebSearchRenderBlock = {
        type: 'web_search',
        id,
        query,
        results: [],
      };
      this.addBlockToGroups(searchBlock);
      this.webSearchMap.set(id, searchBlock);
    }
    this.lastEndedBlockType = null;
  }

  private handleWebSearchResult(toolUseId: string, title?: string, url?: string): void {
    const searchBlock = this.webSearchMap.get(toolUseId);
    if (searchBlock && title && url) {
      const result: WebSearchResult = { title, url };
      searchBlock.results.push(result);
    }
  }

  private handleWebFetchStart(id: string): void {
    // Create placeholder block with empty url - UI shows "Fetching..." immediately
    const fetchBlock: WebFetchRenderBlock = {
      type: 'web_fetch',
      url: '',
    };
    this.addBlockToGroups(fetchBlock);
    this.webFetchMap.set(id, fetchBlock);
    this.lastEndedBlockType = null;
  }

  private handleWebFetch(id: string, url: string): void {
    // Check if block already exists (from .start event)
    const existingBlock = this.webFetchMap.get(id);
    if (existingBlock) {
      // Update url on existing block
      existingBlock.url = url;
    } else {
      // Create new block (fallback for providers that send url immediately)
      const fetchBlock: WebFetchRenderBlock = {
        type: 'web_fetch',
        url,
      };
      this.addBlockToGroups(fetchBlock);
      this.webFetchMap.set(id, fetchBlock);
    }
    this.lastEndedBlockType = null;
  }

  private handleWebFetchResult(toolUseId: string, url: string, title?: string): void {
    const fetchBlock = this.webFetchMap.get(toolUseId);
    if (fetchBlock) {
      // Update the existing block with final result data
      fetchBlock.url = url;
      if (title) {
        fetchBlock.title = title;
      }
    }
  }

  private handleToolUse(id: string, name: string, input: Record<string, unknown>): void {
    const toolUseBlock: ToolUseRenderBlock = {
      type: 'tool_use',
      id,
      name,
      input,
      // Populate icon during streaming if callback provided
      icon: this.options.getToolIcon?.(name),
    };
    this.addBlockToGroups(toolUseBlock);
    this.lastEndedBlockType = null;
  }

  private handleCitation(url: string, title?: string, citedText?: string): void {
    // Store citation - will be rendered when text block ends
    this.pendingCitations.push({ url, title, citedText });
  }

  /**
   * Render pending citations as HTML anchor tags.
   */
  private renderCitationLinks(
    citations: Array<{ url: string; title?: string; citedText?: string }>
  ): string {
    return citations
      .map(c => {
        const href = this.escapeHtmlAttr(c.url);
        const title = this.escapeHtmlAttr(c.title || '');
        const cited = this.escapeHtmlAttr(c.citedText || '');
        return `<a href="${href}" target="_blank" rel="noopener noreferrer" title="${title}" data-cited="${cited}" class="citation-link">src</a>`;
      })
      .join(', ');
  }

  /**
   * Finalize the assembled content, returning a deep copy suitable for storage.
   * Applies any pending citations to the current text block.
   * This method does not modify the assembler's internal state.
   */
  finalize(): RenderingBlockGroup[] {
    // Deep copy groups
    const resultGroups: RenderingBlockGroup[] = this.groups.map(group => ({
      category: group.category,
      blocks: group.blocks.map(block => {
        if (block.type === 'text') {
          // Deep copy text block - may have citations appended
          return { ...block };
        }
        if (block.type === 'thinking') {
          return { ...block };
        }
        if (block.type === 'web_search') {
          return { ...block, results: [...block.results] };
        }
        if (block.type === 'web_fetch') {
          return { ...block };
        }
        if (block.type === 'error') {
          return { ...block };
        }
        return block;
      }),
    }));

    // Apply any pending citations to the last text block
    if (this.pendingCitations.length > 0) {
      const citationLinks = this.pendingCitations
        .map(c => {
          const href = this.escapeHtmlAttr(c.url);
          const title = this.escapeHtmlAttr(c.title || '');
          const cited = this.escapeHtmlAttr(c.citedText || '');
          return `<a href="${href}" target="_blank" rel="noopener noreferrer" title="${title}" data-cited="${cited}" class="citation-link">src</a>`;
        })
        .join(', ');

      // Find last text block and append citations
      for (let i = resultGroups.length - 1; i >= 0; i--) {
        const group = resultGroups[i];
        if (group.category === 'text') {
          for (let j = group.blocks.length - 1; j >= 0; j--) {
            const block = group.blocks[j];
            if (block.type === 'text') {
              (block as TextRenderBlock).text += citationLinks;
              return resultGroups;
            }
          }
        }
      }
    }

    return resultGroups;
  }

  /**
   * Escape HTML attribute value, including markdown/math special characters.
   * Uses HTML entities to prevent markdown parser from interpreting them.
   */
  private escapeHtmlAttr(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\$/g, '&#36;')
      .replace(/\*/g, '&#42;')
      .replace(/_/g, '&#95;')
      .replace(/`/g, '&#96;')
      .replace(/\[/g, '&#91;')
      .replace(/\]/g, '&#93;');
  }
}
