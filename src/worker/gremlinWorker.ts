/// <reference lib="webworker" />

/**
 * Web Worker entry for the GremlinOFA backend.
 *
 * All handler logic lives in `./workerHandler.ts` so it can be tested
 * without a real `DedicatedWorkerGlobalScope`. This file is a two-line
 * bootstrap that passes `self` to the handler factory.
 *
 * See `workerHandler.ts` for the full bootstrap sequence docs (worker_config
 * → init handshake, adapter factory registration, stream dispatch).
 */

import { createWorkerHandler } from './workerHandler';

declare const self: DedicatedWorkerGlobalScope;

createWorkerHandler(self);
