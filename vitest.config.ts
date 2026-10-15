import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      // The demo server runs as a child process in its tests (v8 cannot see it), and the
      // UI entry runs in a browser; both are covered by end-to-end tests instead.
      exclude: ['packages/web/src/demo-server.ts', 'packages/ui/src/**', 'packages/*/src/index.ts'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
