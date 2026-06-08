import { describe, it, expect } from 'vitest';
import { binaryReplacer, binaryReviver } from '../binaryEncoding';

function roundTrip(input: unknown): unknown {
  return JSON.parse(JSON.stringify(input, binaryReplacer), binaryReviver);
}

describe('binaryEncoding', () => {
  it('round-trips a Uint8Array', () => {
    const bytes = new Uint8Array([0, 1, 2, 0xfe, 0xff]);
    const out = roundTrip({ data: bytes }) as { data: Uint8Array };
    expect(out.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(out.data)).toEqual([0, 1, 2, 0xfe, 0xff]);
  });

  it('round-trips an ArrayBuffer (as Uint8Array on the receiving end)', () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const out = roundTrip({ data: bytes.buffer }) as { data: Uint8Array };
    expect(out.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(out.data)).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('preserves high-unicode strings through JSON', () => {
    const s = '你好 🎉 \uFEFFHello\n𐍈\u{1F600}';
    const out = roundTrip({ s }) as { s: string };
    expect(out.s).toBe(s);
  });

  it('leaves plain strings untouched', () => {
    const out = roundTrip({ s: 'hello' }) as { s: string };
    expect(out.s).toBe('hello');
  });

  it('revives ISO date strings to Date objects', () => {
    const d = new Date('2024-01-15T09:30:00.000Z');
    const out = roundTrip({ d }) as { d: Date };
    expect(out.d).toBeInstanceOf(Date);
    expect(out.d.toISOString()).toBe(d.toISOString());
  });
});
