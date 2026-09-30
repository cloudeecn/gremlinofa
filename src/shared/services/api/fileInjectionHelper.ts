import { END_OF_FILES_MARKER, joinCarriedSections } from '../../protocol/carriedInjection';
import { generateUniqueId } from '../../protocol/idGenerator';
import type {
  CarriedInjectedFile,
  CarriedInjection,
  InjectionMode,
  Message,
  MessageContent,
  StoredInjectedFile,
} from '../../protocol/types';
import type { InjectedFileRenderBlock } from '../../protocol/types/content';

export type { InjectionMode };
export type InjectedFile = StoredInjectedFile;

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
  const endMarker = anyDefaultFraming ? `${END_OF_FILES_MARKER}\n\n` : '';
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

/**
 * Inline assembly: leading files, end marker, message, trailing files. With
 * no message text the separators around it would leave the payload starting
 * or ending in blank lines, so an inject-only call is trimmed; a real message
 * keeps its exact bytes.
 */
export function buildInlineContent(
  prefix: string,
  endMarker: string,
  message: string,
  suffix: string
): string {
  const assembled = prefix + endMarker + message + suffix;
  return message === '' ? assembled.trim() : assembled;
}

/**
 * The synthetic assistant `tool_use` + user `tool_result` pair that delivers
 * one file in `mock-tool-call` mode, as if the model had read it with the
 * filesystem tool. `display` is the file bar text shown on the assistant turn.
 */
export function buildMockToolCallPair(
  file: InjectedFile,
  display: string
): [Message<string>, Message<string>] {
  const toolUseId = generateUniqueId('toolu');
  const assistantMsg: Message<string> = {
    id: generateUniqueId('msg_assistant'),
    role: 'assistant',
    content: {
      type: 'text',
      content: '',
      renderingContent: [
        {
          category: 'backstage',
          blocks: [{ type: 'injected_file', path: file.path, content: display }],
        },
      ],
      // toolCalls, not fullContent: the pair has to replay on any provider
      toolCalls: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'filesystem',
          input: { action: 'readFile', path: file.path },
        },
      ],
    },
    timestamp: new Date(),
  };
  const resultMsg: Message<string> = {
    id: generateUniqueId('msg_user'),
    role: 'user',
    content: {
      type: 'text',
      content: '',
      renderingContent: [],
      // file.content is already line-numbered when the caller wanted that;
      // custom framing wraps it inside the result
      toolResults: [
        { type: 'tool_result', tool_use_id: toolUseId, content: wrapInjectedFile(file) },
      ],
    },
    timestamp: new Date(),
  };
  return [assistantMsg, resultMsg];
}

export interface CarriedUserContent {
  /** What the model reads as the message text; `inline` splices the sections around it. */
  content: string;
  /** Injection fields to spread into the message content. */
  fields: Pick<MessageContent<unknown>, 'injectedFiles' | 'injectedFilesAfter' | 'injectionMode'>;
  leadingBlocks: InjectedFileRenderBlock[];
  trailingBlocks: InjectedFileRenderBlock[];
  /** `mock-tool-call`: files to deliver as synthetic tool pairs after the message. */
  mockFiles: Array<{ entry: InjectedFile; display: string }>;
}

/**
 * Build a replacement user message around carried files, in the mode the
 * original used. `messageText` is what the user typed; `llmText` is that text
 * as the model gets it (with any message metadata).
 *
 * `mock-tool-call` gets the minion tool's two production-time downgrades to
 * `separate-block`: claude-agent owns its session history, and a pair needs a
 * user turn with text before it. Block-level modes are stored raw and
 * downgraded by each API client, as for minion messages.
 *
 * For `inline`, the end marker goes out only when the original had one and a
 * leading file is still kept. In a batch that mixed default and custom framing,
 * removing every default-framed file keeps a marker nothing needs; harmless.
 */
export function buildCarriedUserContent(
  injection: CarriedInjection,
  messageText: string,
  llmText: string,
  apiType: string
): CarriedUserContent {
  const toBlock = (f: CarriedInjectedFile): InjectedFileRenderBlock => ({
    type: 'injected_file',
    path: f.path,
    content: f.display,
  });
  const leadingBlocks = injection.before.map(toBlock);
  const trailingBlocks = injection.after.map(toBlock);

  if (injection.mode === 'inline') {
    const { before, after } = injection;
    const prefix = before.length > 0 ? `${joinCarriedSections(before)}\n\n` : '';
    const marker = injection.endMarker && before.length > 0 ? `${END_OF_FILES_MARKER}\n\n` : '';
    const suffix = after.length > 0 ? `\n\n${joinCarriedSections(after)}` : '';
    return {
      content: buildInlineContent(prefix, marker, llmText, suffix),
      fields: {},
      leadingBlocks,
      trailingBlocks,
      mockFiles: [],
    };
  }

  const entryOf = (f: CarriedInjectedFile): InjectedFile => {
    if (!f.entry) {
      throw new Error(`carried file ${f.path} has no stored entry for ${injection.mode} mode`);
    }
    return f.entry;
  };
  const before = injection.before.map(entryOf);
  const after = injection.after.map(entryOf);

  let mode: InjectionMode = injection.mode;
  if (mode === 'mock-tool-call') {
    mode = messageText === '' ? 'separate-block' : effectiveInjectionMode(mode, apiType);
  }

  return {
    content: llmText,
    fields: {
      ...(before.length > 0 && { injectedFiles: before }),
      ...(after.length > 0 && { injectedFilesAfter: after }),
      ...(before.length + after.length > 0 && { injectionMode: mode }),
    },
    leadingBlocks,
    trailingBlocks,
    mockFiles:
      mode === 'mock-tool-call'
        ? [...injection.before, ...injection.after].map(f => ({
            entry: entryOf(f),
            display: f.display,
          }))
        : [],
  };
}
