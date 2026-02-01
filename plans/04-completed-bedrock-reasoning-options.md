This plan has been completed

# Bedrock Reasoning Options Implementation Plan

[Overview]
Add unified reasoning configuration UI that supports Bedrock models (Claude, Nova, DeepSeek) alongside existing Anthropic and OpenAI providers.

This plan consolidates reasoning options into a single section with a global enable toggle, eliminating the confusing "Other Provider Config" section. The unified design shows all provider-specific options in one place, properly grouped by provider type. Backend changes ensure Bedrock sends the correct reasoning configuration format for each model type.

[Types]
Add Bedrock-specific type mappings and update existing reasoning types.

**No new types needed in `src/types/index.ts`:**

- Existing `ReasoningEffort` type already covers the needed values
- Existing `Project` interface already has `enableReasoning`, `reasoningBudgetTokens`, `thinkingKeepTurns`, `reasoningEffort`, `reasoningSummary`

**Internal type for Bedrock model detection (in bedrockClient.ts):**

```typescript
type BedrockModelReasoningType = 'claude-3' | 'claude-4' | 'nova2' | 'deepseek' | 'none';
```

[Files]
UI component consolidation and backend Bedrock updates.

**Files to modify:**

1. `src/components/project/ProjectSettingsView.tsx` - Replace separate reasoning sections with unified section, remove "Other Provider Config"
2. `src/components/project/AnthropicReasoningConfig.tsx` - Refactor to be embeddable subsection (remove header mode)
3. `src/components/project/OpenAIReasoningConfig.tsx` - Refactor to be embeddable subsection (remove header mode)
4. `src/services/api/bedrockClient.ts` - Add model detection and reasoning config logic for Claude 4+, Nova, DeepSeek
5. `src/services/api/responsesClient.ts` - Skip reasoning params when `enableReasoning: false`
6. `src/services/api/openaiClient.ts` - Skip reasoning params when `enableReasoning: false`

**Files that may need updates:**

- `src/hooks/useChat.ts` - Verify reasoning options flow correctly to API clients
- `src/services/agentic/agenticLoopGenerator.ts` - Verify options passthrough

[Functions]
Model detection and reasoning config builders for Bedrock.

**New functions in `src/services/api/bedrockClient.ts`:**

- `detectBedrockReasoningType(modelId: string): BedrockModelReasoningType` - Detect model type from modelId prefix
- `buildReasoningConfig(modelType: BedrockModelReasoningType, options: StreamOptions): DocumentType | undefined` - Build appropriate reasoning config object

**Modified functions:**

- `BedrockClient.sendMessageStream()` - Use new reasoning config builder instead of hardcoded `thinking` object
- `ResponsesClient.sendMessageStream()` - Conditionally include reasoning params based on `enableReasoning`
- `OpenAIClient.sendMessageStream()` - Conditionally include reasoning params based on `enableReasoning`

[Classes]
No new classes. Minor modifications to existing API client classes.

**Modified classes:**

- `BedrockClient` - Add reasoning type detection and config building
- `ResponsesClient` - Conditional reasoning param inclusion
- `OpenAIClient` - Conditional reasoning param inclusion (if applicable)

[Dependencies]
No new dependencies required.

All necessary AWS SDK types are already available via `@aws-sdk/client-bedrock-runtime`.

[Testing]
Update existing tests and add Bedrock reasoning tests.

**New tests:**

- `src/services/api/__tests__/bedrockClient.test.ts` - Test reasoning config generation for each model type
  - Claude 3.x → `thinking` format
  - Claude 4+ → `reasoning_config` format
  - Nova → `reasoningConfig` with `maxReasoningEffort` mapping
  - DeepSeek → `showThinking` boolean

**Modified tests:**

- Update any existing tests that mock reasoning options

[Implementation Order]
Phased implementation to minimize risk.

**Phase 1: Backend - Bedrock Reasoning Config**

- [x] Add `detectBedrockReasoningType()` function to detect model type from modelId
- [x] Add `buildReasoningConfig()` function to generate appropriate config object
- [x] Update `BedrockClient.sendMessageStream()` to use new functions
- [x] Add unit tests for Bedrock reasoning config generation

**Phase 2: Backend - OpenAI Conditional Reasoning**

- [x] Update `ResponsesClient.sendMessageStream()` to skip reasoning when `enableReasoning: false`
- [x] Update `OpenAIClient.sendMessageStream()` similarly if needed
- [x] Verify existing tests still pass

**Phase 3: UI - Unified Reasoning Section**

- [x] Refactor `AnthropicReasoningConfig` to embedded mode only (remove toggle header)
- [x] Refactor `OpenAIReasoningConfig` to embedded mode only (remove header)
- [x] Create unified Reasoning section in `ProjectSettingsView`:
  - Global "Enable Reasoning" toggle in section header
  - "Anthropic / Bedrock Claude" subsection with Budget Tokens + Keep Thinking Turns
  - "OpenAI / Bedrock Nova / DeepSeek" subsection with Reasoning Effort + Reasoning Summary
- [x] Remove "Other Provider Config" section entirely

**Phase 4: Testing & Documentation**

- [x] Verify existing tests still pass (1686 tests passing)
- [x] Update `development.md` with new reasoning architecture

---

## Bedrock Model Detection Logic

```typescript
function detectBedrockReasoningType(modelId: string): BedrockModelReasoningType {
  // Normalize: handle both raw modelId and inference profile format
  // Inference profiles: "us.anthropic.claude-3-5-sonnet-20241022-v2:0"
  // Raw: "anthropic.claude-3-5-sonnet-20241022-v2:0"

  const normalizedId = modelId.toLowerCase();

  // Claude detection
  if (normalizedId.includes('anthropic.claude')) {
    // Claude 4+ uses reasoning_config (claude-4, claude-opus-4, claude-sonnet-4, etc.)
    if (
      normalizedId.includes('claude-4') ||
      normalizedId.includes('claude-opus-4') ||
      normalizedId.includes('claude-sonnet-4')
    ) {
      return 'claude-4';
    }
    // Claude 3.x uses thinking
    return 'claude-3';
  }

  // Nova 2 detection (Nova 1 doesn't support reasoning)
  if (normalizedId.includes('amazon.nova-2')) {
    return 'nova2';
  }

  // DeepSeek detection
  if (normalizedId.includes('deepseek')) {
    return 'deepseek';
  }

  return 'none';
}
```

## Reasoning Config Mapping

| Model Type | Config Key         | Format                                                             |
| ---------- | ------------------ | ------------------------------------------------------------------ |
| claude-3   | `thinking`         | `{ type: 'enabled', budget_tokens: N }`                            |
| claude-4   | `reasoning_config` | `{ type: 'enabled', budget_tokens: N }`                            |
| nova2      | `reasoningConfig`  | `{ type: 'enabled', maxReasoningEffort: 'low'\|'medium'\|'high' }` |
| deepseek   | `showThinking`     | `true`                                                             |
| none       | (omit)             | -                                                                  |

## Reasoning Effort Mapping for Nova 2

Nova only supports `low`, `medium`, `high`. Map from full `ReasoningEffort`:

| Input     | Nova Output |
| --------- | ----------- |
| none      | low         |
| minimal   | low         |
| low       | low         |
| medium    | medium      |
| high      | high        |
| xhigh     | high        |
| undefined | medium      |
