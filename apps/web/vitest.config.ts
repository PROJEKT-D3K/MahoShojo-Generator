import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    {
      name: 'vitest-style-stub',
      enforce: 'pre',
      resolveId(source) {
        if (source.endsWith('.css')) return '\0vitest-style-stub';
        return null;
      },
      load(id) {
        if (id === '\0vitest-style-stub') return 'export default {};';
        return null;
      },
    },
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
      'server-only': path.resolve(__dirname, 'tests/helpers/server-only.ts'),
    },
  },
  test: {
    environment: 'node',
    env: {
      NEXT_PUBLIC_HOSTED_API_ENVIRONMENT: 'test',
    },
    globals: true,
    include: ['tests/**/*.test.{ts,tsx,js}'],
    setupFiles: ['tests/setup.ts'],
    restoreMocks: true,
    clearMocks: true,
    // 多核机器最多使用 8 个 worker，限制内存与并发争用；小型 CI 仍按可用核心数缩放。
    maxWorkers: Math.min(Math.max(os.availableParallelism() - 1, 1), 8),
    // 为重型用例在慢速 CI 上留出余量，同时让真实挂起在有限时间内失败。
    testTimeout: 20_000,
  },
  esbuild: {
    jsx: 'automatic',
    tsconfigRaw: {
      compilerOptions: {
        jsx: 'react-jsx',
      },
    },
  },
  oxc: false,
});
