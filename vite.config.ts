import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

// One entry per public subpath (mirrors the package.json "exports" map). Vite
// library mode with `preserveModules` keeps the per-module folder structure in
// dist so each subpath resolves to its own file; internal `../reactivity`-style
// imports are rewritten to concrete, extensioned specifiers Node ESM can load.
export default defineConfig({
  build: {
    lib: {
      entry: {
        index: r('./src/index.ts'),
        'reactivity/index': r('./src/reactivity/index.ts'),
        'dom/index': r('./src/dom/index.ts'),
        'dom/jsx-runtime': r('./src/dom/jsx-runtime.ts'),
        'router/index': r('./src/router/index.ts'),
        'worker/index': r('./src/worker/index.ts'),
        'store/index': r('./src/store/index.ts'),
        'http/index': r('./src/http/index.ts'),
        'loader/index': r('./src/loader/index.ts'),
      },
      formats: ['es'],
    },
    outDir: 'dist',
    // The `build` script pre-cleans dist; keep vite from wiping it again so the
    // subsequent `tsc` .d.ts emit into the same dir isn't clobbered.
    emptyOutDir: false,
    rollupOptions: {
      // Keep the self-referential JSX runtime import external so it resolves via
      // the package's own "exports" (./jsx-runtime) at consumer runtime.
      external: [/^coyote-js(\/.*)?$/],
      output: {
        preserveModules: true,
        preserveModulesRoot: 'src',
        entryFileNames: '[name].js',
      },
    },
    // Library output: don't minify, keep readable.
    minify: false,
    target: 'es2022',
  },
  // Automatic JSX runtime → the package's own jsx-runtime (kept external above).
  esbuild: { jsx: 'automatic', jsxImportSource: 'coyote-js' },
  worker: { format: 'es' },
})
