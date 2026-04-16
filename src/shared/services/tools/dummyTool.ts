/**
 * DUMMY System Tool
 *
 * Dynamic Un-inferencing Mock-Message Yielding System.
 * Lets the LLM register JS hooks that intercept the agentic loop
 * before model API calls.
 */

import type { ClientSideTool, ToolResult, ToolStreamEvent } from '../../protocol/types';

const HOOKS_DIR = '/hooks';

const EXAMPLE_HOOK = `/**
 * DUMMY System Hook Template
 *
 * This file is evaluated in a QuickJS sandbox with filesystem access.
 * Return a function that receives the hook input and iteration count.
 * Both sync and async functions are supported. Top-level await is allowed
 * for initialization (e.g., reading config from VFS before returning the hook).
 *
 * @param {Object} input - Hook input (model-agnostic)
 * @param {string} [input.chatId] - Chat identifier (for VFS-based state)
 * @param {string} [input.messageId] - ID of the message being processed
 * @param {string} [input.text] - Last message text content (if present)
 * @param {Array}  [input.toolResults] - Last message tool results (if present)
 * @param {string} input.toolResults[].tool_use_id - ID of the tool call
 * @param {string} input.toolResults[].name - Tool name
 * @param {string} input.toolResults[].content - Tool output
 * @param {boolean} [input.toolResults[].is_error] - Whether tool errored
 * @param {Array}  [input.history] - Sliding window of previous messages (set Hook Context Depth > 0)
 * @param {string} input.history[].id - Message ID
 * @param {string} input.history[].role - "user" | "assistant" | "system"
 * @param {string} [input.history[].text] - Message text
 * @param {Array}  [input.history[].toolCalls] - Tool calls: [{ name, input }]
 * @param {Array}  [input.history[].toolResults] - Tool results: [{ tool_use_id, name, content, is_error? }]
 * @param {number} iteration - Current agentic loop iteration (1-based)
 *
 * @returns {undefined|"user"|Object}
 *   undefined  -> pass through to model API (no interception)
 *   "user"     -> stop the agentic loop, hand control to user
 *   {          -> synthetic assistant response
 *     text: string,
 *     toolCalls?: [{ name: string, input: object, id?: string }],
 *     brief?: string   // display label (rendering only, default: "intercepted")
 *   }
 */
return function(input, iteration) {
  // Example: auto-respond after a specific tool completes
  // if (input.toolResults?.some(r => r.name === 'memory')) {
  //   return { text: 'Memory updated.', brief: 'auto-memory' };
  // }

  // Example: pause for user after 3 iterations
  // if (iteration > 3) return 'user';

  // Example: use chatId for per-chat state tracking
  // var key = 'hook_state_' + input.chatId;

  // Example: async hook with top-level await for initialization
  // var config = await fs.readFile('/config.json');
  // return async function(input, iteration) {
  //   var result = await someAsyncOperation();
  //   return { text: result, brief: 'async-hook' };
  // };

  // Default: pass through to model
  return undefined;
};
`;

const HOOK_CHAIN_EXAMPLE = `/**
 * DUMMY System -- Hook Chain Example
 *
 * Compose multiple hooks in a single file. Each handler is checked in order;
 * the first non-undefined return wins.
 */
var handlers = [
  // Handler 1: auto-respond after memory writes
  function(input, iter) {
    if (input.toolResults && input.toolResults.some(function(r) { return r.name === 'memory' && !r.is_error; })) {
      return { text: 'Memory updated.', brief: 'auto-memory' };
    }
  },

  // Handler 2: pause for user after N iterations
  function(input, iter) {
    if (iter > 5) return 'user';
  },
];

return function(input, iteration) {
  for (var i = 0; i < handlers.length; i++) {
    var result = handlers[i](input, iteration);
    if (result !== undefined) return result;
  }
};
`;

export const dummyTool: ClientSideTool = {
  name: 'dummy',
  displayName: 'DUMMY System',
  displaySubtitle: 'Register JS hooks to intercept the agentic loop',
  internal: false,

  description:
    'Dynamic Un-inferencing Mock-Message Yielding System. ' +
    'Hooks javascript user message handler to ease the burden of main model.\n\n' +
    'Actions:\n' +
    '- register: Activate a hook file already written to /hooks/<name>.js via filesystem\n' +
    '- unregister: Deactivate the current hook (file stays in VFS)\n' +
    '- template: Generate example hook files with documentation to /hooks/example.js and /hooks/hook-chain.example.js',

  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Action to perform: "register", "unregister", or "template"',
        enum: ['register', 'unregister', 'template'],
      },
      name: {
        type: 'string',
        description:
          'Hook name (for register action). Must match an existing file at /hooks/<name>.js written via the filesystem tool.',
      },
    },
    required: ['action'],
  },

  optionDefinitions: [
    {
      type: 'number',
      id: 'hookContextDepth',
      label: 'Hook Context Depth',
      subtitle: 'Number of previous messages passed to hooks (0 = none)',
      default: 0,
      min: 0,
      max: 50,
    },
  ],

  iconInput: '✨',
  iconOutput: '✅',

  // eslint-disable-next-line require-yield -- Simple tool: no streaming events
  execute: async function* (
    input,
    _toolOptions,
    context
  ): AsyncGenerator<ToolStreamEvent, ToolResult, void> {
    const action = input.action as string;

    if (!context?.vfsAdapter) {
      return { content: 'No VFS adapter available.', isError: true };
    }

    const adapter = context.vfsAdapter;

    switch (action) {
      case 'register': {
        const name = input.name as string | undefined;

        if (!name) {
          return {
            content: '"name" is required for register action.',
            isError: true,
          };
        }

        // Verify hook file exists (written by LLM via filesystem tool)
        const hookPath = `${HOOKS_DIR}/${name}.js`;
        try {
          const content = await adapter.readFile(hookPath);
          if (!content) {
            return {
              content: `Hook file not found: ${hookPath}\nWrite the hook file using the filesystem tool first, then register it.`,
              isError: true,
            };
          }
        } catch {
          return {
            content: `Hook file not found: ${hookPath}\nWrite the hook file using the filesystem tool first, then register it.`,
            isError: true,
          };
        }

        return {
          content: `Hook "${name}" activated. File: ${hookPath}\nThe hook will intercept the next agentic loop iteration.`,
          activeHook: name,
        };
      }

      case 'unregister': {
        return {
          content: 'Hook deactivated. Hook files remain in /hooks/ for reuse.',
          activeHook: null,
        };
      }

      case 'template': {
        await adapter.ensureDirAndWrite(HOOKS_DIR, [
          { name: 'example.js', content: EXAMPLE_HOOK },
          { name: 'hook-chain.example.js', content: HOOK_CHAIN_EXAMPLE },
        ]);

        return {
          content:
            'Template files generated:\n' +
            '- /hooks/example.js — Single hook with docs\n' +
            '- /hooks/hook-chain.example.js — Multi-hook chain pattern\n\n' +
            EXAMPLE_HOOK,
        };
      }

      default:
        return {
          content: `Unknown action "${action}". Use "register", "unregister", or "template".`,
          isError: true,
        };
    }
  },

  renderInput: input => {
    const action = input.action as string;
    if (action === 'register' && input.name) return `activate: ${input.name}`;
    return action;
  },

  renderOutput: output => output,
};
