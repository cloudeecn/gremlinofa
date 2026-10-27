/**
 * Agent system prompt resolution.
 *
 * Both the minion tool and the chat-level agent config assemble a system
 * prompt the same way: an optional pre-persona ("global") preamble, an
 * optional persona file, inline text, then zero or more VFS prompt files —
 * joined with blank lines, empties dropped. This module owns that assembly
 * so the two paths cannot drift; a cloned minion chat reproduces the
 * minion's prompt precisely because both feed the same four inputs here.
 *
 * Namespace asymmetry (load-bearing): persona, pre-persona and prompt files
 * are ALWAYS read from the ROOT VFS, even when the agent itself runs
 * namespaced. A persona cannot be required to live inside its own sandbox —
 * `/minions/<persona>.md` is the definition of the sandbox's occupant, not
 * a file within it. Callers pass a root-namespace factory; do not "fix"
 * this by threading the agent's namespace in.
 */

import type { VfsAdapterFactory } from '../../protocol/types';
import type { VfsAdapter } from '../vfs/vfsAdapter';

/** Root VFS directory holding persona prompt files. */
export const MINION_VFS_ROOT = '/minions';

/**
 * Default pre-persona ("global") prompt file, prepended before persona
 * prompts. Optional infrastructure — absence is normal and silent.
 */
export const DEFAULT_PRE_PERSONA_FILE = `${MINION_VFS_ROOT}/_global.md`;

/** Root-VFS path of a persona's prompt file. */
export function personaPromptPath(persona: string): string {
  return `${MINION_VFS_ROOT}/${persona}.md`;
}

/** VFS namespace a namespaced persona runs under. */
export function personaNamespace(persona: string): string {
  return `${MINION_VFS_ROOT}/${persona}`;
}

export type AgentPromptErrorKind =
  'pre_persona_read_failed' | 'persona_not_found' | 'prompt_file_read_failed';

/**
 * Typed failure so each caller owns its error surface: the minion tool maps
 * these back to the exact recovery strings the LLM has been trained on, and
 * the chat path raises a `ProtocolError` instead.
 */
export class AgentPromptError extends Error {
  readonly kind: AgentPromptErrorKind;
  readonly path: string;
  /** `err.message` of the underlying read failure, '' when there was none. */
  readonly detail: string;

  constructor(kind: AgentPromptErrorKind, path: string, cause?: unknown) {
    const detail =
      cause === undefined ? '' : cause instanceof Error ? cause.message : String(cause);
    super(`${kind}: ${path}${detail ? ` (${detail})` : ''}`);
    this.name = 'AgentPromptError';
    this.kind = kind;
    this.path = path;
    this.detail = detail;
  }
}

export interface AgentPromptSpec {
  /**
   * ROOT-VFS adapter factory. Called at most once — see the namespace note
   * in the module doc comment.
   */
  createVfsAdapter: VfsAdapterFactory;
  /** Persona name. undefined / '' → no persona file is read. */
  persona?: string;
  /**
   * undefined → the default pre-persona file, read optionally;
   * '' → skipped entirely, no read at all;
   * any other path → required, a read failure throws.
   */
  prePersonaFile?: string;
  /** Inline text appended after the persona block, before the prompt files. */
  inlineSegments?: (string | undefined)[];
  /** VFS path(s) read and appended last, in order. */
  promptFiles?: string | string[];
}

/**
 * Resolve the agent's system prompt from its persona / file / inline inputs.
 *
 * Result is `[prePersona, persona, ...inline, ...files]` with empties dropped
 * and the rest joined by a blank line, so a present-but-empty file adds
 * nothing rather than a stray separator.
 *
 * @throws {AgentPromptError} on a required read failure — a missing custom
 * pre-persona file, a missing persona file, or any prompt file. The first
 * prompt-file failure aborts; later paths are not read.
 */
export async function resolveAgentSystemPrompt(spec: AgentPromptSpec): Promise<string> {
  // One adapter for all three phases, created on first use. Both the minion
  // and chat factories are pure constructors over stateless adapters; the
  // reuse is asserted in the unit tests so a future stateful factory trips.
  let adapter: VfsAdapter | undefined;
  const vfs = (): VfsAdapter => (adapter ??= spec.createVfsAdapter());

  const segments: (string | undefined)[] = [];

  if (spec.prePersonaFile !== '') {
    const path = spec.prePersonaFile ?? DEFAULT_PRE_PERSONA_FILE;
    try {
      segments.push(await vfs().readFile(path));
    } catch (err) {
      // The default file is optional infrastructure. Note the comparison is
      // against the resolved path, so an explicitly passed default path is
      // optional too — matching the minion tool's long-standing behaviour.
      if (path !== DEFAULT_PRE_PERSONA_FILE) {
        throw new AgentPromptError('pre_persona_read_failed', path, err);
      }
    }
  }

  if (spec.persona) {
    const path = personaPromptPath(spec.persona);
    try {
      segments.push(await vfs().readFile(path));
    } catch {
      // No cause detail: the minion's recovery message never carried one.
      throw new AgentPromptError('persona_not_found', path);
    }
  }

  segments.push(...(spec.inlineSegments ?? []));

  const promptFiles =
    typeof spec.promptFiles === 'string' ? [spec.promptFiles] : (spec.promptFiles ?? []);
  for (const path of promptFiles) {
    try {
      segments.push(await vfs().readFile(path));
    } catch (err) {
      throw new AgentPromptError('prompt_file_read_failed', path, err);
    }
  }

  return segments.filter(Boolean).join('\n\n');
}

/** One contributor to the resolved prompt, for preview / diagnostics. */
export interface ResolvedPromptSegment {
  source: 'pre-persona' | 'persona' | 'inline' | 'file';
  path?: string;
  text: string;
  /** Set when the read failed; `text` is '' in that case. */
  error?: string;
}

/**
 * Same resolution as `resolveAgentSystemPrompt`, but reporting each segment
 * and collecting failures instead of throwing on the first one.
 *
 * For the chat settings panel's preview, where "which of my four paths is
 * wrong" is the question being asked — an exception that names only the first
 * bad path would send the user round the loop once per typo. The run path
 * still uses the throwing variant: a half-resolved persona must not silently
 * become the agent's identity.
 */
export async function resolveAgentSystemPromptSegments(
  spec: AgentPromptSpec
): Promise<ResolvedPromptSegment[]> {
  let adapter: VfsAdapter | undefined;
  const vfs = (): VfsAdapter => (adapter ??= spec.createVfsAdapter());
  const segments: ResolvedPromptSegment[] = [];

  const read = async (source: ResolvedPromptSegment['source'], path: string, optional = false) => {
    try {
      const text = await vfs().readFile(path);
      if (text) segments.push({ source, path, text });
    } catch (err) {
      if (optional) return;
      segments.push({
        source,
        path,
        text: '',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  if (spec.prePersonaFile !== '') {
    const path = spec.prePersonaFile ?? DEFAULT_PRE_PERSONA_FILE;
    await read('pre-persona', path, path === DEFAULT_PRE_PERSONA_FILE);
  }
  if (spec.persona) {
    await read('persona', personaPromptPath(spec.persona));
  }
  for (const text of spec.inlineSegments ?? []) {
    if (text) segments.push({ source: 'inline', text });
  }
  const promptFiles =
    typeof spec.promptFiles === 'string' ? [spec.promptFiles] : (spec.promptFiles ?? []);
  for (const path of promptFiles) {
    await read('file', path);
  }

  return segments;
}
