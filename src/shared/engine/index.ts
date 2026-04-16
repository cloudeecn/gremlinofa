/**
 * Shared engine entry point.
 *
 * Pure type + class re-exports — no factories, no runtime dependencies on
 * frontend or worker code. After Phase 1.65 there is no eager-mode
 * production factory: the worker is the only place a real `GremlinServer`
 * gets stood up, and it does so by calling `setBootstrapAdapterFactories`
 * + `setBootstrapStorageConfig` and then dispatching `init({cek})`.
 *
 * Tests that want full control construct `GremlinServer` directly with a
 * stub `BackendDeps` and wrap it in an `InProcessTransport`.
 */

export { GremlinServer, ProtocolError } from './GremlinServer';
export { LoopRegistry } from './LoopRegistry';
export { ChatRunner } from './ChatRunner';
export { InProcessTransport, type Transport } from './transports/inProcess';
export type { BackendDeps } from './backendDeps';
export type * from '../protocol/protocol';
