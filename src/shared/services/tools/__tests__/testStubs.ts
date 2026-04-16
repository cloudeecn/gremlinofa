/**
 * Shared test stubs for the `ToolContext` backend dependency fields
 * (`storage`, `encryption`, `apiService`, `toolRegistry`, `loopRegistry`).
 *
 * Most fields are empty objects cast to the right types — no method on them
 * is actually invoked by tool tests that don't exercise the collaborator,
 * since each test that exercises one of those collaborators sets up its own
 * `vi.mock` for the relevant module or wires a per-test stub through the
 * context. The constant exists so tests don't have to repeat the field
 * block at every `ToolContext` literal site.
 *
 * `loopRegistry` is a real `LoopRegistry` instance because the class is
 * pure in-memory state (no I/O) and the minion tool actually calls
 * `register` / `end` against it now — an empty cast object would crash on
 * the first method call.
 */

import { LoopRegistry } from '../../../engine/LoopRegistry';
import type { APIService } from '../../api/apiService';
import type { EncryptionCore } from '../../encryption/encryptionCore';
import type { UnifiedStorage } from '../../storage/unifiedStorage';
import type { ClientSideToolRegistry } from '../clientSideTools';

export const stubBackendDeps = {
  storage: {} as unknown as UnifiedStorage,
  encryption: {} as unknown as EncryptionCore,
  apiService: {} as unknown as APIService,
  toolRegistry: {} as unknown as ClientSideToolRegistry,
  loopRegistry: new LoopRegistry(),
};
