/**
 * Tool Registration Entry Point
 *
 * Imports all client-side tools and provides a function to register them
 * with the global tool registry. Call registerAllTools() at app startup.
 */

import type { ClientSideToolRegistry } from './clientSideTools';
import { jsTool } from './jsTool';
import { memoryTool } from './memoryTool';
import { fsTool } from './fsTool';
import { returnTool } from './returnTool';
import { minionTool } from './minionTool';
import { sketchbookTool } from './sketchbookTool';
import { checkpointTool } from './checkpointTool';
import { dummyTool } from './dummyTool';
import { metadataTool } from './metadataTool';

/**
 * All available client-side tools.
 * Order determines display order in ProjectSettings UI.
 *
 * Note: 'return' tool is internal (for minion sub-agents) and not shown in UI.
 */
const allTools = [
  memoryTool,
  jsTool,
  fsTool,
  minionTool,
  sketchbookTool,
  checkpointTool,
  metadataTool,
  dummyTool,
  returnTool,
];

/**
 * Register all tools with a registry instance. `GremlinServer.init()` calls
 * this with the per-instance `ClientSideToolRegistry` it built into its
 * dependency bundle.
 */
export function registerAllTools(target: ClientSideToolRegistry): void {
  target.registerAll(allTools);
}

// Re-export tool execution helpers for convenience
export { executeClientSideTool, executeToolSimple } from './clientSideTools';

// Re-export individual tools for direct access if needed
export { jsTool } from './jsTool';
export { memoryTool } from './memoryTool';
export { fsTool } from './fsTool';
export { returnTool } from './returnTool';
export { minionTool } from './minionTool';
export { sketchbookTool } from './sketchbookTool';
export { checkpointTool } from './checkpointTool';
export { metadataTool } from './metadataTool';
export { dummyTool } from './dummyTool';
