import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Suites spawn a real Anvil node in beforeAll; give hooks room in CI.
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
