# coyote-js

coyote-js — a from-scratch, TypeScript-native, fine-grained reactive UI framework: signals, a no-VDOM JSX renderer, a client router, a typed worker-RPC pool, and a fine-grained store.

## Install

```bash
npm install coyote-js
```

## Subpath imports

```ts
import { signal, computed, effect } from 'coyote-js/reactivity'
import { render, For, Show } from 'coyote-js/dom'
import { Router, Link, createResource } from 'coyote-js/router'
import { spawn, pool, defineWorker } from 'coyote-js/worker'
import { createStore, defineStore } from 'coyote-js/store'
```

JSX uses the automatic runtime — set `"jsxImportSource": "coyote-js"` in your `tsconfig.json`
(and the same for your bundler's esbuild/JSX options).

## License

MIT © 2026 sinisterMage
