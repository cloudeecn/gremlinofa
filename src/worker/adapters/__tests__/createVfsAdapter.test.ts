import { describe, it, expect, vi } from 'vitest';

import { createVfsAdapter } from '../createVfsAdapter';
import { LocalVfsAdapter } from '../../../shared/services/vfs/localVfsAdapter';
import { RemoteVfsAdapter } from '../../../shared/services/vfs/RemoteVfsAdapter';
import type { BackendDeps } from '../../../shared/engine/backendDeps';
import type { EncryptionCore } from '../../../shared/services/encryption/encryptionCore';
import type { UnifiedStorage } from '../../../shared/services/storage/unifiedStorage';
import type { Project } from '../../../shared/protocol/types';

const stubEncryption = {} as unknown as EncryptionCore;

const stubStorage = {
  getVfsFileIds: vi.fn(async () => []),
  getVfsFile: vi.fn(async () => null),
  saveVfsFile: vi.fn(async () => {}),
  deleteVfsFile: vi.fn(async () => {}),
} as unknown as UnifiedStorage;

const stubDeps = {
  storage: stubStorage,
  encryption: stubEncryption,
} as unknown as BackendDeps;

const baseProject: Project = {
  id: 'proj_1',
  name: 'Test',
  icon: '📁',
  createdAt: new Date(),
  lastUsedAt: new Date(),
  apiDefinitionId: null,
  modelId: null,
  systemPrompt: '',
  preFillResponse: '',
  webSearchEnabled: false,
  temperature: 1,
  maxOutputTokens: 1024,
  enableReasoning: false,
  reasoningBudgetTokens: 0,
};

describe('createVfsAdapter (worker)', () => {
  it('returns a LocalVfsAdapter when project has no remoteVfsUrl', () => {
    const adapter = createVfsAdapter(stubDeps, baseProject, 'user_1');
    expect(adapter).toBeInstanceOf(LocalVfsAdapter);
  });

  it('returns a RemoteVfsAdapter when project has a remoteVfsUrl', () => {
    const project = { ...baseProject, remoteVfsUrl: 'https://vfs.example.com' };
    const adapter = createVfsAdapter(stubDeps, project, 'user_1');
    expect(adapter).toBeInstanceOf(RemoteVfsAdapter);
  });

  it('passes namespace through to LocalVfsAdapter', () => {
    const adapter = createVfsAdapter(stubDeps, baseProject, 'user_1', 'ns_1');
    expect(adapter).toBeInstanceOf(LocalVfsAdapter);
  });

  it('passes namespace through to RemoteVfsAdapter', () => {
    const project = { ...baseProject, remoteVfsUrl: 'https://vfs.example.com' };
    const adapter = createVfsAdapter(stubDeps, project, 'user_1', 'ns_1');
    expect(adapter).toBeInstanceOf(RemoteVfsAdapter);
  });

  it('mints independent instances on each call', () => {
    const a = createVfsAdapter(stubDeps, baseProject, 'user_1');
    const b = createVfsAdapter(stubDeps, baseProject, 'user_1');
    expect(a).not.toBe(b);
  });
});
