// Models for which the Claude Agent SDK accepts the `[1m]` 1M-context suffix.
//
// This is deliberately distinct from the `supportsExtendedContext` metadata
// flag (which gates the regular Anthropic client's `context-1m-2025-08-07`
// beta header). The Agent SDK has no `betas` array — 1M is opted into by
// suffixing the model id (e.g. `claude-opus-4-8[1m]`) — and the eligible set
// differs: Opus 4.5 needs the suffix but carries no `supportsExtendedContext`
// flag, while Sonnet 4.6 runs at 1M natively and must NOT be suffixed.
const CLAUDE_AGENT_1M_PREFIXES = [
  'claude-sonnet-4-5',
  'claude-opus-4-5',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
];

/**
 * Whether the Claude Agent SDK accepts the `[1m]` 1M-context suffix for this
 * model. Prefix match (mirrors the metadata's `modelIdPrefix` style) so dated
 * ids (`claude-sonnet-4-5-20250929`) and `anthropic.`-prefixed forms resolve.
 */
export function supportsClaudeAgent1mContext(modelId: string): boolean {
  const id = modelId.replace(/^anthropic\./, '');
  return CLAUDE_AGENT_1M_PREFIXES.some(prefix => id.startsWith(prefix));
}
