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
} from '../../types';
import * as vfs from '../vfs';

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
  projectId: string,
  vfsPath: string,
  content: string,
  namespace?: string
): Promise<void> {
  const fileExists = await vfs.exists(projectId, vfsPath, namespace);

  if (fileExists) {
    const existing = await vfs.readFile(projectId, vfsPath, namespace);
    await vfs.updateFile(projectId, vfsPath, existing + '\n---\n' + content, namespace);
  } else {
    // createFile auto-creates parent directories via ensureParentExists
    await vfs.createFile(projectId, vfsPath, content, namespace);
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

  if (!context?.projectId) {
    throw new Error('projectId is required');
  }

  const content = (input.content as string) ?? '';
  const name = typeof input.name === 'string' && input.name ? input.name : undefined;
  const fileSlug = context.chatId ?? '_default';
  const vfsPath = name ? `/sketchbook/${fileSlug}-${name}.md` : `/sketchbook/${fileSlug}.md`;

  try {
    await appendToSketchbook(context.projectId, vfsPath, content, context.namespace);
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
