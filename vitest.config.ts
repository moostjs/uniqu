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
  },
})
