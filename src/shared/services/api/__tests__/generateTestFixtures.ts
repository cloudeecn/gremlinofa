/**
 * Test Fixture Generator for Responses API
 *
 * This script generates intermediate test data files by processing
 * the raw SSE stream files through the mapper and assembler.
 *
 * Run with: npx tsx src/services/api/__tests__/generateTestFixtures.ts
 */

import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parseSSEToStreamChunks } from '../responsesStreamMapper';
import { StreamingContentAssembler } from '../../streaming/StreamingContentAssembler';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DIR = __dirname;

interface TestCase {
  name: string;
  streamFile: string;
  chunksFile: string;
  renderingFile: string;
}

const testCases: TestCase[] = [
  {
    name: 'reason-memory',
    streamFile: 'responses-reason-memory-stream.txt',
    chunksFile: 'responses-reason-memory-streamChunks.json',
    renderingFile: 'responses-reason-memory-renderingContent.json',
  },
  {
    name: 'search-memory',
    streamFile: 'responses-search-memory-stream.txt',
    chunksFile: 'responses-search-memory-streamChunks.json',
    renderingFile: 'responses-search-memory-renderingContent.json',
  },
];

function generateFixtures(): void {
  for (const testCase of testCases) {
    console.log(`Processing ${testCase.name}...`);

    // Read SSE stream text
    const streamPath = join(TEST_DIR, testCase.streamFile);
    const sseText = readFileSync(streamPath, 'utf-8');

    // Parse to StreamChunks
    const chunks = parseSSEToStreamChunks(sseText);

    // Write chunks JSON
    const chunksPath = join(TEST_DIR, testCase.chunksFile);
    writeFileSync(chunksPath, JSON.stringify(chunks, null, 2));
    console.log(`  ✓ Generated ${testCase.chunksFile} (${chunks.length} chunks)`);

    // Feed through StreamingContentAssembler
    const assembler = new StreamingContentAssembler();
    for (const chunk of chunks) {
      assembler.pushChunk(chunk);
    }
    const renderingContent = assembler.finalize();

    // Write rendering content JSON
    const renderingPath = join(TEST_DIR, testCase.renderingFile);
    writeFileSync(renderingPath, JSON.stringify(renderingContent, null, 2));
    console.log(`  ✓ Generated ${testCase.renderingFile} (${renderingContent.length} groups)`);
  }

  console.log('\nAll fixtures generated successfully!');
}

// Run if executed directly
generateFixtures();
