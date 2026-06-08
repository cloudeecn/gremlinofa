import { describe, it, expect, vi } from 'vitest';
import { detectRemoteVfsTasks, detectTableToFilesystemTasks } from '../vfsMigrationDetector';
import type { Project } from '../../protocol/types';
import type { StorageAdapter } from '../../services/storage/StorageAdapter';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj_1',
    name: 'Test Project',
    systemPrompt: '',
    createdAt: new Date(),
    lastUsedAt: new Date(),
    ...overrides,
  } as Project;
}

describe('detectRemoteVfsTasks', () => {
  it('returns tasks for projects with remoteVfsUrl', () => {
    const projects = [
      makeProject({ id: 'p1', name: 'Local', remoteVfsUrl: undefined }),
      makeProject({
        id: 'p2',
        name: 'Remote',
        remoteVfsUrl: 'https://vfs.example.com',
        remoteVfsPassword: 'pass',
      }),
      makeProject({ id: 'p3', name: 'Also Local' }),
    ];

    const tasks = detectRemoteVfsTasks(projects);

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toEqual({
      type: 'remote_vfs',
      projectId: 'p2',
      projectName: 'Remote',
      remoteVfsUrl: 'https://vfs.example.com',
      remoteVfsPassword: 'pass',
    });
  });

  it('returns empty array when no projects use remote VFS', () => {
    const projects = [
      makeProject({ id: 'p1', name: 'Local' }),
      makeProject({ id: 'p2', name: 'Also Local' }),
    ];

    const tasks = detectRemoteVfsTasks(projects);
    expect(tasks).toHaveLength(0);
  });
});

describe('detectTableToFilesystemTasks', () => {
  it('returns tasks for projects that have VFS_META records', async () => {
    const projects = [
      makeProject({ id: 'p1', name: 'Has VFS Data' }),
      makeProject({ id: 'p2', name: 'No VFS Data' }),
    ];

    const adapter = {
      get: vi.fn().mockImplementation((_table: string, id: string) => {
        if (id === 'vfs_meta_p1') return { encryptedData: 'data' };
        return null;
      }),
    } as unknown as StorageAdapter;

    const tasks = await detectTableToFilesystemTasks(projects, adapter);

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toEqual({
      type: 'table_to_filesystem',
      projectId: 'p1',
      projectName: 'Has VFS Data',
    });
  });

  it('returns empty when no VFS_META records exist', async () => {
    const projects = [makeProject({ id: 'p1', name: 'Empty' })];

    const adapter = {
      get: vi.fn().mockResolvedValue(null),
    } as unknown as StorageAdapter;

    const tasks = await detectTableToFilesystemTasks(projects, adapter);
    expect(tasks).toHaveLength(0);
  });
});
