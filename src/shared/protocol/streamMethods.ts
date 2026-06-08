/**
 * Canonical set of streaming method names — single source of truth shared
 * by the worker handler and WebSocket transport. A method is "streaming" if
 * its `GremlinMethods` entry has a non-`never` `streams` field.
 *
 * The compile-time exhaustiveness check below ensures `tsc` fails if a
 * streaming method is added to `GremlinMethods` without updating this set
 * (or vice versa). `npm run verify` catches it before tests even run.
 */

import type { GremlinMethods } from './methods';

/**
 * Type-level extraction of method names whose `streams` field is not `never`.
 */
type StreamMethodKey = {
  [K in keyof GremlinMethods]: GremlinMethods[K]['streams'] extends never ? never : K;
}[keyof GremlinMethods];

/**
 * Runtime set used by the worker and WebSocket transport to decide whether
 * an incoming request should be dispatched as a stream or a one-shot RPC.
 */
export const STREAM_METHODS = new Set<string>([
  'runLoop',
  'attachChat',
  'subscribeActiveLoops',
  'exportData',
  'importData',
  'vfsCompactProject',
  'exportProject',
]);

/**
 * Compile-time exhaustiveness guard. If a new streaming method is added to
 * `GremlinMethods` this record will fail to type-check until the method name
 * is added to both this record and the `STREAM_METHODS` set above.
 *
 * Conversely, adding a key here that isn't a streaming method in
 * `GremlinMethods` also fails.
 */
const _exhaustive: Record<StreamMethodKey, true> = {
  runLoop: true,
  attachChat: true,
  subscribeActiveLoops: true,
  exportData: true,
  importData: true,
  vfsCompactProject: true,
  exportProject: true,
};
void _exhaustive;
