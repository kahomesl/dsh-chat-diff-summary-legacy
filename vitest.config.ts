import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Component specs need a document; host and git specs opt into `node` with a
    // `@vitest-environment node` docblock (the engine is real `git` either way).
    environment: 'jsdom',
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    setupFiles: ['tests/support/setup.ts'],
    globals: false,
    // Real `git` subprocesses against real temporary repositories.
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
})
