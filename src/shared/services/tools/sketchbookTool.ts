/**
 * Sketchbook Tool
 *
 * Append-only notepad for the LLM to jot down free-form notes.
 * Each chat gets its own file at /sketchbook/<chatId>.md in the VFS.
 * Always responds "noted." on success.
 */

import type {
  ClientSideTool,
  ToolContext,
  ToolOptionDefinition,
  ToolOptions,
  ToolResult,
  ToolStreamEvent,
} from '../../protocol/types';
import type { VfsAdapter } from '../vfs/vfsAdapter';

const optionDefinitions: ToolOptionDefinition[] = [
  {
    type: 'boolean',
    id: 'noStore',
    label: 'No Store',
    subtitle: 'Skip storage, just acknowledge',
    default: false,
  },
];

async function appendToSketchbook(
  adapter: VfsAdapter,
  vfsPath: string,
  content: string
): Promise<void> {
  const fileExists = await adapter.exists(vfsPath);

  if (fileExists) {
    const existing = await adapter.readFile(vfsPath);
    await adapter.writeFile(vfsPath, existing + '\n---\n' + content);
  } else {
    // createFile auto-creates parent directories via ensureParentExists
    await adapter.createFile(vfsPath, content);
  }
}

// eslint-disable-next-line require-yield -- Simple tool: generator for interface compatibility, no streaming events
async function* executeSketchbook(
  input: Record<string, unknown>,
  toolOptions?: ToolOptions,
  context?: ToolContext
): AsyncGenerator<ToolStreamEvent, ToolResult, void> {
  if (toolOptions?.noStore) {
    return { content: 'noted.' };
  }

  if (!context?.vfsAdapter) {
    throw new Error('vfsAdapter is required');
  }

  const content = (input.content as string) ?? '';
  const name = typeof input.name === 'string' && input.name ? input.name : undefined;
  const fileSlug = context.chatId ?? '_default';
  const vfsPath = name ? `/sketchbook/${fileSlug}-${name}.md` : `/sketchbook/${fileSlug}.md`;

  try {
    await appendToSketchbook(context.vfsAdapter, vfsPath, content);
  } catch (error) {
    console.debug('[sketchbookTool] VFS write failed', error);
    return { content: 'Error, please retry.', isError: true };
  }

  return { content: 'noted.' };
}

export const sketchbookTool: ClientSideTool = {
  name: 'sketchbook',
  displayName: 'Sketchbook',
  displaySubtitle: 'Append-only notepad for drafts and working notes',
  optionDefinitions,

  description:
    'A sketchbook, you can use it to think out loud, draft ideas, outline plans before committing, keep a scratch pad of intermediate results, or jot down anything worth revisiting later.',

  inputSchema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'Text to append to the sketchbook',
      },
      name: {
        type: 'string',
        description: 'Optional name for the sketchbook file (creates a separate named sketchbook)',
      },
    },
    required: ['content'],
  },

  iconInput: '📓',
  iconOutput: '📓',

  renderInput: input => {
    const content = (input.content as string) ?? '';
    const name = typeof input.name === 'string' && input.name ? input.name : undefined;
    return name ? `Name: ${name}\n${content}` : content;
  },
  renderOutput: () => 'noted.',

  execute: executeSketchbook,
};
