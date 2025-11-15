import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Set env vars BEFORE modules are loaded, so config.ts sees :memory:
    env: {
      DB_PATH: ':memory:',
    },
  },
});
