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

  it('round-trips a Date via the __date marker', () => {
    const d = new Date('2024-01-15T09:30:00.000Z');
    const encoded = JSON.stringify({ d }, binaryReplacer);
    expect(encoded).toContain('__date');
    const out = JSON.parse(encoded, binaryReviver) as { d: Date };
    expect(out.d).toBeInstanceOf(Date);
    expect(out.d.toISOString()).toBe(d.toISOString());
  });

  it('round-trips a Date on a non-allowlisted key', () => {
    const d = new Date('2024-01-15T09:30:00.000Z');
    const out = roundTrip({ someRandomField: d }) as { someRandomField: Date };
    expect(out.someRandomField).toBeInstanceOf(Date);
  });

  it('round-trips a Date inside an array', () => {
    const d = new Date('2024-01-15T09:30:00.000Z');
    const out = roundTrip({ list: [d] }) as { list: Date[] };
    expect(out.list[0]).toBeInstanceOf(Date);
    expect(out.list[0].toISOString()).toBe(d.toISOString());
  });

  it('keeps an ISO-timestamp-valued string field a string (React #31 regression)', () => {
    const content = '2026-08-06T12:34:56.789Z';
    const out = roundTrip({ content }) as { content: string };
    expect(typeof out.content).toBe('string');
    expect(out.content).toBe(content);
  });

  it('revives bare ISO strings on allowlisted date keys (old-peer fallback)', () => {
    const wire = '{"timestamp":"2024-01-15T09:30:00.000Z","createdAt":"2024-01-15T09:30:00Z"}';
    const out = JSON.parse(wire, binaryReviver) as { timestamp: Date; createdAt: Date };
    expect(out.timestamp).toBeInstanceOf(Date);
    expect(out.createdAt).toBeInstanceOf(Date);
  });

  it('does not revive bare ISO strings on other keys (old-peer content stays a string)', () => {
    const wire = '{"content":"2024-01-15T09:30:00.000Z"}';
    const out = JSON.parse(wire, binaryReviver) as { content: string };
    expect(typeof out.content).toBe('string');
  });

  it('serializes an Invalid Date as null instead of throwing', () => {
    const encoded = JSON.stringify({ timestamp: new Date(NaN) }, binaryReplacer);
    expect(encoded).toBe('{"timestamp":null}');
    const out = JSON.parse(encoded, binaryReviver) as { timestamp: null };
    expect(out.timestamp).toBeNull();
  });

  it('serializes a nested Invalid Date as null', () => {
    const out = roundTrip({ chat: { updatedAt: new Date(NaN) } }) as {
      chat: { updatedAt: null };
    };
    expect(out.chat.updatedAt).toBeNull();
  });

  it('serializes an Invalid Date inside an array as null', () => {
    const valid = new Date('2024-01-15T09:30:00.000Z');
    const out = roundTrip({ list: [valid, new Date(NaN)] }) as { list: [Date, null] };
    expect(out.list[0]).toBeInstanceOf(Date);
    expect(out.list[1]).toBeNull();
  });

  it('round-trips a Uint8Array whose sibling field is a Date', () => {
    const out = roundTrip({
      data: new Uint8Array([1, 2]),
      timestamp: new Date('2024-01-15T09:30:00.000Z'),
    }) as { data: Uint8Array; timestamp: Date };
    expect(out.data).toBeInstanceOf(Uint8Array);
    expect(out.timestamp).toBeInstanceOf(Date);
  });
});
