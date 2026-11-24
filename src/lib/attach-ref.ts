import type { Ref } from "react"

/**
 * Point a caller-supplied ref at `node`; returns its detach.
 *
 * Exists because a component that needs the node itself (to publish as a portal
 * host, to measure, to lay something out against) still has to honour whatever
 * ref its caller passed. Returning the detach rather than calling the ref with
 * `null` later is what React 19 expects: a callback ref may return its own
 * cleanup, and when it does React runs that INSTEAD of re-invoking the ref with
 * `null`, so a composed ref has to hand its own cleanup back up the chain or
 * the caller's teardown silently replaces it.
 */
export function attachRef<T>(
  ref: Ref<T> | undefined,
  node: T | null
): () => void {
  if (typeof ref === "function") {
    const cleanup = ref(node)
    return typeof cleanup === "function" ? cleanup : () => ref(null)
  }
  if (ref) {
    ref.current = node
    return () => {
      ref.current = null
    }
  }
  return () => {}
}
