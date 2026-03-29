# Project Bundle Format (`.gremlin.json`)

A `.gremlin.json` file is a portable, self-contained snapshot of a GremlinOFA project. It includes everything needed to recreate a project: settings, system prompt, tool config, and virtual filesystem contents. No encryption keys involved — it's plain JSON you can read, write, or generate with a script.

Vibe-coded, but it works.

## Top-Level Structure

```jsonc
{
  "version": 1,                              // always 1 (for now)
  "exportedAt": "2026-03-19T12:00:00.000Z",  // ISO timestamp, informational only
  "project": { ... },                         // project settings
  "files": [ ... ]                            // virtual filesystem contents
}
```

| Field        | Type   | Required | Description                                              |
| ------------ | ------ | -------- | -------------------------------------------------------- |
| `version`    | number | yes      | Bundle format version. Must be `1`.                      |
| `exportedAt` | string | no       | ISO 8601 timestamp. Just for your reference.             |
| `project`    | object | yes      | Project configuration (see below).                       |
| `files`      | array  | yes      | VFS file and directory entries (see below). Can be `[]`. |

## Project Object

The `project` object contains all project settings. Only `name` is required — everything else has sensible defaults.

When imported, a fresh `id`, `createdAt`, and `lastUsedAt` are generated automatically. You never need to include these.

### Required Fields

| Field  | Type   | Description                                           |
| ------ | ------ | ----------------------------------------------------- |
| `name` | string | Project name. On import, " (Imported)" gets appended. |

### Optional Fields

| Field                          | Type                    | Default | Description                                                                               |
| ------------------------------ | ----------------------- | ------- | ----------------------------------------------------------------------------------------- |
| `icon`                         | string                  | (auto)  | Emoji icon for the project.                                                               |
| `systemPrompt`                 | string                  | `""`    | System prompt prepended to every conversation.                                            |
| `preFillResponse`              | string                  | `""`    | Pre-fill text for assistant responses.                                                    |
| `apiDefinitionId`              | string \| null          | `null`  | API provider config ID. See [cross-instance note](#cross-instance-portability).           |
| `modelId`                      | string \| null          | `null`  | Model ID (e.g. `"claude-sonnet-4-20250514"`).                                             |
| `webSearchEnabled`             | boolean                 | `false` | Enable web search tool.                                                                   |
| `temperature`                  | number \| null          | `null`  | Sampling temperature. `null` = provider default.                                          |
| `maxOutputTokens`              | number                  | `16384` | Maximum output tokens per response.                                                       |
| `enableReasoning`              | boolean                 | `false` | Enable extended thinking (Anthropic).                                                     |
| `reasoningBudgetTokens`        | number                  | `10000` | Token budget for reasoning.                                                               |
| `thinkingKeepTurns`            | number                  | (auto)  | How many turns of thinking to keep. `-1` = all.                                           |
| `reasoningEffort`              | string                  | (auto)  | OpenAI reasoning effort: `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`. |
| `reasoningSummary`             | string                  | (auto)  | OpenAI reasoning summary: `"auto"`, `"concise"`, `"detailed"`.                            |
| `sendMessageMetadata`          | boolean \| `"template"` | (off)   | Send metadata with each message.                                                          |
| `metadataTimestampMode`        | string                  | (off)   | Timestamp format: `"utc"`, `"local"`, `"relative"`, `"disabled"`.                         |
| `metadataIncludeModelName`     | boolean                 | (off)   | Include model name in metadata.                                                           |
| `metadataIncludeContextWindow` | boolean                 | (off)   | Include context window usage in metadata.                                                 |
| `metadataIncludeCost`          | boolean                 | (off)   | Include cost in metadata.                                                                 |
| `metadataTemplate`             | string                  | (none)  | Custom metadata template string.                                                          |
| `metadataNewContext`           | boolean                 | (off)   | Start fresh context for metadata.                                                         |
| `enabledTools`                 | string[]                | (none)  | Enabled tools: `"memory"`, `"javascript"`, `"filesystem"`, `"minion"`, etc.               |
| `toolOptions`                  | object                  | (none)  | Per-tool config. See [tool options](#tool-options).                                       |
| `disableStream`                | boolean                 | `false` | Disable streaming (use non-streaming API).                                                |
| `extendedContext`              | boolean                 | `false` | Enable extended context window (Anthropic 1M beta).                                       |
| `noLineNumbers`                | boolean                 | `false` | Strip line numbers from filesystem/memory tool output.                                    |

### Tool Options

`toolOptions` is a map of tool name → option values. Values can be booleans, numbers, strings, or model references.

A model reference looks like:

```json
{ "apiDefinitionId": "api_default_anthropic_...", "modelId": "claude-sonnet-4-20250514" }
```

Example:

```json
"toolOptions": {
  "memory": { "useSystemPrompt": true },
  "minion": {
    "useProjectModel": false,
    "models": [
      { "apiDefinitionId": "api_default_responses_api_openai_official", "modelId": "gpt-4o" }
    ]
  }
}
```

### Cross-Instance Portability

`apiDefinitionId` and `modelId` (both top-level and inside `toolOptions`) reference API provider configs by ID. If the target app instance doesn't have a matching config, those references just won't resolve — the project will prompt you to pick a model in settings. No data loss, just needs a quick reconfigure.

## Files Array

The `files` array is a flat list of virtual filesystem entries. Directories that contain files are created implicitly from file paths — you only need explicit directory entries for empty directories.

### File Entry

```json
{
  "path": "/src/main.ts",
  "content": "console.log('hello world');",
  "isBinary": false,
  "mime": "text/plain"
}
```

| Field      | Type    | Required        | Description                                                         |
| ---------- | ------- | --------------- | ------------------------------------------------------------------- |
| `path`     | string  | yes             | Absolute path within VFS (starts with `/`).                         |
| `content`  | string  | yes (for files) | File content. Plain text for text files, base64-encoded for binary. |
| `isBinary` | boolean | no              | `true` for binary files. Defaults to `false`.                       |
| `mime`     | string  | no              | MIME type (e.g. `"text/plain"`, `"image/png"`).                     |

### Directory Entry

```json
{
  "path": "/data/scratch",
  "type": "directory"
}
```

| Field  | Type          | Required | Description                            |
| ------ | ------------- | -------- | -------------------------------------- |
| `path` | string        | yes      | Absolute path within VFS.              |
| `type` | `"directory"` | yes      | Marks this as a directory, not a file. |

No `content` field needed for directories.

### Path Rules

- Paths must start with `/`
- Forward slashes only (no backslash)
- No `.` or `..` segments (they get normalized away)
- Parent directories are created automatically from file paths

## Examples

### Minimal Bundle

The bare minimum — just a named project with no files:

```json
{
  "version": 1,
  "project": { "name": "Empty Project" },
  "files": []
}
```

### Full Bundle

A project with system prompt, model config, and a few files:

```json
{
  "version": 1,
  "exportedAt": "2026-03-19T15:30:00.000Z",
  "project": {
    "name": "Code Review Helper",
    "icon": "🔍",
    "systemPrompt": "You are a code reviewer. Be thorough but constructive.",
    "preFillResponse": "",
    "modelId": "claude-sonnet-4-20250514",
    "apiDefinitionId": null,
    "webSearchEnabled": false,
    "temperature": 0.3,
    "maxOutputTokens": 8192,
    "enableReasoning": true,
    "reasoningBudgetTokens": 4000,
    "enabledTools": ["memory", "filesystem"],
    "toolOptions": {
      "memory": { "useSystemPrompt": true }
    }
  },
  "files": [
    {
      "path": "/prompts/review-checklist.md",
      "content": "# Review Checklist\n\n- [ ] Error handling\n- [ ] Edge cases\n- [ ] Performance\n"
    },
    {
      "path": "/templates/feedback.md",
      "content": "## Feedback\n\n### What works well\n\n### Suggestions\n"
    },
    {
      "path": "/scratch",
      "type": "directory"
    }
  ]
}
```
