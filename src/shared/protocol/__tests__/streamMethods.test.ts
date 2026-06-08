import { describe, it, expect } from 'vitest';
import { STREAM_METHODS } from '../streamMethods';

describe('STREAM_METHODS', () => {
  it('contains the expected streaming method names', () => {
    // Snapshot anchor — a diff here during code review signals that a
    // streaming method was added or removed and both transports need
    // updating. The compile-time `_exhaustive` record in streamMethods.ts
    // catches additions to GremlinMethods; this snapshot catches removals
    // from the runtime set.
    expect([...STREAM_METHODS].sort()).toMatchInlineSnapshot(`
      [
        "attachChat",
        "exportData",
        "exportProject",
        "importData",
        "runLoop",
        "subscribeActiveLoops",
        "vfsCompactProject",
      ]
    `);
  });

  it('does not include one-shot methods', () => {
    const oneshotSamples = ['init', 'listProjects', 'saveChat', 'abortLoop', 'vfsRead'];
    for (const method of oneshotSamples) {
      expect(STREAM_METHODS.has(method)).toBe(false);
    }
  });
});
