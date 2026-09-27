import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { standardDecoratorPlugin } from '../vitest.shared.ts'

// Real-API lane for the dsh-personal bundle. Run from the dsh repo root with
// a configured default model route in the real harness home:
//   npx vitest run --config dsh-personal/vitest.e2e.config.ts
// Each test self-skips when no route is configured.
export default defineConfig({
  plugins: [standardDecoratorPlugin(), tsconfigPaths({ projects: ['./tsconfig.base.json'] })],
  test: {
    include: ['dsh-personal/tests/**/*.e2e.ts'],
    setupFiles: ['scripts/test-invariants.ts'],
    environment: 'node',
    testTimeout: 900_000,
    hookTimeout: 120_000,
  },
})
