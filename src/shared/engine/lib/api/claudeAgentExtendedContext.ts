// Models that Claude Code / the Agent SDK runs at 200K unless the model id
// carries the `[1m]` suffix (e.g. `claude-opus-4-6[1m]`). Everything newer is
// natively 1M there, and Opus 4.5 / Sonnet 4.5 are 200K-only, so neither gets
// the suffix. Sonnet 4.6 would need it too, but its 1M variant requires usage
// credits on every Claude plan, so 1M is unsupported for it here and it runs
// at 200K (its claude-agent metadata entry says so).
// Source: code.claude.com/docs/en/model-config.
const CLAUDE_AGENT_1M_SUFFIX_PREFIXES = ['claude-opus-4-6'];

/**
 * Whether the claude-agent client must append `[1m]` to reach this model's 1M
 * window. Prefix match so dated ids and `anthropic.`-prefixed forms resolve.
 */
export function supportsClaudeAgent1mContext(modelId: string): boolean {
  const id = modelId.replace(/^anthropic\./, '');
  return CLAUDE_AGENT_1M_SUFFIX_PREFIXES.some(prefix => id.startsWith(prefix));
}
