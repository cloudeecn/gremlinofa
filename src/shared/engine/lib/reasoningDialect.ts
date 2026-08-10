import type { APIDefinition, Model, ReasoningDialect } from '../../protocol/types';

/**
 * Pick the reasoning wire shape for a model/definition pair.
 *
 * Model metadata normally wins over the definition setting. That order matters:
 * Moonshot serves Kimi K2.x (`thinking: { type }`) and Kimi K3 (`reasoning_effort`)
 * from one endpoint, so a definition-level choice could never be right for both.
 * The definition setting is the fallback for models we have no metadata for —
 * gateways, self-hosted endpoints, anything discovery turns up unrecognized.
 *
 * An explicit `'openai'` on the model is a real answer, not an absence: it stops
 * a definition-level dialect from reaching a model that doesn't reason.
 *
 * `reasoningDialectOverride` flips the precedence, for a gateway that normalizes
 * every model it fronts — `deepseek/deepseek-chat` served through OpenRouter
 * speaks OpenRouter's shape, not DeepSeek's, even though the metadata that
 * matched its id says `thinking-object`. The `openrouter` dialect implies the
 * override, since that gateway always normalizes; anything else asks for it.
 */
export function resolveReasoningDialect(
  model?: Pick<Model, 'reasoningDialect' | 'deFactoThinking'>,
  apiDefinition?: Pick<APIDefinition, 'advancedSettings'>
): ReasoningDialect {
  const advanced = apiDefinition?.advancedSettings;
  const fromDefinition =
    advanced?.reasoningDialect ?? (advanced?.deFactoThinking ? 'thinking-object' : undefined);

  if (fromDefinition && (advanced?.reasoningDialectOverride || fromDefinition === 'openrouter')) {
    return fromDefinition;
  }

  if (model?.reasoningDialect) return model.reasoningDialect;
  if (model?.deFactoThinking !== undefined) {
    return model.deFactoThinking ? 'thinking-object' : 'openai';
  }

  return fromDefinition ?? 'openai';
}

/**
 * Whether a Keep Thinking Turns value asks the vendor to keep earlier turns'
 * reasoning (`reasoningHistoryParam`). `undefined`, `0` and `1` don't: the
 * vendor default already covers the current turn. `-1` and `2+` do; client-side
 * pruning, when on, still trims `2+` down to its window.
 */
export function wantsReasoningHistory(thinkingKeepTurns: number | undefined): boolean {
  return thinkingKeepTurns === -1 || (thinkingKeepTurns ?? 0) >= 2;
}
