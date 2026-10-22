/**
 * Shows the scrollbar while the pointer is at the edge of a scrolling area.
 *
 * The bar is invisible at rest (see theme.css). CSS cannot bring it back on
 * hover: WebKitGTK - the engine the desktop app runs on - ignores `:hover` on
 * every part of a scrollbar, measured by screenshotting the thumb under the
 * pointer. A class on <html> does repaint it, measured the same way, so the
 * pointer is what turns it on: find the scrolling box under the pointer and
 * raise the class while the pointer is within REVEAL_MARGIN of its right edge.
 */
const REVEAL_MARGIN = 24
const REVEALED_CLASS = 'scrollbar-revealed'

let frame = 0
let pending: { x: number; y: number } | null = null

function isAtScrollbar(x: number, y: number, from: Element | null): boolean {
  for (let node = from; node instanceof HTMLElement; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY
    // Only a box that scrolls and reserves a gutter has an edge to aim at.
    if (overflow !== 'auto' && overflow !== 'scroll') continue
    if (node.scrollHeight <= node.clientHeight) continue
    const gutter = node.offsetWidth - node.clientWidth
    if (gutter <= 0) continue
    const rect = node.getBoundingClientRect()
    if (y < rect.top || y > rect.bottom) continue
    if (x >= rect.right - gutter - REVEAL_MARGIN && x <= rect.right) return true
  }
  return false
}

function reveal(revealed: boolean): void {
  document.documentElement.classList.toggle(REVEALED_CLASS, revealed)
}

function onPointerMove(event: PointerEvent): void {
  if (event.pointerType !== 'mouse') return
  pending = { x: event.clientX, y: event.clientY }
  // One measurement per frame: pointermove fires far more often than the bar
  // can change, and `getComputedStyle` on the way up the tree is not free.
  if (frame !== 0) return
  frame = requestAnimationFrame(() => {
    frame = 0
    const point = pending
    pending = null
    if (!point) return
    const under = document.elementFromPoint(point.x, point.y)
    reveal(isAtScrollbar(point.x, point.y, under))
  })
}

export function watchScrollbarReveal(): void {
  // Captured, so a handler that stops propagation cannot leave the bar hidden.
  window.addEventListener('pointermove', onPointerMove, { capture: true, passive: true })
  document.documentElement.addEventListener('pointerleave', () => reveal(false))
}
