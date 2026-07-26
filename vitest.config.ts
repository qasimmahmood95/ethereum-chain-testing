import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The default reporter drops console output from hooks in non-TTY runs;
    // CI must show the harness line (anvil version + port) per docs/PLAN.md.
    reporters: ['verbose'],
    // Suites spawn a real Anvil node in beforeAll; give hooks room in CI.
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
