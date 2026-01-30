/**
 * Bedrock FullContent Accumulator
 *
 * Accumulates streaming chunks to build the fullContent (ContentBlock[]) array.
 * The fullContent is what gets stored and sent back to the API in future turns.
 *
 * Handles all 6 content block types:
 * - TextMember: { text: string }
 * - ToolUseMember: { toolUse: { toolUseId, name, input } }
 * - ToolResultMember: { toolResult: { toolUseId, content, status } }
 * - ReasoningContentMember: { reasoningContent: { reasoningText | redactedContent } }
 * - CitationsContentMember: { citationsContent: { content?, citations? } }
 * - ImageMember: { image: { format, source } }
 *
 * Block ordering is preserved exactly as received from the stream to maintain
 * context integrity for models.
 *
 * NOTE: Uint8Array fields (redactedContent, image bytes) are stored as base64 strings
 * for JSON serialization. bedrockClient.convertMessages() converts back to Uint8Array.
 */

import type {
  ContentBlock,
  ConverseStreamOutput,
  ToolResultContentBlock,
  ImageFormat,
  CitationLocation,
} from '@aws-sdk/client-bedrock-runtime';
import type { DocumentType } from '@smithy/types';

/**
 * Convert Uint8Array to base64 string for JSON serialization
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Citation being accumulated from stream deltas
 */
interface PendingCitation {
  title?: string;
  source?: string;
  sourceContent?: Array<{ text?: string }>;
  location?: CitationLocation;
}

/**
 * Tracks the state of a content block being accumulated
 */
interface PendingBlock {
  type: 'text' | 'toolUse' | 'toolResult' | 'reasoning' | 'citationsContent' | 'image';
  // Text block
  text?: string;
  // Tool use block
  toolUseId?: string;
  toolUseName?: string;
  toolUseInput?: string;
  // Tool result block
  toolResultId?: string;
  toolResultType?: string;
  toolResultStatus?: 'success' | 'error';
  toolResultContent?: ToolResultContentBlock[];
  // Reasoning block - can have reasoningText OR redactedContent
  reasoningText?: string;
  reasoningSignature?: string;
  reasoningRedactedBase64?: string; // Store as base64 for JSON serialization
  // Citations block - accumulate citations array
  citationsContent?: Array<{ text?: string }>; // Generated content
  citations?: PendingCitation[];
  // Image block
  imageFormat?: ImageFormat;
  imageBytes?: Uint8Array[];
}

/**
 * Accumulator for building fullContent from streaming chunks.
 */
export class BedrockFullContentAccumulator {
  private blocks: ContentBlock[] = [];
  private pendingBlock: PendingBlock | null = null;

  /**
   * Handle raw Bedrock stream events for more detailed accumulation.
   * This is called from bedrockClient with the raw event data.
   *
   * Uses ConverseStreamOutput from SDK - we access specific event types
   * (contentBlockStart, contentBlockDelta, contentBlockStop) directly.
   */
  pushRawEvent(event: ConverseStreamOutput): void {
    if (event.contentBlockStart) {
      const start = event.contentBlockStart.start;
      if (start?.toolUse) {
        this.pendingBlock = {
          type: 'toolUse',
          toolUseId: start.toolUse.toolUseId,
          toolUseName: start.toolUse.name,
          toolUseInput: '',
        };
      } else if (start?.toolResult) {
        this.pendingBlock = {
          type: 'toolResult',
          toolResultId: start.toolResult.toolUseId,
          toolResultType: start.toolResult.type,
          toolResultStatus: start.toolResult.status,
          toolResultContent: [],
        };
      } else if (start?.image) {
        this.pendingBlock = {
          type: 'image',
          imageFormat: start.image.format,
          imageBytes: [],
        };
      } else {
        // Default to text block
        this.pendingBlock = { type: 'text', text: '' };
      }
    } else if (event.contentBlockDelta) {
      const delta = event.contentBlockDelta.delta;
      if (!delta) return;

      if (delta.text !== undefined) {
        if (this.pendingBlock?.type === 'text') {
          this.pendingBlock.text = (this.pendingBlock.text || '') + delta.text;
        } else if (!this.pendingBlock) {
          this.pendingBlock = { type: 'text', text: delta.text };
        }
      } else if (delta.toolUse?.input !== undefined && this.pendingBlock?.type === 'toolUse') {
        this.pendingBlock.toolUseInput =
          (this.pendingBlock.toolUseInput || '') + delta.toolUse.input;
      } else if (delta.toolResult && this.pendingBlock?.type === 'toolResult') {
        // Accumulate tool result content blocks
        for (const item of delta.toolResult) {
          if (item.text !== undefined) {
            this.pendingBlock.toolResultContent!.push({ text: item.text });
          } else if (item.json !== undefined) {
            this.pendingBlock.toolResultContent!.push({ json: item.json });
          }
        }
      } else if (delta.reasoningContent) {
        if (this.pendingBlock?.type === 'reasoning') {
          // Accumulate text deltas
          if (delta.reasoningContent.text) {
            this.pendingBlock.reasoningText =
              (this.pendingBlock.reasoningText || '') + delta.reasoningContent.text;
          }
          // Accumulate redactedContent as base64 (for JSON serialization)]
          // TODO: slop
          if (delta.reasoningContent.redactedContent) {
            const base64Chunk = uint8ArrayToBase64(delta.reasoningContent.redactedContent);
            this.pendingBlock.reasoningRedactedBase64 =
              (this.pendingBlock.reasoningRedactedBase64 || '') + base64Chunk;
          }
          // Signature comes at the end
          if (delta.reasoningContent.signature) {
            this.pendingBlock.reasoningSignature = delta.reasoningContent.signature;
          }
        } else if (!this.pendingBlock) {
          this.pendingBlock = {
            type: 'reasoning',
            reasoningText: delta.reasoningContent.text || '',
            reasoningSignature: delta.reasoningContent.signature || '',
            reasoningRedactedBase64: delta.reasoningContent.redactedContent
              ? uint8ArrayToBase64(delta.reasoningContent.redactedContent)
              : undefined,
          };
        }
      } else if (delta.citation) {
        // Accumulate citation into pending citationsContent block
        if (!this.pendingBlock || this.pendingBlock.type !== 'citationsContent') {
          this.pendingBlock = {
            type: 'citationsContent',
            citationsContent: [],
            citations: [],
          };
        }
        // Each citation delta represents a citation to add
        if (this.pendingBlock.type === 'citationsContent') {
          const citation: PendingCitation = {
            title: delta.citation.title,
            source: delta.citation.source,
            sourceContent: delta.citation.sourceContent,
            location: delta.citation.location,
          };
          this.pendingBlock.citations = this.pendingBlock.citations || [];
          this.pendingBlock.citations.push(citation);
        }
      } else if (delta.image?.source?.bytes && this.pendingBlock?.type === 'image') {
        this.pendingBlock.imageBytes!.push(delta.image.source.bytes);
      }
    } else if (event.contentBlockStop) {
      this.finalizeBlock();
    }
  }

  /**
   * Finalize the current pending block and add it to blocks array.
   */
  private finalizeBlock(): void {
    if (!this.pendingBlock) return;

    switch (this.pendingBlock.type) {
      case 'text':
        if (this.pendingBlock.text) {
          this.blocks.push({ text: this.pendingBlock.text });
        }
        break;

      case 'toolUse':
        if (this.pendingBlock.toolUseId && this.pendingBlock.toolUseName) {
          let input: DocumentType = {};
          if (this.pendingBlock.toolUseInput) {
            try {
              input = JSON.parse(this.pendingBlock.toolUseInput) as DocumentType;
            } catch {
              // Invalid JSON, use empty object
            }
          }
          this.blocks.push({
            toolUse: {
              toolUseId: this.pendingBlock.toolUseId,
              name: this.pendingBlock.toolUseName,
              input,
            },
          });
        }
        break;

      case 'toolResult':
        if (this.pendingBlock.toolResultId) {
          this.blocks.push({
            toolResult: {
              toolUseId: this.pendingBlock.toolResultId,
              content: this.pendingBlock.toolResultContent || [],
              status: this.pendingBlock.toolResultStatus,
            },
          });
        }
        break;

      case 'reasoning':
        // ReasoningContentBlock can be either reasoningText or redactedContent (mutually exclusive)
        if (this.pendingBlock.reasoningRedactedBase64) {
          // Store redactedContent as base64 string for JSON serialization
          // bedrockClient.convertMessages() will convert back to Uint8Array when sending to API
          this.blocks.push({
            reasoningContent: {
              redactedContent: this.pendingBlock.reasoningRedactedBase64 as unknown as Uint8Array,
            },
          } as ContentBlock);
        } else if (this.pendingBlock.reasoningText) {
          this.blocks.push({
            reasoningContent: {
              reasoningText: {
                text: this.pendingBlock.reasoningText,
                signature: this.pendingBlock.reasoningSignature || undefined,
              },
            },
          });
        }
        break;

      case 'citationsContent':
        // Build CitationsContentBlock structure
        // Use type casts to bypass SDK's discriminated union types
        if (this.pendingBlock.citations?.length || this.pendingBlock.citationsContent?.length) {
          const citationsBlock: Record<string, unknown> = {};

          // Add generated content if present
          if (this.pendingBlock.citationsContent?.length) {
            citationsBlock.content = this.pendingBlock.citationsContent.map(c => ({
              text: c.text,
            }));
          }

          // Add citations array
          if (this.pendingBlock.citations?.length) {
            citationsBlock.citations = this.pendingBlock.citations.map(c => ({
              title: c.title,
              source: c.source,
              sourceContent: c.sourceContent?.map(sc => ({ text: sc.text })),
              location: c.location,
            }));
          }

          this.blocks.push({ citationsContent: citationsBlock } as ContentBlock);
        }
        break;

      case 'image':
        if (this.pendingBlock.imageFormat && this.pendingBlock.imageBytes?.length) {
          // Combine all byte chunks
          const totalLength = this.pendingBlock.imageBytes.reduce(
            (sum, arr) => sum + arr.length,
            0
          );
          const combined = new Uint8Array(totalLength);
          let offset = 0;
          for (const chunk of this.pendingBlock.imageBytes) {
            combined.set(chunk, offset);
            offset += chunk.length;
          }
          this.blocks.push({
            image: {
              format: this.pendingBlock.imageFormat,
              source: { bytes: combined },
            },
          });
        }
        break;
    }

    this.pendingBlock = null;
  }

  /**
   * Finalize and return the fullContent array.
   * Call this after all chunks have been processed.
   */
  finalize(): ContentBlock[] {
    // Finalize any remaining pending block
    this.finalizeBlock();
    return this.blocks;
  }

  /**
   * Get accumulated text content (for textContent in StreamResult).
   */
  getTextContent(): string {
    let text = '';
    for (const block of this.blocks) {
      if ('text' in block && block.text) {
        text += block.text;
      }
    }
    // Include any pending text block
    if (this.pendingBlock?.type === 'text' && this.pendingBlock.text) {
      text += this.pendingBlock.text;
    }
    return text;
  }

  /**
   * Get accumulated thinking content (for thinkingContent in StreamResult).
   */
  getThinkingContent(): string | undefined {
    let thinking = '';
    for (const block of this.blocks) {
      if ('reasoningContent' in block && block.reasoningContent) {
        const rc = block.reasoningContent;
        if ('reasoningText' in rc && rc.reasoningText?.text) {
          thinking += rc.reasoningText.text;
        }
      }
    }
    // Include any pending reasoning block
    if (this.pendingBlock?.type === 'reasoning' && this.pendingBlock.reasoningText) {
      thinking += this.pendingBlock.reasoningText;
    }
    return thinking || undefined;
  }
}
