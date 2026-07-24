// <Link> — a client-side anchor. Renders a real `<a href>` (so it's a normal,
// right-clickable, middle-clickable, SEO-visible link) but intercepts a plain
// left-click on a same-origin target and routes it through `navigate` instead of
// a full page load. When the current route matches the link's target, it applies
// `activeClass` (in addition to `class`).

import { computed } from '../reactivity'
import type { CoyoteNode } from '../dom'
import { navigate, useRoute } from './router'

/** Should this click be handled by the router (vs. left to the browser)? */
function isPlainLeftClick(e: MouseEvent): boolean {
  return (
    e.button === 0 &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.shiftKey &&
    !e.altKey &&
    !e.defaultPrevented
  )
}

export function Link(props: {
  href: string
  replace?: boolean
  class?: string
  activeClass?: string
  children: unknown
}): CoyoteNode {
  const route = useRoute()

  // Resolve the target to an absolute pathname so active-matching is robust to
  // relative hrefs and to a leading origin.
  const targetPath = computed(() => {
    try {
      return new URL(props.href, window.location.origin).pathname
    } catch {
      return props.href
    }
  })

  const isActive = computed(() => route().path === targetPath() || route().fullPath === props.href)

  const className = computed(() => {
    const base = props.class ?? ''
    if (props.activeClass && isActive()) {
      return base ? `${base} ${props.activeClass}` : props.activeClass
    }
    return base
  })

  const onClick = (e: MouseEvent): void => {
    if (!isPlainLeftClick(e)) return
    // Same-origin only; leave cross-origin / target=_blank to the browser.
    let url: URL
    try {
      url = new URL(props.href, window.location.origin)
    } catch {
      return
    }
    if (url.origin !== window.location.origin) return
    e.preventDefault()
    navigate(props.href, { replace: props.replace })
  }

  return (
    <a href={props.href} class={className} onClick={onClick}>
      {props.children as CoyoteNode}
    </a>
  )
}
