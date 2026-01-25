/**
 * Tool Registration Entry Point
 *
 * Imports all client-side tools and provides a function to register them
 * with the global tool registry. Call registerAllTools() at app startup.
 */

import { toolRegistry } from './clientSideTools';
import { jsTool } from './jsTool';
import { memoryTool } from './memoryTool';
import { fsTool } from './fsTool';

/**
 * All available client-side tools.
 * Order determines display order in ProjectSettings UI.
 */
const allTools = [memoryTool, jsTool, fsTool];

/**
 * Register all tools with the global registry.
 * Call this once at app startup (in main.tsx or App.tsx).
 */
export function registerAllTools(): void {
  toolRegistry.registerAll(allTools);
}

// Re-export registry and tool execution for convenience
export { toolRegistry, executeClientSideTool } from './clientSideTools';

// Re-export individual tools for direct access if needed
export { jsTool } from './jsTool';
export { memoryTool } from './memoryTool';
export { fsTool } from './fsTool';
