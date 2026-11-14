import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// End-to-end tests drive the real Electron app (run `npm run build` first).
export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: {
    include: ['tests/e2e/**/*.e2e.ts'],
    environment: 'node',
    testTimeout: 120000,
    hookTimeout: 60000,
    fileParallelism: false
  }
})
