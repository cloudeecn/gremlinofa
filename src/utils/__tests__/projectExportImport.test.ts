/**
 * Unit tests for Project Export/Import utilities
 */

import { describe, it, expect } from 'vitest';
import type { VfsNode } from '../../types';
import { _collectLiveEntries, _stripProjectForExport } from '../projectExport';
import { validateBundle, buildTreeFromEntries } from '../projectImport';
import type { BundleFileEntry } from '../projectExport';

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

      const { fileInfos, dirEntries } = _collectLiveEntries(children, '/');
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

      const { fileInfos } = _collectLiveEntries(children, '/');
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

      const { fileInfos } = _collectLiveEntries(children, '/');
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

      const { fileInfos, dirEntries } = _collectLiveEntries(children, '/');
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

      const { fileInfos, dirEntries } = _collectLiveEntries(children, '/');
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

      const { fileInfos, dirEntries } = _collectLiveEntries(children, '/');
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

      const { fileInfos } = _collectLiveEntries(children, '/');
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

      const { fileInfos } = _collectLiveEntries(children, '/src/deep');
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

      const stripped = _stripProjectForExport(project as any);
      expect(stripped).not.toHaveProperty('id');
      expect(stripped).not.toHaveProperty('createdAt');
      expect(stripped).not.toHaveProperty('lastUsedAt');
      expect(stripped).toHaveProperty('name', 'Test Project');
      expect(stripped).toHaveProperty('systemPrompt', 'You are helpful.');
    });
  });
});

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
