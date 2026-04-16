/**
 * Shared test stubs for `APIServiceDeps`.
 *
 * The five API client classes (`OpenAIClient`, `ResponsesClient`,
 * `AnthropicClient`, `GoogleClient`, `BedrockClient`) take a deps bundle
 * via constructor since Phase 3 of the singleton-encapsulation refactor.
 * Most client tests only exercise pure helpers (`extractToolUseBlocks`,
 * `applyReasoning`, model discovery against a mocked SDK), so they don't
 * actually call into `storage` or `toolRegistry`. The stub here lets each
 * test instantiate `new XClient(stubApiDeps)` without repeating the
 * four-field cast block.
 *
 * The `toolRegistry` field is a real `ClientSideToolRegistry` instance
 * (no tools registered) so the `getClientSideTools()` codepath in
 * `sendMessageStream` — which is invoked even for tests that pass
 * `enabledTools: []` — returns an empty array instead of throwing.
 * Tests that need a populated registry construct their own stub.
 */

import type { APIServiceDeps } from '../apiService';
import type { EncryptionCore } from '../../encryption/encryptionCore';
import type { UnifiedStorage } from '../../storage/unifiedStorage';
import { ClientSideToolRegistry } from '../../tools/clientSideTools';

export const stubApiDeps: APIServiceDeps = {
  storage: {} as unknown as UnifiedStorage,
  encryption: {} as unknown as EncryptionCore,
  toolRegistry: new ClientSideToolRegistry(),
};
