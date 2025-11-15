/**
 * Unit tests for CSV Helper utilities
 * Tests RFC 4180 compliance
 */

import { describe, it, expect } from 'vitest';
import {
  escapeCSV,
  parseCSV,
  buildCSVLine,
  createCSVParserState,
  parseCSVChunk,
  finalizeCSVParser,
  streamCSVRows,
} from '../csvHelper';

describe('csvHelper', () => {
  describe('escapeCSV', () => {
    it('should return empty string for null/undefined', () => {
      expect(escapeCSV(null)).toBe('');
      expect(escapeCSV(undefined)).toBe('');
    });

    it('should return empty string for empty string', () => {
      expect(escapeCSV('')).toBe('');
    });

    it('should return simple string as-is', () => {
      expect(escapeCSV('simple')).toBe('simple');
      expect(escapeCSV('hello world')).toBe('hello world');
    });

    it('should wrap in quotes if contains comma', () => {
      expect(escapeCSV('hello,world')).toBe('"hello,world"');
      expect(escapeCSV('a,b,c')).toBe('"a,b,c"');
    });

    it('should wrap in quotes and escape quotes by doubling', () => {
      expect(escapeCSV('hello "world"')).toBe('"hello ""world"""');
      expect(escapeCSV('"quoted"')).toBe('"""quoted"""');
    });

    it('should wrap in quotes if contains newline', () => {
      expect(escapeCSV('hello\nworld')).toBe('"hello\nworld"');
      expect(escapeCSV('line1\nline2\nline3')).toBe('"line1\nline2\nline3"');
    });

    it('should wrap in quotes if contains carriage return', () => {
      expect(escapeCSV('hello\rworld')).toBe('"hello\rworld"');
      expect(escapeCSV('line1\r\nline2')).toBe('"line1\r\nline2"');
    });

    it('should handle combination of special characters', () => {
      expect(escapeCSV('hello, "world"\nnew line')).toBe('"hello, ""world""\nnew line"');
    });

    it('should handle JSON strings', () => {
      const json = '{"key":"value","nested":{"a":"b"}}';
      expect(escapeCSV(json)).toBe('"{""key"":""value"",""nested"":{""a"":""b""}}"');
    });
  });

  describe('parseCSV', () => {
    it('should parse simple CSV', () => {
      const csv = 'a,b,c\n1,2,3';
      expect(parseCSV(csv)).toEqual([
        ['a', 'b', 'c'],
        ['1', '2', '3'],
      ]);
    });

    it('should parse CSV with quoted fields', () => {
      const csv = '"name","age","city"\n"John","30","New York"';
      expect(parseCSV(csv)).toEqual([
        ['name', 'age', 'city'],
        ['John', '30', 'New York'],
      ]);
    });

    it('should parse quoted fields with commas', () => {
      const csv = '"hello, world","simple"';
      expect(parseCSV(csv)).toEqual([['hello, world', 'simple']]);
    });

    it('should parse quoted fields with newlines', () => {
      const csv = '"line1\nline2","field2"';
      expect(parseCSV(csv)).toEqual([['line1\nline2', 'field2']]);
    });

    it('should parse escaped quotes (doubled quotes)', () => {
      const csv = '"hello ""world""","simple"';
      expect(parseCSV(csv)).toEqual([['hello "world"', 'simple']]);
    });

    it('should handle CRLF line endings', () => {
      const csv = 'a,b,c\r\n1,2,3\r\n4,5,6';
      expect(parseCSV(csv)).toEqual([
        ['a', 'b', 'c'],
        ['1', '2', '3'],
        ['4', '5', '6'],
      ]);
    });

    it('should handle empty fields', () => {
      const csv = 'a,,c\n,2,\n,,';
      expect(parseCSV(csv)).toEqual([
        ['a', '', 'c'],
        ['', '2', ''],
        ['', '', ''],
      ]);
    });

    it('should handle quoted empty string', () => {
      const csv = '"","field2",""';
      expect(parseCSV(csv)).toEqual([['', 'field2', '']]);
    });

    it('should handle single field', () => {
      expect(parseCSV('single')).toEqual([['single']]);
    });

    it('should handle empty CSV', () => {
      expect(parseCSV('')).toEqual([]);
    });

    it('should handle trailing newline', () => {
      const csv = 'a,b,c\n1,2,3\n';
      expect(parseCSV(csv)).toEqual([
        ['a', 'b', 'c'],
        ['1', '2', '3'],
      ]);
    });

    it('should handle complex JSON in CSV field', () => {
      const json = '{"key":"value","nested":{"a":"b"}}';
      const csv = `"${json.replace(/"/g, '""')}","other"`;
      const result = parseCSV(csv);
      expect(result).toEqual([[json, 'other']]);
    });

    it('should handle consecutive commas', () => {
      const csv = 'a,,,d';
      expect(parseCSV(csv)).toEqual([['a', '', '', 'd']]);
    });

    it('should handle mix of quoted and unquoted fields', () => {
      const csv = 'simple,"quoted, with comma",another';
      expect(parseCSV(csv)).toEqual([['simple', 'quoted, with comma', 'another']]);
    });
  });

  describe('buildCSVLine', () => {
    it('should build simple CSV line', () => {
      expect(buildCSVLine(['a', 'b', 'c'])).toBe('a,b,c');
    });

    it('should handle fields with commas', () => {
      expect(buildCSVLine(['hello, world', 'simple'])).toBe('"hello, world",simple');
    });

    it('should handle fields with quotes', () => {
      expect(buildCSVLine(['hello "world"', 'simple'])).toBe('"hello ""world""",simple');
    });

    it('should handle null/undefined fields', () => {
      expect(buildCSVLine(['a', null, undefined, 'd'])).toBe('a,,,d');
    });

    it('should handle empty strings', () => {
      expect(buildCSVLine(['a', '', 'c'])).toBe('a,,c');
    });

    it('should handle fields with newlines', () => {
      expect(buildCSVLine(['hello\nworld', 'simple'])).toBe('"hello\nworld",simple');
    });
  });

  describe('Roundtrip Tests', () => {
    it('should roundtrip simple data', () => {
      const data = ['hello', 'world', 'test'];
      const csv = buildCSVLine(data);
      const parsed = parseCSV(csv);
      expect(parsed[0]).toEqual(data);
    });

    it('should roundtrip data with commas', () => {
      const data = ['hello, world', 'test, data', 'simple'];
      const csv = buildCSVLine(data);
      const parsed = parseCSV(csv);
      expect(parsed[0]).toEqual(data);
    });

    it('should roundtrip data with quotes', () => {
      const data = ['hello "world"', 'test "data"', 'simple'];
      const csv = buildCSVLine(data);
      const parsed = parseCSV(csv);
      expect(parsed[0]).toEqual(data);
    });

    it('should roundtrip data with newlines', () => {
      const data = ['hello\nworld', 'test\ndata', 'simple'];
      const csv = buildCSVLine(data);
      const parsed = parseCSV(csv);
      expect(parsed[0]).toEqual(data);
    });

    it('should roundtrip complex JSON data', () => {
      const json1 = '{"key":"value","nested":{"a":"b"}}';
      const json2 = '{"array":[1,2,3],"text":"hello, world"}';
      const data = [json1, json2, 'simple'];
      const csv = buildCSVLine(data);
      const parsed = parseCSV(csv);
      expect(parsed[0]).toEqual(data);
    });

    it('should roundtrip multi-line CSV', () => {
      const rows = [
        ['name', 'age', 'city'],
        ['John', '30', 'New York'],
        ['Jane, "J"', '25', 'Los Angeles'],
        ['Bob\nSmith', '35', 'Chicago, IL'],
      ];

      const csv = rows.map(row => buildCSVLine(row)).join('\n');
      const parsed = parseCSV(csv);
      expect(parsed).toEqual(rows);
    });

    it('should handle empty values in roundtrip', () => {
      const data = ['a', '', null, undefined, 'e'];
      const csv = buildCSVLine(data);
      const parsed = parseCSV(csv);
      // null/undefined become empty strings
      expect(parsed[0]).toEqual(['a', '', '', '', 'e']);
    });
  });

  describe('Edge Cases', () => {
    it('should handle single quote character', () => {
      expect(escapeCSV('"')).toBe('""""');
      const csv = buildCSVLine(['"']);
      expect(parseCSV(csv)).toEqual([['"']]);
    });

    it('should handle multiple consecutive quotes', () => {
      const value = '""';
      expect(escapeCSV(value)).toBe('""""""');
      const csv = buildCSVLine([value]);
      expect(parseCSV(csv)).toEqual([[value]]);
    });

    it('should handle comma at start/end', () => {
      expect(escapeCSV(',start')).toBe('",start"');
      expect(escapeCSV('end,')).toBe('"end,"');
    });

    it('should handle very long strings', () => {
      const longString = 'a'.repeat(10000);
      const escaped = escapeCSV(longString);
      expect(escaped).toBe(longString);

      const longWithComma = 'a'.repeat(5000) + ',' + 'b'.repeat(5000);
      const csv = buildCSVLine([longWithComma]);
      const parsed = parseCSV(csv);
      expect(parsed[0][0]).toBe(longWithComma);
    });

    it('should handle unicode characters', () => {
      const data = ['😀', '你好', 'مرحبا', '🎉'];
      const csv = buildCSVLine(data);
      const parsed = parseCSV(csv);
      expect(parsed[0]).toEqual(data);
    });

    it('should handle tab characters', () => {
      const data = ['hello\tworld', 'test'];
      const csv = buildCSVLine(data);
      const parsed = parseCSV(csv);
      expect(parsed[0]).toEqual(data);
    });
  });

  describe('Streaming CSV Parser', () => {
    describe('parseCSVChunk', () => {
      it('should parse a simple complete chunk', () => {
        const state = createCSVParserState();
        const rows = parseCSVChunk('a,b,c\n1,2,3\n', state);
        expect(rows).toEqual([
          ['a', 'b', 'c'],
          ['1', '2', '3'],
        ]);
      });

      it('should handle incomplete row at end of chunk', () => {
        const state = createCSVParserState();
        const rows = parseCSVChunk('a,b,c\n1,2,', state);
        expect(rows).toEqual([['a', 'b', 'c']]);
        // The partial row should be in state
        expect(state.currentLine).toEqual(['1', '2']);
        expect(state.currentField).toBe('');
      });

      it('should continue parsing across chunks', () => {
        const state = createCSVParserState();

        // First chunk ends mid-row
        const rows1 = parseCSVChunk('a,b,c\n1,2,', state);
        expect(rows1).toEqual([['a', 'b', 'c']]);

        // Second chunk completes the row
        const rows2 = parseCSVChunk('3\n4,5,6\n', state);
        expect(rows2).toEqual([
          ['1', '2', '3'],
          ['4', '5', '6'],
        ]);
      });

      it('should handle quoted field split across chunks', () => {
        const state = createCSVParserState();

        // First chunk starts a quoted field
        const rows1 = parseCSVChunk('a,"hello ', state);
        expect(rows1).toEqual([]);
        expect(state.inQuotes).toBe(true);

        // Second chunk completes the quoted field
        const rows2 = parseCSVChunk('world",c\n', state);
        expect(rows2).toEqual([['a', 'hello world', 'c']]);
        expect(state.inQuotes).toBe(false);
      });

      it('should handle escaped quotes split across chunks', () => {
        const state = createCSVParserState();

        // First chunk has opening quote and first part including escaped quote
        // "hello ""world"" -> hello "world"
        const rows1 = parseCSVChunk('a,"hello ""', state);
        expect(rows1).toEqual([]);

        // Second chunk completes the escaped quote
        const rows2 = parseCSVChunk('world""",c\n', state);
        expect(rows2).toEqual([['a', 'hello "world"', 'c']]);
      });

      it('should handle CRLF split across chunks', () => {
        const state = createCSVParserState();

        // First chunk ends with \r
        const rows1 = parseCSVChunk('a,b,c\r', state);
        expect(rows1).toEqual([['a', 'b', 'c']]);
        expect(state.pendingCarriageReturn).toBe(true);

        // Second chunk starts with \n
        const rows2 = parseCSVChunk('\n1,2,3\n', state);
        expect(rows2).toEqual([['1', '2', '3']]);
        expect(state.pendingCarriageReturn).toBe(false);
      });

      it('should handle standalone CR', () => {
        const state = createCSVParserState();
        const rows1 = parseCSVChunk('a,b,c\r', state);
        expect(rows1).toEqual([['a', 'b', 'c']]);

        // Next chunk does not start with \n
        const rows2 = parseCSVChunk('1,2,3\r', state);
        expect(rows2).toEqual([['1', '2', '3']]);
      });

      it('should handle newline inside quoted field across chunks', () => {
        const state = createCSVParserState();

        const rows1 = parseCSVChunk('"line1\n', state);
        expect(rows1).toEqual([]);
        expect(state.inQuotes).toBe(true);
        expect(state.currentField).toBe('line1\n');

        const rows2 = parseCSVChunk('line2",b\n', state);
        expect(rows2).toEqual([['line1\nline2', 'b']]);
      });
    });

    describe('finalizeCSVParser', () => {
      it('should return final row if present', () => {
        const state = createCSVParserState();
        parseCSVChunk('a,b,c', state);

        const finalRow = finalizeCSVParser(state);
        expect(finalRow).toEqual(['a', 'b', 'c']);
      });

      it('should return null if no pending data', () => {
        const state = createCSVParserState();
        parseCSVChunk('a,b,c\n', state);

        const finalRow = finalizeCSVParser(state);
        expect(finalRow).toBe(null);
      });

      it('should handle partial field', () => {
        const state = createCSVParserState();
        parseCSVChunk('a,b,partial', state);

        const finalRow = finalizeCSVParser(state);
        expect(finalRow).toEqual(['a', 'b', 'partial']);
      });
    });

    describe('streamCSVRows', () => {
      // Helper to create a File from string content
      function createFile(content: string, name = 'test.csv'): File {
        return new File([content], name, { type: 'text/csv' });
      }

      // Helper to collect all rows from async generator
      async function collectRows(
        generator: AsyncGenerator<string[], void, unknown>
      ): Promise<string[][]> {
        const rows: string[][] = [];
        for await (const row of generator) {
          rows.push(row);
        }
        return rows;
      }

      it('should stream rows from a small file', async () => {
        const file = createFile('a,b,c\n1,2,3\n4,5,6');
        const rows = await collectRows(streamCSVRows(file));
        expect(rows).toEqual([
          ['a', 'b', 'c'],
          ['1', '2', '3'],
          ['4', '5', '6'],
        ]);
      });

      it('should handle file with trailing newline', async () => {
        const file = createFile('a,b,c\n1,2,3\n');
        const rows = await collectRows(streamCSVRows(file));
        expect(rows).toEqual([
          ['a', 'b', 'c'],
          ['1', '2', '3'],
        ]);
      });

      it('should handle quoted fields with newlines', async () => {
        const file = createFile('"line1\nline2",b\nc,d');
        const rows = await collectRows(streamCSVRows(file));
        expect(rows).toEqual([
          ['line1\nline2', 'b'],
          ['c', 'd'],
        ]);
      });

      it('should handle quoted fields with commas', async () => {
        const file = createFile('"hello, world",simple\n"a,b",c');
        const rows = await collectRows(streamCSVRows(file));
        expect(rows).toEqual([
          ['hello, world', 'simple'],
          ['a,b', 'c'],
        ]);
      });

      it('should handle escaped quotes', async () => {
        const file = createFile('"say ""hello""",b\nc,d');
        const rows = await collectRows(streamCSVRows(file));
        expect(rows).toEqual([
          ['say "hello"', 'b'],
          ['c', 'd'],
        ]);
      });

      it('should handle empty file', async () => {
        const file = createFile('');
        const rows = await collectRows(streamCSVRows(file));
        expect(rows).toEqual([]);
      });

      it('should handle single row without newline', async () => {
        const file = createFile('a,b,c');
        const rows = await collectRows(streamCSVRows(file));
        expect(rows).toEqual([['a', 'b', 'c']]);
      });

      it('should handle CRLF line endings', async () => {
        const file = createFile('a,b,c\r\n1,2,3\r\n');
        const rows = await collectRows(streamCSVRows(file));
        expect(rows).toEqual([
          ['a', 'b', 'c'],
          ['1', '2', '3'],
        ]);
      });

      it('should produce same results as parseCSV', async () => {
        const csvContent = [
          'name,age,city',
          '"John ""J"" Doe",30,"New York, NY"',
          '"Jane\nSmith",25,Boston',
          'Bob,35,"Chicago, IL"',
        ].join('\n');

        const file = createFile(csvContent);
        const streamedRows = await collectRows(streamCSVRows(file));
        const parsedRows = parseCSV(csvContent);

        expect(streamedRows).toEqual(parsedRows);
      });

      it('should handle very small chunk size', async () => {
        const file = createFile('a,b,c\n1,2,3');
        // Use tiny chunk size (10 bytes) to test cross-chunk parsing
        const rows = await collectRows(streamCSVRows(file, 10));
        expect(rows).toEqual([
          ['a', 'b', 'c'],
          ['1', '2', '3'],
        ]);
      });

      it('should handle chunk boundary in middle of field', async () => {
        const file = createFile('hello,world\ntest,data');
        // Chunk size that splits "hello" and "world"
        const rows = await collectRows(streamCSVRows(file, 7));
        expect(rows).toEqual([
          ['hello', 'world'],
          ['test', 'data'],
        ]);
      });

      it('should handle chunk boundary in middle of quoted field', async () => {
        const file = createFile('"hello world",simple\na,b');
        // Chunk size that splits inside the quoted field
        const rows = await collectRows(streamCSVRows(file, 8));
        expect(rows).toEqual([
          ['hello world', 'simple'],
          ['a', 'b'],
        ]);
      });
    });

    describe('Streaming vs Non-streaming Parity', () => {
      async function compareResults(csvContent: string) {
        const file = new File([csvContent], 'test.csv', { type: 'text/csv' });
        const streamedRows: string[][] = [];
        for await (const row of streamCSVRows(file)) {
          streamedRows.push(row);
        }
        const parsedRows = parseCSV(csvContent);
        return { streamedRows, parsedRows };
      }

      it('should match for simple CSV', async () => {
        const { streamedRows, parsedRows } = await compareResults('a,b,c\n1,2,3\n4,5,6');
        expect(streamedRows).toEqual(parsedRows);
      });

      it('should match for CSV with quoted fields', async () => {
        const { streamedRows, parsedRows } = await compareResults(
          '"hello, world","test ""data"""\n"line1\nline2",simple'
        );
        expect(streamedRows).toEqual(parsedRows);
      });

      it('should match for CSV with empty fields', async () => {
        const { streamedRows, parsedRows } = await compareResults('a,,c\n,b,\n,,');
        expect(streamedRows).toEqual(parsedRows);
      });

      it('should match for CSV with CRLF', async () => {
        const { streamedRows, parsedRows } = await compareResults('a,b,c\r\n1,2,3\r\n4,5,6');
        expect(streamedRows).toEqual(parsedRows);
      });

      it('should match for complex JSON content', async () => {
        const json = '{"key":"value","nested":{"a":"b"}}';
        const csv = `"${json.replace(/"/g, '""')}",other\nsimple,data`;
        const { streamedRows, parsedRows } = await compareResults(csv);
        expect(streamedRows).toEqual(parsedRows);
      });
    });
  });
});
