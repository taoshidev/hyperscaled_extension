import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.js'],
    globals: true,
    testTimeout: 30000,   // 30s default — real HTTP calls
    hookTimeout: 20000,   // 20s for beforeAll fetches
    // Lifecycle tests use per-test { timeout: N } overrides for poll loops
    pool: 'forks',        // each test file in its own process — no shared fetch state
    poolOptions: {
      forks: { singleFork: false },
    },
    // Run test files sequentially so lifecycle tests don't race with read-only tests
    sequence: { concurrent: false },
    reporter: 'verbose',
  },
});
