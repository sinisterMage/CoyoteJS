import { afterEach, describe, expect, it, vi } from 'vitest'
// dom code from the local modules; reactivity from the sibling reactivity module.
import { flushSync, signal } from '../reactivity'
import { h } from './h'
import { render } from './render'
import { onMount, onCleanup } from './lifecycle'
import { For, Index, Show, Switch, Match, Dynamic, Portal } from './control-flow'
import { ErrorBoundary, Suspense, useSuspense } from './boundaries'
import { createContext, useContext } from './context'

// Render into a detached container and always dispose after each test.
let disposers: Array<() => void> = []
function mount(code: () => any): HTMLElement {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const dispose = render(code, root)
  disposers.push(() => {
    dispose()
    root.remove()
  })
  return root
}
afterEach(() => {
  for (const d of disposers.splice(0)) d()
})

const tick = () => new Promise<void>((r) => queueMicrotask(() => r()))

describe('static render', () => {
  it('creates a tag with attrs and a text child', () => {
    const root = mount(() => h('div', { id: 'box', title: 'hi' }, 'hello'))
    const el = root.querySelector('#box') as HTMLDivElement
    expect(el).toBeTruthy()
    expect(el.getAttribute('title')).toBe('hi')
    expect(el.textContent).toBe('hello')
  })

  it('nests elements and numeric children', () => {
    const root = mount(() => h('ul', null, h('li', null, 'a'), h('li', null, 1)))
    expect(root.querySelectorAll('li').length).toBe(2)
    expect(root.textContent).toBe('a1')
  })
})

describe('reactive text child', () => {
  it('updates the DOM after flushSync', () => {
    const [count, setCount] = signal(0)
    const root = mount(() => h('span', null, () => count()))
    expect(root.textContent).toBe('0')
    setCount(5)
    flushSync()
    expect(root.textContent).toBe('5')
  })

  it('updates via the microtask queue without flushSync', async () => {
    const [msg, setMsg] = signal('a')
    const root = mount(() => h('p', null, () => msg()))
    expect(root.textContent).toBe('a')
    setMsg('b')
    await tick()
    expect(root.textContent).toBe('b')
  })
})

describe('reactive attribute / class / style', () => {
  it('reactive attribute', () => {
    const [t, setT] = signal('one')
    const root = mount(() => h('div', { title: () => t() }))
    const el = root.firstElementChild as HTMLElement
    expect(el.getAttribute('title')).toBe('one')
    setT('two')
    flushSync()
    expect(el.getAttribute('title')).toBe('two')
  })

  it('reactive class string', () => {
    const [c, setC] = signal('red')
    const root = mount(() => h('div', { class: () => c() }))
    const el = root.firstElementChild as HTMLElement
    expect(el.className).toBe('red')
    setC('blue')
    flushSync()
    expect(el.className).toBe('blue')
  })

  it('classList toggles per key reactively', () => {
    const [on, setOn] = signal(true)
    const root = mount(() => h('div', { classList: { active: () => on(), always: true } }))
    const el = root.firstElementChild as HTMLElement
    expect(el.classList.contains('active')).toBe(true)
    expect(el.classList.contains('always')).toBe(true)
    setOn(false)
    flushSync()
    expect(el.classList.contains('active')).toBe(false)
    expect(el.classList.contains('always')).toBe(true)
  })

  it('style object with a reactive value', () => {
    const [w, setW] = signal('10px')
    const root = mount(() => h('div', { style: { width: () => w(), color: 'red' } }))
    const el = root.firstElementChild as HTMLElement
    expect(el.style.width).toBe('10px')
    expect(el.style.color).toBe('red')
    setW('20px')
    flushSync()
    expect(el.style.width).toBe('20px')
  })

  it('reactive whole-style object clears keys dropped between runs', () => {
    const [mode, setMode] = signal('a')
    const root = mount(() =>
      h('div', { style: () => (mode() === 'a' ? { color: 'red' } : { width: '5px' }) }),
    )
    const el = root.firstElementChild as HTMLElement
    expect(el.style.color).toBe('red')
    setMode('b')
    flushSync()
    expect(el.style.width).toBe('5px')
    expect(el.style.color).toBe('') // stale key removed
  })
})

describe('events', () => {
  it('fires an event handler (not called reactively)', () => {
    const spy = vi.fn()
    const root = mount(() => h('button', { onClick: spy }, 'go'))
    const btn = root.querySelector('button') as HTMLButtonElement
    btn.click()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('two-way binds value + onInput', () => {
    const [text, setText] = signal('hi')
    const root = mount(() =>
      h('input', {
        value: () => text(),
        onInput: (e: Event) => setText((e.target as HTMLInputElement).value),
      }),
    )
    const input = root.querySelector('input') as HTMLInputElement
    expect(input.value).toBe('hi')
    input.value = 'there'
    input.dispatchEvent(new Event('input'))
    flushSync()
    expect(text()).toBe('there')
    setText('changed')
    flushSync()
    expect(input.value).toBe('changed')
  })
})

describe('ref', () => {
  it('receives the element', () => {
    let captured: Element | null = null
    mount(() => h('div', { ref: (el: Element) => (captured = el) }))
    expect(captured).not.toBeNull()
    expect((captured as unknown as Element).tagName).toBe('DIV')
  })
})

describe('components', () => {
  it('calls a component with props + children', () => {
    const Card = (p: { title: string; children?: any }) =>
      h('section', null, h('h1', null, p.title), p.children)
    const root = mount(() => h(Card, { title: 'T' }, h('p', null, 'body')))
    expect(root.querySelector('h1')?.textContent).toBe('T')
    expect(root.querySelector('p')?.textContent).toBe('body')
  })
})

describe('For', () => {
  it('adds, removes, and reorders rows; disposes removed rows', () => {
    const a = { id: 'a' }
    const b = { id: 'b' }
    const c = { id: 'c' }
    const cleanups: Record<string, number> = { a: 0, b: 0, c: 0 }
    const [list, setList] = signal<Array<{ id: string }>>([a, b])

    const root = mount(() =>
      h(
        'ul',
        null,
        For({
          each: () => list(),
          children: (item) => {
            onCleanup(() => {
              cleanups[item.id]++
            })
            return h('li', null, item.id)
          },
        }),
      ),
    )
    expect([...root.querySelectorAll('li')].map((n) => n.textContent)).toEqual(['a', 'b'])

    // add c
    setList([a, b, c])
    flushSync()
    expect([...root.querySelectorAll('li')].map((n) => n.textContent)).toEqual(['a', 'b', 'c'])

    // reorder
    setList([c, a, b])
    flushSync()
    expect([...root.querySelectorAll('li')].map((n) => n.textContent)).toEqual(['c', 'a', 'b'])
    // no disposals yet (all reused)
    expect(cleanups).toEqual({ a: 0, b: 0, c: 0 })

    // remove a
    setList([c, b])
    flushSync()
    expect([...root.querySelectorAll('li')].map((n) => n.textContent)).toEqual(['c', 'b'])
    expect(cleanups.a).toBe(1)
    expect(cleanups.b).toBe(0)
    expect(cleanups.c).toBe(0)
  })

  it('shows a fallback when empty', () => {
    const [list, setList] = signal<number[]>([])
    const root = mount(() =>
      h(
        'div',
        null,
        For({
          each: () => list(),
          fallback: h('em', null, 'empty'),
          children: (n) => h('span', null, n),
        }),
      ),
    )
    expect(root.querySelector('em')?.textContent).toBe('empty')
    setList([1])
    flushSync()
    expect(root.querySelector('em')).toBeNull()
    expect(root.querySelector('span')?.textContent).toBe('1')
  })

  it('reuses DOM nodes for unchanged items', () => {
    const a = { id: 'a' }
    const b = { id: 'b' }
    const [list, setList] = signal([a, b])
    const root = mount(() =>
      h(
        'ul',
        null,
        For({ each: () => list(), children: (item) => h('li', null, item.id) }),
      ),
    )
    const firstA = root.querySelector('li')!
    setList([b, a]) // reorder
    flushSync()
    const nodes = [...root.querySelectorAll('li')]
    // The 'a' row DOM node is reused (same reference), just repositioned.
    expect(nodes.includes(firstA)).toBe(true)
  })
})

describe('Index', () => {
  it('keeps rows by position and updates the item accessor', () => {
    const [list, setList] = signal(['x', 'y'])
    const seen: string[] = []
    const root = mount(() =>
      h(
        'ul',
        null,
        Index({
          each: () => list(),
          children: (item) => {
            const li = h('li', null, () => item())
            seen.push('made')
            return li
          },
        }),
      ),
    )
    expect([...root.querySelectorAll('li')].map((n) => n.textContent)).toEqual(['x', 'y'])
    const madeBefore = seen.length
    // Change a value in place — same positions, no new rows created.
    setList(['x', 'z'])
    flushSync()
    expect([...root.querySelectorAll('li')].map((n) => n.textContent)).toEqual(['x', 'z'])
    expect(seen.length).toBe(madeBefore) // no rows re-created
  })
})

describe('Show', () => {
  it('mounts/unmounts on truthiness and runs cleanup on unmount', () => {
    const cleanup = vi.fn()
    const [when, setWhen] = signal(false)
    const root = mount(() =>
      h(
        'div',
        null,
        Show({
          when: () => when(),
          fallback: h('span', null, 'off'),
          children: (() => {
            onCleanup(cleanup)
            return h('strong', null, 'on')
          }) as any,
        }),
      ),
    )
    // Note: children here is a function so cleanup registers inside the branch scope.
    expect(root.querySelector('span')?.textContent).toBe('off')
    expect(root.querySelector('strong')).toBeNull()

    setWhen(true)
    flushSync()
    expect(root.querySelector('strong')?.textContent).toBe('on')
    expect(root.querySelector('span')).toBeNull()
    expect(cleanup).not.toHaveBeenCalled()

    setWhen(false)
    flushSync()
    expect(root.querySelector('strong')).toBeNull()
    expect(root.querySelector('span')?.textContent).toBe('off')
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('keyed passes the value and re-mounts on value change', () => {
    const [user, setUser] = signal<{ name: string } | null>(null)
    const seen: string[] = []
    const root = mount(() =>
      h(
        'div',
        null,
        Show({
          when: () => user(),
          keyed: true,
          children: (u: { name: string }) => {
            seen.push(u.name)
            return h('span', null, u.name)
          },
        }),
      ),
    )
    expect(root.querySelector('span')).toBeNull()
    setUser({ name: 'ann' })
    flushSync()
    expect(root.querySelector('span')?.textContent).toBe('ann')
    setUser({ name: 'bob' })
    flushSync()
    expect(root.querySelector('span')?.textContent).toBe('bob')
    expect(seen).toEqual(['ann', 'bob'])
  })
})

describe('Switch / Match', () => {
  it('renders the first matching branch, else fallback', () => {
    const [n, setN] = signal(0)
    const root = mount(() =>
      h(
        'div',
        null,
        Switch({
          fallback: h('span', null, 'none'),
          children: [
            Match({ when: () => n() === 1, children: h('b', null, 'one') }),
            Match({ when: () => n() === 2, children: h('i', null, 'two') }),
          ],
        }),
      ),
    )
    expect(root.querySelector('span')?.textContent).toBe('none')
    setN(1)
    flushSync()
    expect(root.querySelector('b')?.textContent).toBe('one')
    expect(root.querySelector('span')).toBeNull()
    setN(2)
    flushSync()
    expect(root.querySelector('i')?.textContent).toBe('two')
    expect(root.querySelector('b')).toBeNull()
  })
})

describe('Dynamic', () => {
  it('swaps components', () => {
    const A = () => h('span', { class: 'a' }, 'A')
    const B = () => h('span', { class: 'b' }, 'B')
    const [which, setWhich] = signal<() => any>(() => A)
    const root = mount(() =>
      h('div', null, () => Dynamic({ component: which() } as any)),
    )
    expect(root.querySelector('.a')?.textContent).toBe('A')
    setWhich(() => B)
    flushSync()
    expect(root.querySelector('.b')?.textContent).toBe('B')
    expect(root.querySelector('.a')).toBeNull()
  })

  it('renders a string tag with props', () => {
    const root = mount(() => Dynamic({ component: 'h2', id: 'title', children: 'Hi' } as any))
    const el = root.querySelector('#title') as HTMLElement
    expect(el.tagName).toBe('H2')
    expect(el.textContent).toBe('Hi')
  })
})

describe('Portal', () => {
  it('renders into document.body and cleans up on unmount', () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    const dispose = render(
      () => h('div', null, Portal({ children: h('div', { id: 'portaled' }, 'x') })),
      root,
    )
    const portaled = document.getElementById('portaled')
    expect(portaled).toBeTruthy()
    expect(portaled?.parentNode).toBe(document.body)
    // Not inside the local root.
    expect(root.querySelector('#portaled')).toBeNull()
    dispose()
    flushSync()
    expect(document.getElementById('portaled')).toBeNull()
    root.remove()
  })

  it('renders into an explicit mount target', () => {
    const target = document.createElement('section')
    document.body.appendChild(target)
    const root = document.createElement('div')
    document.body.appendChild(root)
    const dispose = render(
      () => Portal({ mount: target, children: h('span', { id: 'p2' }, 'y') }),
      root,
    )
    expect(target.querySelector('#p2')?.textContent).toBe('y')
    dispose()
    target.remove()
    root.remove()
  })
})

describe('ErrorBoundary', () => {
  it('catches a synchronous render error and shows the fallback', () => {
    const Boom = () => {
      throw new Error('kaboom')
    }
    const root = mount(() =>
      ErrorBoundary({
        fallback: (err) => h('div', { class: 'err' }, (err as Error).message),
        // Children passed as a thunk so they evaluate INSIDE the boundary's
        // try/catch (this is what the JSX compiler does; with raw `h` we make it
        // lazy explicitly).
        children: (() => h('div', null, h(Boom as any, null))) as any,
      }),
    )
    expect(root.querySelector('.err')?.textContent).toBe('kaboom')
  })

  it('reset re-attempts the children', () => {
    let shouldThrow = true
    const Maybe = () => {
      if (shouldThrow) throw new Error('nope')
      return h('span', { class: 'ok' }, 'recovered')
    }
    let resetFn: (() => void) | null = null
    const root = mount(() =>
      ErrorBoundary({
        fallback: (_err, reset) => {
          resetFn = reset
          return h('button', { class: 'retry' }, 'retry')
        },
        children: () => h(Maybe as any, null),
      }),
    )
    expect(root.querySelector('.retry')).toBeTruthy()
    shouldThrow = false
    resetFn!()
    flushSync()
    expect(root.querySelector('.ok')?.textContent).toBe('recovered')
  })
})

describe('nested reactive slots', () => {
  it('a component returning a control-flow accessor at the top level updates independently', () => {
    // Regression: the outer render slot must NOT re-invoke the component when the
    // control-flow's own signal changes — only the nested slot re-runs.
    let componentCalls = 0
    const [on, setOn] = signal(false)
    const Panel = () => {
      componentCalls++
      return Show({
        when: () => on(),
        fallback: h('span', { class: 'off' }, 'off'),
        children: h('span', { class: 'on' }, 'on'),
      })
    }
    const root = mount(() => h(Panel as any, null))
    expect(componentCalls).toBe(1)
    expect(root.querySelector('.off')).toBeTruthy()
    setOn(true)
    flushSync()
    expect(root.querySelector('.on')).toBeTruthy()
    expect(root.querySelector('.off')).toBeNull()
    expect(componentCalls).toBe(1) // Panel not re-invoked
  })

  it('an array child mixing static and reactive keeps order', () => {
    const [n, setN] = signal(1)
    const root = mount(() => h('div', null, ['a-', () => n(), '-b']))
    expect(root.textContent).toBe('a-1-b')
    setN(2)
    flushSync()
    expect(root.textContent).toBe('a-2-b')
  })

  it('a For row body with a nested reactive slot stays live after relocation', () => {
    // The row is materialized in a fragment then moved into the <ul>; its nested
    // reactive text slot must keep updating against the live parent.
    const [tick, setTick] = signal(0)
    const items = [{ id: 'only' }]
    const root = mount(() =>
      h(
        'ul',
        null,
        For({
          each: items,
          children: (item) => h('li', null, item.id, ':', () => tick()),
        }),
      ),
    )
    expect(root.querySelector('li')?.textContent).toBe('only:0')
    setTick(7)
    flushSync()
    expect(root.querySelector('li')?.textContent).toBe('only:7')
  })
})

describe('Suspense', () => {
  it('shows fallback while a pending resource is unsettled, then children', () => {
    // A child that registers pending state via the Suspense context, mimicking
    // what the router's createResource will do.
    let settle: () => void = () => {}
    const AsyncChild = () => {
      const s = useSuspense()
      s?.increment()
      // Simulate settling later via a captured decrement.
      settle = () => s?.decrement()
      return h('span', { class: 'loaded' }, 'data')
    }
    const root = mount(() =>
      Suspense({
        fallback: h('div', { class: 'spinner' }, 'loading'),
        children: (() => h(AsyncChild as any, null)) as any,
      }),
    )
    // Pending → fallback shown.
    flushSync()
    expect(root.querySelector('.spinner')).toBeTruthy()
    expect(root.querySelector('.loaded')).toBeNull()
    // Settle → children shown.
    settle()
    flushSync()
    expect(root.querySelector('.spinner')).toBeNull()
    expect(root.querySelector('.loaded')?.textContent).toBe('data')
  })
})

describe('context', () => {
  it('reads provided value and falls back to default', () => {
    const Ctx = createContext('default')
    let inner = ''
    let outer = ''
    const Consumer = () => {
      inner = useContext(Ctx)
      return h('span', null, inner)
    }
    const OutsideConsumer = () => {
      outer = useContext(Ctx)
      return h('em', null, outer)
    }
    mount(() =>
      h(
        'div',
        null,
        // Children passed lazily so the consumer evaluates INSIDE the provider
        // scope (mirrors the JSX compiler's lazy children).
        Ctx.Provider({ value: 'provided', children: (() => h(Consumer as any, null)) as any }),
        h(OutsideConsumer as any, null),
      ),
    )
    expect(inner).toBe('provided')
    expect(outer).toBe('default')
  })

  it('nested providers shadow', () => {
    const Ctx = createContext(0)
    let deep = -1
    const Deep = () => {
      deep = useContext(Ctx)
      return h('span', null, deep)
    }
    mount(() =>
      Ctx.Provider({
        value: 1,
        children: (() =>
          Ctx.Provider({ value: 2, children: (() => h(Deep as any, null)) as any })) as any,
      }),
    )
    expect(deep).toBe(2)
  })
})

describe('lifecycle', () => {
  it('onMount fires after insert', async () => {
    const order: string[] = []
    mount(() => {
      onMount(() => order.push('mounted'))
      order.push('render')
      return h('div', null, 'x')
    })
    expect(order).toEqual(['render']) // not yet
    await tick()
    expect(order).toEqual(['render', 'mounted'])
  })

  it('onCleanup runs on the render disposer', () => {
    const cleanup = vi.fn()
    const root = document.createElement('div')
    document.body.appendChild(root)
    const dispose = render(() => {
      onCleanup(cleanup)
      return h('div', null, 'x')
    }, root)
    expect(cleanup).not.toHaveBeenCalled()
    dispose()
    expect(cleanup).toHaveBeenCalledTimes(1)
    root.remove()
  })
})

describe('render disposer', () => {
  it('removes inserted nodes and leaves pre-existing children', () => {
    const root = document.createElement('div')
    root.appendChild(document.createTextNode('keep'))
    document.body.appendChild(root)
    const dispose = render(() => h('div', { id: 'inserted' }, 'x'), root)
    expect(root.querySelector('#inserted')).toBeTruthy()
    dispose()
    expect(root.querySelector('#inserted')).toBeNull()
    expect(root.textContent).toBe('keep')
    root.remove()
  })

  it('initial paint is synchronous', () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    const [c] = signal('sync')
    const dispose = render(() => h('div', null, () => c()), root)
    // No flushSync / tick — content is already there.
    expect(root.textContent).toBe('sync')
    dispose()
    root.remove()
  })
})
