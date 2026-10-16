import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  // Tests always run against the sources, never a stale dist build.
  resolve: {
    alias: [
      { find: /^@vesper\/protocol$/, replacement: source('./packages/protocol/src/index.ts') },
      { find: /^@vesper\/ptyd$/, replacement: source('./packages/ptyd/src/index.ts') },
      { find: /^@vesper\/ptyd\/client$/, replacement: source('./packages/ptyd/src/client.ts') },
      { find: /^@vesper\/web\/auth$/, replacement: source('./packages/web/src/auth-exports.ts') },
    ],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      // Process entry points run as child processes in their tests (v8 cannot see them), and
      // the UI runs in a browser; end-to-end tests cover them instead.
      exclude: ['packages/*/src/main.ts', 'packages/ui/src/**', 'packages/*/src/index.ts'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
