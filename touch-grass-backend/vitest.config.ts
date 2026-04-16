import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    env: {
      DB_PATH: ':memory:',
      API_PASSWORD: 'test-secret',
      WEB_PASSWORD: 'test-web',
    },
  },
});
