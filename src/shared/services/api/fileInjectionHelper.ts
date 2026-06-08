export type InjectedFile = { path: string; content: string };
export type InjectionMode = 'inline' | 'separate-block' | 'as-file' | 'mock-tool-call';

/** Downgrade injection mode for providers that don't support it natively. */
export function effectiveInjectionMode(
  requested: InjectionMode | undefined,
  apiType: string
): InjectionMode {
  if (!requested || requested === 'inline') return 'inline';
  // mock-tool-call operates at the message level, not content block level — passes through for all APIs
  if (requested === 'mock-tool-call') return 'mock-tool-call';
  if (requested === 'as-file') {
    if (['anthropic', 'chatgpt', 'responses_api', 'bedrock'].includes(apiType)) return 'as-file';
    return 'separate-block';
  }
  if (requested === 'separate-block') {
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
