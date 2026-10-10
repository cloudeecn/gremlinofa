import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // config.ts loads .env at import time and never overrides a variable that is already set,
    // so pin every variable here: a developer's .env must not leak into the tests.
    env: {
      DOTENV_CONFIG_PATH: '/dev/null',
      DB_PATH: ':memory:',
      API_PASSWORD: 'test-secret',
      WEB_PASSWORD: 'test-web',
      TRUST_PROXY: '',
      CORS_ORIGIN: '',
      HOST: '',
      PORT: '',
      POLL_TIMEOUT_MS: '',
      SESSION_RETENTION_DAYS: '',
    },
  },
});
