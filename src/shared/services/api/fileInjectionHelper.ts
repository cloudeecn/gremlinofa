export type InjectedFile = {
  path: string;
  content: string;
  /** Custom text placed before the content, replacing the default "=== path ===" framing. */
  preamble?: string;
  /** Custom text placed after the content, replacing the default framing. */
  postamble?: string;
};
export type InjectionMode = 'inline' | 'separate-block' | 'as-file' | 'mock-tool-call';

/** Downgrade injection mode for providers that don't support it natively. */
export function effectiveInjectionMode(
  requested: InjectionMode | undefined,
  apiType: string
): InjectionMode {
  if (!requested || requested === 'inline') return 'inline';
  // mock-tool-call operates at the message level, not content block level — passes
  // through for every API except claude-agent, where the SDK owns the session
  // history and synthetic tool_use/tool_result message pairs can't be sent.
  if (requested === 'mock-tool-call') {
    return apiType === 'claude-agent' ? 'separate-block' : 'mock-tool-call';
  }
  if (requested === 'as-file') {
    // claude-agent is deliberately absent: whether the CLI passes document
    // blocks through its stream-json input is unverified. The client's
    // document branch is already implemented — adding 'claude-agent' here is
    // the whole flip once passthrough is confirmed.
    if (['anthropic', 'chatgpt', 'responses_api', 'bedrock'].includes(apiType)) return 'as-file';
    return 'separate-block';
  }
  if (requested === 'separate-block') {
    return 'separate-block';
  }
  return 'inline';
}

/** True when the caller supplied custom framing for this file. */
export function hasCustomFraming(file: InjectedFile): boolean {
  return file.preamble !== undefined || file.postamble !== undefined;
}

/**
 * Content wrapped in the caller's custom framing: preamble, content, and
 * postamble joined with newlines (absent parts skipped). Without custom
 * framing this is just the bare content.
 */
export function wrapInjectedFile(file: InjectedFile): string {
  if (!hasCustomFraming(file)) return file.content;
  const parts: string[] = [];
  if (file.preamble !== undefined) parts.push(file.preamble);
  parts.push(file.content);
  if (file.postamble !== undefined) parts.push(file.postamble);
  return parts.join('\n');
}

/** Text for a separate-block content block: custom framing or the default `=== path ===` header. */
export function buildSeparateBlockText(file: InjectedFile): string {
  return hasCustomFraming(file) ? wrapInjectedFile(file) : `=== ${file.path} ===\n${file.content}`;
}

/** One inline section: custom framing or the default header + intro line. */
export function buildInlineSection(file: InjectedFile, label = ''): string {
  return hasCustomFraming(file)
    ? wrapInjectedFile(file)
    : `=== ${file.path} ===\nHere's the content of ${file.path}${label}:\n${file.content}`;
}

/**
 * Reconstruct inline text prefix from injected files (for inline fallback).
 * The `=== end of files ===` marker is emitted only when at least one file
 * uses the default framing — an all-custom batch stays free of meta markers.
 */
export function buildInlinePrefix(files: InjectedFile[]): string {
  const sections = files.map(f => buildInlineSection(f));
  const anyDefaultFraming = files.some(f => !hasCustomFraming(f));
  const endMarker = anyDefaultFraming ? '=== end of files ===\n\n' : '';
  return sections.join('\n\n') + '\n\n' + endMarker;
}

/**
 * Inline text for files appended after the message (`injectFilesAfter`).
 * No `=== end of files ===` marker — nothing follows the trailing batch, so a
 * terminator would carry no information. Callers supply their own separator.
 */
export function buildInlineSuffix(files: InjectedFile[]): string {
  return files.map(f => buildInlineSection(f)).join('\n\n');
}
