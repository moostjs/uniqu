import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@uniqu/core': path.resolve(__dirname, 'packages/core/src/index.ts'),
      '@uniqu/url': path.resolve(__dirname, 'packages/url/src/index.ts'),
    },
  },
  test: {
    passWithNoTests: true,
    typecheck: {
      // Type-level tests (`*.test-d.ts`) run through tsc alongside the runtime tests.
      enabled: true,
      include: ['packages/*/src/**/*.test-d.ts'],
      // Source type errors are the build's concern; only assertions in test-d files fail the run.
      ignoreSourceErrors: true,
    },
  },
})
