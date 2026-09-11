import { describe, it, expect } from 'vitest';
import { jsTool } from '../jsTool';
import type {
  BooleanToolOption,
  ToolContext,
  ToolOptions,
  ToolResult,
} from '../../../protocol/types';
import { LocalVfsAdapter } from '../../vfs/localVfsAdapter';
import { createVfsService, type VfsService } from '../../vfs/vfsService';
import type { UnifiedStorage } from '../../storage/unifiedStorage';
import type { EncryptionCore } from '../../encryption/encryptionCore';
import { buildStubVfsDeps } from '../../vfs/__tests__/_vfsTestHelpers';
import { stubBackendDeps } from './testStubs';

const PROJECT_ID = 'proj_js_tool';

function createService(): VfsService {
  const { stubStorage, stubEncryption } = buildStubVfsDeps();
  return createVfsService(
    stubStorage as unknown as UnifiedStorage,
    stubEncryption as unknown as EncryptionCore
  );
}

async function runJs(
  code: string,
  toolOptions: ToolOptions,
  service = createService(),
  namespace?: string
): Promise<ToolResult> {
  const vfsAdapter = new LocalVfsAdapter(service, PROJECT_ID, namespace);
  const context: ToolContext = {
    projectId: PROJECT_ID,
    namespace,
    vfsAdapter,
    createVfsAdapter: ns => new LocalVfsAdapter(service, PROJECT_ID, ns),
    signal: new AbortController().signal,
    ...stubBackendDeps,
  };
  const gen = jsTool.execute({ code }, toolOptions, context);
  if (gen instanceof Promise) return gen;
  let step = await gen.next();
  while (!step.done) step = await gen.next();
  return step.value;
}

describe('jsTool memoriesWritable option', () => {
  it('is defined and off by default', () => {
    const opt = jsTool.optionDefinitions?.find(o => o.id === 'memoriesWritable') as
      | BooleanToolOption
      | undefined;
    expect(opt?.type).toBe('boolean');
    expect(opt?.default).toBe(false);
  });

  it('refuses /memories writes without the option', async () => {
    const result = await runJs(
      `try { await fs.writeFile('/memories/a.md', 'x'); return 'written'; } catch (e) { return e.message; }`,
      {}
    );
    expect(result.content).toContain('EROFS');
  });

  it('writes /memories with the option', async () => {
    const result = await runJs(
      `await fs.writeFile('/memories/a.md', 'hello'); return await fs.readFile('/memories/a.md', 'utf-8');`,
      { memoriesWritable: true }
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe('hello');
  });

  it('forwards the namespace so stat reports /share as readonly for minions', async () => {
    const service = createService();
    await new LocalVfsAdapter(service, PROJECT_ID).writeFile('/share/seed.txt', 's');

    const result = await runJs(
      `return String((await fs.stat('/share/seed.txt')).readonly);`,
      {},
      service,
      '/minions/coder'
    );
    expect(result.content).toBe('true');
  });

  it('describes /memories per the option', () => {
    const resolveDescription = jsTool.description as (options: ToolOptions) => string;
    expect(resolveDescription({})).toContain('Note: /memories is read-only.');
    const writable = resolveDescription({ memoriesWritable: true });
    expect(writable).toContain('/memories is writable');
    expect(writable).not.toContain('/memories is read-only');
  });
});
