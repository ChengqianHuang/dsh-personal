import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

// Personal bundle lives outside the dsh workspace; run from the dsh repo root
// (`npx vitest run --config dsh-personal/vitest.config.ts`) so tsconfig paths
// resolve the @deepseek-ai/* dev imports against the checkout.
export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] })],
  test: {
    include: ['dsh-personal/tests/**/*.spec.ts'],
    setupFiles: ['scripts/test-invariants.ts'],
    environment: 'node',
  },
})
