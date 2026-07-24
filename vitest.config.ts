import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Resolve a path relative to this config file.
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  resolve: {
    // The automatic JSX runtime injects imports of
    // `@sinistermage/coyote-js/jsx-runtime`; map them (and the package root) to
    // source so the moved dom/router tsx tests compile against this package's own
    // dom without a build step. Longest keys first so the subpath never shadows
    // the root alias.
    alias: [
      { find: '@sinistermage/coyote-js/jsx-runtime', replacement: r('./src/dom/jsx-runtime.ts') },
      { find: '@sinistermage/coyote-js/jsx-dev-runtime', replacement: r('./src/dom/jsx-runtime.ts') },
      { find: /^@sinistermage\/coyote-js$/, replacement: r('./src/index.ts') },
      { find: /^@sinistermage\/coyote-js\/(.*)$/, replacement: r('./src/$1') },
    ],
  },
  // Automatic JSX runtime pointed at this package's own dom.
  esbuild: { jsx: 'automatic', jsxImportSource: '@sinistermage/coyote-js' },
  worker: { format: 'es' },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // jsdom gives every test a window/document/MessageChannel/queueMicrotask, so
    // reactivity, DOM, worker-RPC, router, and store tests all run under one env.
    environment: 'jsdom',
    globals: false,
    clearMocks: true,
  },
})
