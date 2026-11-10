/**
 * Layout for component tests: jsdom lays nothing out — every element is 0
 * tall, and the ResizeObserver stub in `test-setup.ts` never reports.
 */

type Metric = "scrollHeight" | "clientHeight" | "scrollWidth" | "clientWidth"

/**
 * Lay out a clamped block: every element reads the given `scrollHeight` and
 * `clientHeight`, and a ResizeObserver reports each element as it starts
 * observing it, the way a browser reports a node at its first layout. Call
 * before rendering; returns the undo.
 */
export function mockClampLayout(
  scrollHeight: number,
  clientHeight: number
): () => void {
  return mockLayout({ scrollHeight, clientHeight })
}

/**
 * Lay out a one-line `truncate`d node: every element reads the given
 * `scrollWidth` and `clientWidth` — wider content than box cuts the text
 * short — and a ResizeObserver reports as in `mockClampLayout`.
 */
export function mockTruncateLayout(
  scrollWidth: number,
  clientWidth: number
): () => void {
  return mockLayout({ scrollWidth, clientWidth })
}

function mockLayout(metrics: Partial<Record<Metric, number>>): () => void {
  const props = Object.keys(metrics) as Metric[]
  const descriptors = props.map(
    (prop) =>
      [prop, Object.getOwnPropertyDescriptor(Element.prototype, prop)] as const
  )
  for (const prop of props) {
    Object.defineProperty(Element.prototype, prop, {
      configurable: true,
      get: () => metrics[prop],
    })
  }
  const InertResizeObserver = globalThis.ResizeObserver
  globalThis.ResizeObserver = class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.callback(
        [{ target } as ResizeObserverEntry],
        this as unknown as ResizeObserver
      )
    }
    unobserve() {}
    disconnect() {}
  }
  return () => {
    globalThis.ResizeObserver = InertResizeObserver
    for (const [prop, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(Element.prototype, prop, descriptor)
    }
  }
}
