export type InjectedFile = { path: string; content: string };
export type InjectionMode = 'inline' | 'separate-block' | 'as-file';

/** Downgrade injection mode for providers that don't support it natively. */
export function effectiveInjectionMode(
  requested: InjectionMode | undefined,
  apiType: string
): InjectionMode {
  if (!requested || requested === 'inline') return 'inline';
  if (requested === 'as-file') {
    if (['anthropic', 'chatgpt', 'responses_api', 'bedrock'].includes(apiType)) return 'as-file';
    return 'separate-block';
  }
  if (requested === 'separate-block') {
    if (apiType === 'webllm') return 'inline';
    return 'separate-block';
  }
  return 'inline';
}

/** Reconstruct inline text prefix from injected files (for inline fallback). */
export function buildInlinePrefix(files: InjectedFile[]): string {
  const sections = files.map(
    f => `=== ${f.path} ===\nHere's the content of ${f.path}:\n${f.content}`
  );
  return sections.join('\n\n') + '\n\n=== end of files ===\n\n';
}
