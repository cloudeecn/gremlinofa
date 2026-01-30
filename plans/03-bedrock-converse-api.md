# Bedrock Converse API Support

## Problem / Request

Add support for AWS Bedrock Converse API as a new API provider. Bedrock provides access to Claude, Llama, Mistral, and Amazon Titan models through a unified API with Bearer token (API key) authentication.

## Design

### Authentication

Both AWS SDK v3 packages support Bearer token authentication via the `token` config option:

```typescript
import { BedrockClient } from '@aws-sdk/client-bedrock';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';

// Control plane (model discovery)
const bedrockClient = new BedrockClient({
  region: 'us-east-1',
  token: { token: apiKey },
  authSchemePreference: ['httpBearerAuth'],
});

// Data plane (inference)
const runtimeClient = new BedrockRuntimeClient({
  region: 'us-east-1',
  endpoint: baseUrl, // Custom endpoint support
  token: { token: apiKey },
  authSchemePreference: ['httpBearerAuth'],
});
```

This allows using simple API keys instead of AWS credentials (accessKeyId/secretAccessKey), which matches our existing pattern for other providers.

### SDK Packages

| Package                           | Purpose                                                | Bearer Auth |
| --------------------------------- | ------------------------------------------------------ | ----------- |
| `@aws-sdk/client-bedrock`         | `ListFoundationModelsCommand` - Model discovery        | ✅ Yes      |
| `@aws-sdk/client-bedrock-runtime` | `ConverseCommand`, `ConverseStreamCommand` - Inference | ✅ Yes      |

### API Type

Add `'bedrock'` to the `APIType` union. This creates a new provider type distinct from `'anthropic'` since:

- Different authentication mechanism
- Different endpoint format
- Different pricing
- Different model IDs (e.g., `anthropic.claude-3-5-sonnet-20241022-v2:0`)

### Streaming vs Non-Streaming

Bedrock Converse API supports both modes:

**Non-streaming:** `ConverseCommand`

- Returns complete `ConverseResponse` with:
  - `output.message` - Complete message with content blocks
  - `stopReason` - end_turn, tool_use, max_tokens, etc.
  - `usage` - inputTokens, outputTokens, cacheReadInputTokens, cacheWriteInputTokens
  - `metrics.latencyMs`

**Streaming:** `ConverseStreamCommand`

- Returns `ConverseStreamResponse` with event stream
- Events: `messageStart`, `contentBlockStart`, `contentBlockDelta`, `contentBlockStop`, `messageStop`, `metadata`

**Usage:**

- Default: Streaming enabled (better UX)
- `project.disableStream: true` → Use `ConverseCommand`
- Some models may not support streaming (`responseStreamingSupported: false` in model metadata)

### Message Format

Bedrock Converse API uses a similar structure to Anthropic but with some differences:

| Our Format                 | Bedrock Format                                   |
| -------------------------- | ------------------------------------------------ |
| `content.content` (string) | `content: ContentBlock[]` with `{ text: "..." }` |
| `attachments`              | `image: { format, source: { bytes } }`           |
| `tool_use` blocks          | `toolUse: { toolUseId, name, input }`            |
| `tool_result` blocks       | `toolResult: { toolUseId, content, status }`     |
| Thinking blocks            | `reasoningContent: { reasoningText: { text } }`  |

### Stream Events

Bedrock stream events map to our `StreamChunk` types:

| Bedrock Event                                   | StreamChunk                             |
| ----------------------------------------------- | --------------------------------------- |
| `contentBlockDelta.delta.text`                  | `{ type: 'content', content }`          |
| `contentBlockDelta.delta.reasoningContent.text` | `{ type: 'thinking', content }`         |
| `contentBlockStart.start.toolUse`               | (accumulate for tool_use)               |
| `contentBlockDelta.delta.toolUse.input`         | (accumulate for tool_use)               |
| `contentBlockStop` (tool_use)                   | `{ type: 'tool_use', id, name, input }` |
| `messageStop`                                   | close blocks                            |
| `metadata.usage`                                | `{ type: 'token_usage', ... }`          |

### Model Discovery

Use `ListFoundationModelsCommand` from `@aws-sdk/client-bedrock`:

```typescript
const response = await bedrockClient.send(new ListFoundationModelsCommand({}));
// response.modelSummaries contains:
// - modelId, modelName, providerName
// - inputModalities, outputModalities
// - responseStreamingSupported
// - modelLifecycle.status (ACTIVE/LEGACY)
```

Benefits:

- Dynamic model list based on user's account/region
- Automatically includes new models as AWS adds them
- Can filter by `responseStreamingSupported` for compatibility

Fallback: If API call fails, use hardcoded model list.

### Pricing

Bedrock pricing differs from direct Anthropic pricing and varies by region. We'll include US region pricing as default with model metadata matching via model ID prefix (e.g., `anthropic.claude-*`).

## Implementation Plan

### Phase 1: Types & Infrastructure ✅

- [x] Add `'bedrock'` to `APIType` union in `src/types/index.ts`
- [x] Add `bedrock` to `APIToolOverrides` interface
- [x] Add `bedrock` to `apiTypeUtils.ts` display names and icons

### Phase 2: Bedrock Client ✅

- [x] Create `src/services/api/bedrockClient.ts`
  - [x] Implement `APIClient` interface
  - [x] `discoverModels()` - use `ListFoundationModelsCommand`, fallback to hardcoded
  - [x] `sendMessageStream()`:
    - [x] Streaming path: `ConverseStreamCommand` (default)
    - [x] Non-streaming path: `ConverseCommand` (when `disableStream: true`)
    - [x] Yields `StreamChunk` events for both paths
  - [x] `migrateMessageRendering()` - convert Bedrock format to RenderingBlockGroup
  - [x] `extractToolUseBlocks()` - extract tool calls
  - [x] `buildToolResultMessage()` - format tool results
- [x] Register `BedrockClient` in `apiService.ts`

### Phase 3: Stream Mapper & FullContent Accumulator ✅

- [x] Create `src/services/api/bedrockStreamMapper.ts`
  - [x] Map Bedrock stream events to StreamChunk types
  - [x] Handle text content blocks
  - [x] Handle reasoning content blocks
  - [x] Handle tool use accumulation
  - [x] Handle token usage from metadata
- [x] Create helper to convert non-streaming response to StreamChunks
- [x] Create `src/services/api/bedrockFullContentAccumulator.ts`
  - [x] Accumulate all 6 ContentBlock types (Text, ToolUse, ToolResult, Reasoning, Citations, Image)
  - [x] Preserve exact block ordering as received from stream
  - [x] Integrate with bedrockClient.ts streaming path

### Phase 4: Model Metadata (Skipped due to no data)

- [ ] Create `src/services/api/model_metadatas/bedrock.ts`
  - [ ] Claude models on Bedrock (claude-3-5-sonnet, claude-3-5-haiku, etc.)
  - [ ] Llama models
  - [ ] Mistral models
  - [ ] Amazon Titan models
- [ ] Import in `modelMetadata.ts`

### Phase 5: API Service Integration ✅

- [x] Register `BedrockClient` in `src/services/api/apiService.ts`
- [x] Add default API definition creation in storage initialization

### Phase 6: Testing & Documentation ✅

- [x] Unit tests for `bedrockStreamMapper.ts` and `bedrockFullContentAccumulator.ts` (34 tests)
- [x] Skip model metadata matching tests (Phase 4 skipped due to no pricing data)
- [x] Update `development.md` with Bedrock client documentation

## Dependencies

- `@aws-sdk/client-bedrock` - For listing foundation models (installed)
- `@aws-sdk/client-bedrock-runtime` - For Converse API calls (installed)

## Notes

- Bedrock model IDs use format: `provider.model-name-version` (e.g., `anthropic.claude-3-5-sonnet-20241022-v2:0`)
- Cache support via `cachePoint` blocks (similar to Anthropic's cache_control)
- Web search not natively supported by Bedrock (would need external integration)
- Some models don't support streaming - check `responseStreamingSupported` from model metadata
