/**
 * Unit tests for Project Export/Import utilities
 */

import { describe, it, expect, vi } from 'vitest';
import type { ClientSideTool, Project, ToolOptionDefinition, VfsNode } from '../../protocol/types';
import {
  collectLiveEntries,
  stripProjectForExport,
  validateBundle,
  buildTreeFromEntries,
  runProjectExport,
  runProjectImport,
} from '../projectBundle';
import type { BundleFileEntry } from '../../protocol/types/projectBundle';
import type { BackendDeps } from '../backendDeps';
import { ClientSideToolRegistry } from '../../services/tools/clientSideTools';
import { minionTool } from '../../services/tools/minionTool';

describe('projectExport', () => {
  describe('collectLiveEntries', () => {
    it('should collect live file nodes', () => {
      const children: Record<string, VfsNode> = {
        'readme.md': {
          type: 'file',
          fileId: 'vf_aaa',
          deleted: false,
          createdAt: 1000,
          updatedAt: 1000,
        },
        'main.ts': {
          type: 'file',
          fileId: 'vf_bbb',
          deleted: false,
          createdAt: 1000,
          updatedAt: 1000,
        },
      };

      const { fileInfos, dirEntries } = collectLiveEntries(children, '/');
      expect(fileInfos).toHaveLength(2);
      expect(fileInfos[0]).toEqual({
        path: '/readme.md',
        fileId: 'vf_aaa',
        isBinary: undefined,
        mime: undefined,
      });
      expect(dirEntries).toHaveLength(0);
    });

    it('should skip deleted file nodes', () => {
      const children: Record<string, VfsNode> = {
        'live.txt': {
          type: 'file',
          fileId: 'vf_live',
          deleted: false,
          createdAt: 1000,
          updatedAt: 1000,
        },
        'deleted.txt': {
          type: 'file',
          fileId: 'vf_dead',
          deleted: true,
          createdAt: 1000,
          updatedAt: 1000,
        },
      };

      const { fileInfos } = collectLiveEntries(children, '/');
      expect(fileInfos).toHaveLength(1);
      expect(fileInfos[0].fileId).toBe('vf_live');
    });

    it('should recurse into live directories', () => {
      const children: Record<string, VfsNode> = {
        src: {
          type: 'dir',
          deleted: false,
          createdAt: 1000,
          updatedAt: 1000,
          children: {
            'app.ts': {
              type: 'file',
              fileId: 'vf_app',
              deleted: false,
              createdAt: 1000,
              updatedAt: 1000,
            },
          },
        },
      };

      const { fileInfos } = collectLiveEntries(children, '/');
      expect(fileInfos).toHaveLength(1);
      expect(fileInfos[0].path).toBe('/src/app.ts');
    });

    it('should emit empty directory entries when dir has no live children', () => {
      const children: Record<string, VfsNode> = {
        empty: {
          type: 'dir',
          deleted: false,
          createdAt: 1000,
          updatedAt: 1000,
          children: {},
        },
      };

      const { fileInfos, dirEntries } = collectLiveEntries(children, '/');
      expect(fileInfos).toHaveLength(0);
      expect(dirEntries).toHaveLength(1);
      expect(dirEntries[0]).toEqual({ path: '/empty', type: 'directory' });
    });

    it('should emit empty directory when all children are deleted', () => {
      const children: Record<string, VfsNode> = {
        pruned: {
          type: 'dir',
          deleted: false,
          createdAt: 1000,
          updatedAt: 1000,
          children: {
            'gone.txt': {
              type: 'file',
              fileId: 'vf_gone',
              deleted: true,
              createdAt: 1000,
              updatedAt: 1000,
            },
          },
        },
      };

      const { fileInfos, dirEntries } = collectLiveEntries(children, '/');
      expect(fileInfos).toHaveLength(0);
      expect(dirEntries).toHaveLength(1);
      expect(dirEntries[0].path).toBe('/pruned');
    });

    it('should skip deleted directories entirely', () => {
      const children: Record<string, VfsNode> = {
        deleted_dir: {
          type: 'dir',
          deleted: true,
          createdAt: 1000,
          updatedAt: 1000,
          children: {
            'file.txt': {
              type: 'file',
              fileId: 'vf_inside',
              deleted: false,
              createdAt: 1000,
              updatedAt: 1000,
            },
          },
        },
      };

      const { fileInfos, dirEntries } = collectLiveEntries(children, '/');
      expect(fileInfos).toHaveLength(0);
      expect(dirEntries).toHaveLength(0);
    });

    it('should preserve isBinary and mime on file entries', () => {
      const children: Record<string, VfsNode> = {
        'logo.png': {
          type: 'file',
          fileId: 'vf_png',
          deleted: false,
          createdAt: 1000,
          updatedAt: 1000,
          isBinary: true,
          mime: 'image/png',
        },
      };

      const { fileInfos } = collectLiveEntries(children, '/');
      expect(fileInfos[0].isBinary).toBe(true);
      expect(fileInfos[0].mime).toBe('image/png');
    });

    it('should build correct paths with nested parentPath', () => {
      const children: Record<string, VfsNode> = {
        'nested.txt': {
          type: 'file',
          fileId: 'vf_nested',
          deleted: false,
          createdAt: 1000,
          updatedAt: 1000,
        },
      };

      const { fileInfos } = collectLiveEntries(children, '/src/deep');
      expect(fileInfos[0].path).toBe('/src/deep/nested.txt');
    });
  });

  describe('stripProjectForExport', () => {
    it('should remove id, createdAt, and lastUsedAt', () => {
      const project = {
        id: 'proj_abc',
        name: 'Test Project',
        icon: '🤖',
        createdAt: new Date('2026-01-01'),
        lastUsedAt: new Date('2026-03-19'),
        systemPrompt: 'You are helpful.',
        preFillResponse: '',
        apiDefinitionId: null,
        modelId: null,
        webSearchEnabled: false,
        temperature: null,
        maxOutputTokens: 16384,
        enableReasoning: false,
        reasoningBudgetTokens: 10000,
      };

      const stripped = stripProjectForExport(project as any, new ClientSideToolRegistry());
      expect(stripped).not.toHaveProperty('id');
      expect(stripped).not.toHaveProperty('createdAt');
      expect(stripped).not.toHaveProperty('lastUsedAt');
      expect(stripped).toHaveProperty('name', 'Test Project');
      expect(stripped).toHaveProperty('systemPrompt', 'You are helpful.');
    });

    it('drops secret tool options and the remote VFS password, keeps everything else', () => {
      const project = makeProjectWithSecrets();

      const stripped = stripProjectForExport(project, makeRegistryWithSecrets());

      expect(stripped).not.toHaveProperty('remoteVfsPassword');
      expect(stripped).toHaveProperty('remoteVfsUrl', 'https://vfs.example.test');
      expect(stripped.toolOptions).toEqual({
        relay: { endpoint: 'https://relay.example.test', retries: 3 },
        memory: { useSystemPrompt: true },
        // Not in the registry: no definition marks anything secret
        retiredTool: { token: 'kept-as-is' },
      });
      // The live project is untouched
      expect(project.toolOptions?.relay.password).toBe('hunter2');
      expect(project.remoteVfsPassword).toBe('vfs-secret');
    });

    it('strips the shipped minion remotePassword through the real tool definition', () => {
      const registry = new ClientSideToolRegistry();
      registry.registerAll([minionTool]);
      const project = {
        ...makeProjectWithSecrets(),
        toolOptions: {
          minion: { remoteEndpoint: 'https://grass.example.test', remotePassword: 'hunter2' },
        },
      };

      const stripped = stripProjectForExport(project, registry);

      expect(stripped.toolOptions).toEqual({
        minion: { remoteEndpoint: 'https://grass.example.test' },
      });
    });

    it.each([[null], ['str'], [['x']]])(
      'keeps a malformed %j entry of a tool with secrets verbatim',
      malformed => {
        // Import doesn't validate toolOptions, so a hand-written bundle can carry these
        const project = {
          ...makeProjectWithSecrets(),
          toolOptions: { relay: malformed },
        } as unknown as Project;

        const stripped = stripProjectForExport(project, makeRegistryWithSecrets());

        expect(stripped.toolOptions).toEqual({ relay: malformed });
      }
    );

    it('leaves toolOptions absent when the project has none', () => {
      const { toolOptions: _omit, ...project } = makeProjectWithSecrets();

      const stripped = stripProjectForExport(project, makeRegistryWithSecrets());

      expect(stripped).not.toHaveProperty('toolOptions');
    });
  });

  describe('runProjectExport → runProjectImport', () => {
    function makeDeps(project: Project) {
      const savedProjects: Project[] = [];
      const deps = {
        storage: {
          getProject: vi.fn(async () => project),
          saveProject: vi.fn(async (saved: Project) => {
            savedProjects.push(saved);
          }),
          getAdapter: () => ({ get: vi.fn(async () => null), save: vi.fn() }),
        },
        encryption: {},
        toolRegistry: makeRegistryWithSecrets(),
      } as unknown as BackendDeps;
      return { deps, savedProjects };
    }

    it('round-trips a project without its secrets', async () => {
      const { deps, savedProjects } = makeDeps(makeProjectWithSecrets());

      let bundleJson = '';
      for await (const event of runProjectExport(deps, 'proj_src')) {
        if (event.type === 'done') bundleJson = event.bundleJson;
      }
      expect(bundleJson).not.toContain('hunter2');
      expect(bundleJson).not.toContain('vfs-secret');
      expect(() => validateBundle(JSON.parse(bundleJson))).not.toThrow();

      await runProjectImport(deps, bundleJson);

      expect(savedProjects).toHaveLength(1);
      const imported = savedProjects[0];
      expect(imported.remoteVfsUrl).toBe('https://vfs.example.test');
      expect(imported.remoteVfsPassword).toBeUndefined();
      expect(imported.toolOptions?.relay).toEqual({
        endpoint: 'https://relay.example.test',
        retries: 3,
      });
    });

    it('still imports secrets from an older bundle that carries them', async () => {
      const { deps, savedProjects } = makeDeps(makeProjectWithSecrets());
      const legacyBundle = {
        version: 1,
        project: {
          name: 'Legacy',
          remoteVfsPassword: 'vfs-secret',
          toolOptions: { relay: { password: 'hunter2' } },
        },
        files: [],
      };

      await runProjectImport(deps, JSON.stringify(legacyBundle));

      expect(savedProjects[0].remoteVfsPassword).toBe('vfs-secret');
      expect(savedProjects[0].toolOptions?.relay.password).toBe('hunter2');
    });
  });
});

/** A tool with one secret text option, plus a non-secret tool to show it's left alone. */
function makeRegistryWithSecrets(): ClientSideToolRegistry {
  const registry = new ClientSideToolRegistry();
  const stubTool = (name: string, optionDefinitions: ToolOptionDefinition[]): ClientSideTool => ({
    name,
    description: name,
    inputSchema: { type: 'object', properties: {}, required: [] },
    optionDefinitions,
    execute: async () => ({ content: '' }),
  });
  registry.registerAll([
    stubTool('relay', [
      { type: 'text', id: 'endpoint', label: 'Endpoint', default: '' },
      { type: 'text', id: 'password', label: 'Password', default: '', secret: true },
      { type: 'number', id: 'retries', label: 'Retries', default: 1 },
    ]),
    stubTool('memory', [{ type: 'boolean', id: 'useSystemPrompt', label: 'SP', default: false }]),
  ]);
  return registry;
}

function makeProjectWithSecrets(): Project {
  return {
    id: 'proj_src',
    name: 'Secretive',
    createdAt: new Date('2026-01-01'),
    lastUsedAt: new Date('2026-03-19'),
    systemPrompt: '',
    preFillResponse: '',
    apiDefinitionId: null,
    modelId: null,
    webSearchEnabled: false,
    temperature: null,
    maxOutputTokens: 16384,
    enableReasoning: false,
    reasoningBudgetTokens: 10000,
    remoteVfsUrl: 'https://vfs.example.test',
    remoteVfsPassword: 'vfs-secret',
    enabledTools: ['relay', 'memory'],
    toolOptions: {
      relay: { endpoint: 'https://relay.example.test', password: 'hunter2', retries: 3 },
      memory: { useSystemPrompt: true },
      retiredTool: { token: 'kept-as-is' },
    },
  };
}

describe('projectImport', () => {
  describe('validateBundle', () => {
    it('should accept a valid bundle', () => {
      const bundle = {
        version: 1,
        exportedAt: '2026-03-19T00:00:00Z',
        project: { name: 'Test' },
        files: [],
      };
      expect(() => validateBundle(bundle)).not.toThrow();
    });

    it('should reject non-object input', () => {
      expect(() => validateBundle('string')).toThrow('expected a JSON object');
      expect(() => validateBundle(null)).toThrow('expected a JSON object');
    });

    it('should reject wrong version', () => {
      expect(() => validateBundle({ version: 2, project: { name: 'X' }, files: [] })).toThrow(
        'Unsupported bundle version: 2'
      );
    });

    it('should reject missing version', () => {
      expect(() => validateBundle({ project: { name: 'X' }, files: [] })).toThrow(
        'Unsupported bundle version: missing'
      );
    });

    it('should reject missing project', () => {
      expect(() => validateBundle({ version: 1, files: [] })).toThrow('missing "project" object');
    });

    it('should reject empty project name', () => {
      expect(() => validateBundle({ version: 1, project: { name: '' }, files: [] })).toThrow(
        'non-empty string'
      );
    });

    it('should reject non-array files', () => {
      expect(() =>
        validateBundle({ version: 1, project: { name: 'X' }, files: 'not-array' })
      ).toThrow('"files" must be an array');
    });
  });

  describe('buildTreeFromEntries', () => {
    it('should create file nodes with parent directories', () => {
      const entries: BundleFileEntry[] = [
        { path: '/src/app.ts', content: 'code' },
        { path: '/src/utils/helper.ts', content: 'helper' },
      ];

      const { tree, fileEntries } = buildTreeFromEntries(entries);

      // Should have src dir
      expect(tree.children['src']).toBeDefined();
      expect(tree.children['src'].type).toBe('dir');

      // src/app.ts should be a file
      expect(tree.children['src'].children!['app.ts']).toBeDefined();
      expect(tree.children['src'].children!['app.ts'].type).toBe('file');
      expect(tree.children['src'].children!['app.ts'].fileId).toBeTruthy();

      // src/utils/helper.ts should exist
      const utils = tree.children['src'].children!['utils'];
      expect(utils).toBeDefined();
      expect(utils.type).toBe('dir');
      expect(utils.children!['helper.ts'].type).toBe('file');

      expect(fileEntries).toHaveLength(2);
    });

    it('should create empty directory entries', () => {
      const entries: BundleFileEntry[] = [{ path: '/data/scratch', type: 'directory' }];

      const { tree, fileEntries } = buildTreeFromEntries(entries);

      expect(tree.children['data']).toBeDefined();
      expect(tree.children['data'].type).toBe('dir');
      expect(tree.children['data'].children!['scratch']).toBeDefined();
      expect(tree.children['data'].children!['scratch'].type).toBe('dir');

      // No file entries for directories
      expect(fileEntries).toHaveLength(0);
    });

    it('should handle mixed files and directories', () => {
      const entries: BundleFileEntry[] = [
        { path: '/readme.md', content: '# Hello' },
        { path: '/logs', type: 'directory' },
        { path: '/src/index.ts', content: 'main' },
      ];

      const { tree, fileEntries } = buildTreeFromEntries(entries);

      expect(tree.children['readme.md'].type).toBe('file');
      expect(tree.children['logs'].type).toBe('dir');
      expect(tree.children['src'].children!['index.ts'].type).toBe('file');
      expect(fileEntries).toHaveLength(2);
    });

    it('should set isBinary and mime on file nodes', () => {
      const entries: BundleFileEntry[] = [
        { path: '/image.png', content: 'base64data', isBinary: true, mime: 'image/png' },
      ];

      const { tree } = buildTreeFromEntries(entries);
      const node = tree.children['image.png'];
      expect(node.isBinary).toBe(true);
      expect(node.mime).toBe('image/png');
    });

    it('should produce unique fileIds per file', () => {
      const entries: BundleFileEntry[] = [
        { path: '/a.txt', content: 'a' },
        { path: '/b.txt', content: 'b' },
        { path: '/c.txt', content: 'c' },
      ];

      const { fileEntries } = buildTreeFromEntries(entries);
      const ids = fileEntries.map(e => e.fileId);
      expect(new Set(ids).size).toBe(3);
    });

    it('should handle root-level file', () => {
      const entries: BundleFileEntry[] = [{ path: '/config.json', content: '{}' }];

      const { tree } = buildTreeFromEntries(entries);
      expect(tree.children['config.json']).toBeDefined();
      expect(tree.children['config.json'].type).toBe('file');
    });

    it('should return empty tree for empty entries', () => {
      const { tree, fileEntries } = buildTreeFromEntries([]);
      expect(Object.keys(tree.children)).toHaveLength(0);
      expect(fileEntries).toHaveLength(0);
    });
  });
});
