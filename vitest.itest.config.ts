import { defineConfig } from 'vitest/config';

// Integration tests against a REAL MEGAcmd and a REAL (test) account - never part
// of `npm test`. Run with: MEGA_MCP_ITEST_ACCOUNT=<test email> npm run itest
export default defineConfig({
  test: {
    include: ['test/integration/**/*.itest.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
