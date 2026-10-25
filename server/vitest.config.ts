import { defineConfig } from 'vitest/config';

const root = new URL('..', import.meta.url).pathname;

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://depmap:depmap@localhost:5433/depmap_test',
      DATA_MODE: 'replay',
      FIXTURES_DIR: `${root}fixtures/http/`,
      ADVISORY_FEED: `${root}fixtures/feed/simulated-advisory.json`,
    },
  },
});
