import {
  compileSpecStream,
  parseSpecStreamLine,
  type Spec,
  type UIElement,
} from "@json-render/core"

/**
 * Turning a fence's text into something to render, with json-render's own
 * parser and compiler — plus the two guards an agent-written spec needs
 * before json-render 0.21 is safe to hand it.
 */

/** The fence is a spec when its first non-empty line is a patch: a fence
 *  labelled `spec` is also how RPM spec files are shown, and those stay
 *  code. */
export function isSpecStream(source: string): boolean {
  const first = source.split("\n").find((line) => line.trim() !== "")
  return first !== undefined && parseSpecStreamLine(first) !== null
}

/** json-render 0.21 writes patches with plain property assignment, so a path
 *  through `__proto__` writes into `Object.prototype` for the whole window.
 *  Such a line has no business in a UI spec: it is skipped. */
function reachesPrototype(line: string): boolean {
  const patch = parseSpecStreamLine(line)
  if (!patch) return false
  return [patch.path, patch.from].some(
    (pointer) => typeof pointer === "string" && pointer.includes("__proto__")
  )
}

/**
 * The spec so far. Lines that are not complete patches yet — the last one
 * while the reply streams — are skipped by json-render itself.
 *
 * The seed is json-render's own (`buildSpecFromParts` starts from the same):
 * until the first element arrives the spec has a root and no `elements`, and
 * the renderer reads `elements` unguarded. It is a fresh object per call
 * because compiling writes into it.
 */
export function compileSpec(source: string): Spec {
  const safe = source
    .split("\n")
    .filter((line) => !reachesPrototype(line))
    .join("\n")
  return compileSpecStream(safe, { root: "", elements: {} }) as Spec
}

const hasOwn = (object: object, key: string) =>
  Object.prototype.hasOwnProperty.call(object, key)

function childKeys(element: UIElement | null | undefined): unknown[] {
  if (!element || typeof element !== "object") return []
  const keys: unknown[] = Array.isArray(element.children)
    ? [...element.children]
    : []
  const slots: unknown = element.slots
  if (slots && typeof slots === "object") {
    for (const slot of Object.values(slots)) {
      if (Array.isArray(slot)) keys.push(...slot)
    }
  }
  return keys
}

/**
 * Whether an element is, through `children` or `slots`, its own descendant.
 * json-render renders such a spec without end — the window hangs until Codeg
 * restarts — so it is shown as code instead. Only what the root reaches
 * counts; an element nothing renders cannot hang anything.
 */
export function hasChildCycle(spec: Spec): boolean {
  const { root, elements } = spec
  if (!elements || typeof root !== "string" || !hasOwn(elements, root)) {
    return false
  }
  const done = new Set<string>()
  const onPath = new Set<string>([root])
  const stack = [{ key: root, children: childKeys(elements[root]), next: 0 }]
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]
    if (frame.next === frame.children.length) {
      stack.pop()
      onPath.delete(frame.key)
      done.add(frame.key)
      continue
    }
    // By index: a child list can hold `undefined` (a `replace` without a
    // value), which must not read as the end of the list.
    const child = frame.children[frame.next++]
    if (typeof child !== "string") continue
    if (onPath.has(child)) return true
    if (done.has(child) || !hasOwn(elements, child)) continue
    onPath.add(child)
    stack.push({ key: child, children: childKeys(elements[child]), next: 0 })
  }
  return false
}
